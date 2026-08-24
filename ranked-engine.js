'use strict';

/**
 * Ranked Random 用の純粋な状態遷移。
 *
 * PvP の勝敗規則を複製せず、必ず game-rules.js の resolveRound() を通す。
 * hand は CARD_DEFINITIONS の並び順に対応する 7-bit mask で表す。
 */
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');

const RANKED_RULES_VERSION = 'overthinking-rules-v1';
const INITIAL_HAND_SIZE = CARD_DEFINITIONS.length;
const FULL_HAND_MASK = (1 << INITIAL_HAND_SIZE) - 1;
const CARD_IDS = Object.freeze(CARD_DEFINITIONS.map((card) => card.id));
const CARD_INDEX_BY_ID = new Map(CARD_IDS.map((id, index) => [id, index]));

function popcount(mask) {
  let value = mask >>> 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

function cardIndexFromId(cardId) {
  return typeof cardId === 'string' ? CARD_INDEX_BY_ID.get(cardId) : undefined;
}

function cardIdFromIndex(index) {
  return CARD_IDS[index];
}

function cardFromIndex(index) {
  const card = CARD_DEFINITIONS[index];
  if (!card) throw new RangeError('unknown card index');
  return card;
}

function cardBit(card) {
  const index = typeof card === 'number' ? card : cardIndexFromId(card);
  if (!Number.isInteger(index) || index < 0 || index >= INITIAL_HAND_SIZE) {
    throw new RangeError('unknown card');
  }
  return 1 << index;
}

function getLegalCardIndices(mask) {
  const result = [];
  for (let index = 0; index < INITIAL_HAND_SIZE; index += 1) {
    if (mask & (1 << index)) result.push(index);
  }
  return result;
}

function getLegalCardIds(mask) {
  return getLegalCardIndices(mask).map(cardIdFromIndex);
}

function createInitialRankedState() {
  return {
    playerMask: FULL_HAND_MASK,
    aiMask: FULL_HAND_MASK,
    playerScore: 0,
    aiScore: 0,
    stackCount: 0
  };
}

function assertRankedState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('state must be an object');
  const fields = ['playerMask', 'aiMask', 'playerScore', 'aiScore', 'stackCount'];
  for (const field of fields) {
    if (!Number.isSafeInteger(state[field])) throw new TypeError(`state.${field} must be an integer`);
  }
  if (state.playerMask < 0 || state.aiMask < 0
    || state.playerMask > FULL_HAND_MASK || state.aiMask > FULL_HAND_MASK) {
    throw new RangeError('hand mask is outside the canonical deck');
  }
  if (popcount(state.playerMask) !== popcount(state.aiMask)) {
    throw new RangeError('both players must have the same number of cards');
  }
  if (state.playerScore < 0 || state.aiScore < 0 || state.stackCount < 0 || state.stackCount % 2 !== 0) {
    throw new RangeError('score and stack must be non-negative; stack must be even');
  }
  const cardsPlayed = 2 * (INITIAL_HAND_SIZE - popcount(state.playerMask));
  if (state.playerScore + state.aiScore + state.stackCount !== cardsPlayed) {
    throw new RangeError('score and stack do not account for every played card');
  }
  return state;
}

function cloneRankedState(state) {
  assertRankedState(state);
  return {
    playerMask: state.playerMask,
    aiMask: state.aiMask,
    playerScore: state.playerScore,
    aiScore: state.aiScore,
    stackCount: state.stackCount
  };
}

function stateKey(state) {
  assertRankedState(state);
  return `${state.playerMask}.${state.aiMask}.${state.playerScore}.${state.aiScore}.${state.stackCount}`;
}

function stateFromKey(key) {
  if (typeof key !== 'string') throw new TypeError('state key must be a string');
  const parts = key.split('.');
  if (parts.length !== 5 || parts.some((part) => !/^\d+$/.test(part))) throw new TypeError('invalid state key');
  const state = {
    playerMask: Number(parts[0]),
    aiMask: Number(parts[1]),
    playerScore: Number(parts[2]),
    aiScore: Number(parts[3]),
    stackCount: Number(parts[4])
  };
  return cloneRankedState(state);
}

function getCurrentRound(state) {
  assertRankedState(state);
  return INITIAL_HAND_SIZE - popcount(state.playerMask) + 1;
}

function isTerminalState(state) {
  assertRankedState(state);
  return state.playerScore > 8 || state.aiScore > 8 || state.playerMask === 0;
}

function terminalMatchScore(state) {
  assertRankedState(state);
  if (!isTerminalState(state)) throw new Error('state is not terminal');
  if (state.playerScore > state.aiScore) return 1;
  if (state.playerScore < state.aiScore) return 0;
  return 0.5;
}

function normalizeCardIndex(card) {
  const index = typeof card === 'number' ? card : cardIndexFromId(card);
  if (!Number.isInteger(index) || index < 0 || index >= INITIAL_HAND_SIZE) {
    throw new RangeError('unknown card');
  }
  return index;
}

/**
 * A single simultaneous round. This function is intentionally side-effect free.
 */
function applyRound(state, playerCard, aiCard) {
  assertRankedState(state);
  if (isTerminalState(state)) throw new Error('cannot apply a round to a terminal state');

  const playerCardIndex = normalizeCardIndex(playerCard);
  const aiCardIndex = normalizeCardIndex(aiCard);
  const playerBit = cardBit(playerCardIndex);
  const aiBit = cardBit(aiCardIndex);
  if (!(state.playerMask & playerBit) || !(state.aiMask & aiBit)) {
    throw new RangeError('selected card is not in the corresponding hand');
  }

  const playerCardDefinition = cardFromIndex(playerCardIndex);
  const aiCardDefinition = cardFromIndex(aiCardIndex);
  const canonicalResult = resolveRound(playerCardDefinition, aiCardDefinition);
  const awardedCards = 2 + state.stackCount;
  const nextState = {
    playerMask: state.playerMask & ~playerBit,
    aiMask: state.aiMask & ~aiBit,
    playerScore: state.playerScore,
    aiScore: state.aiScore,
    stackCount: state.stackCount
  };

  let winner = 'draw';
  if (canonicalResult === 'p1') {
    nextState.playerScore += awardedCards;
    nextState.stackCount = 0;
    winner = 'player';
  } else if (canonicalResult === 'p2') {
    nextState.aiScore += awardedCards;
    nextState.stackCount = 0;
    winner = 'ai';
  } else {
    nextState.stackCount += 2;
  }

  assertRankedState(nextState);
  return {
    state: nextState,
    playerCardIndex,
    aiCardIndex,
    playerCardId: playerCardDefinition.id,
    aiCardId: aiCardDefinition.id,
    canonicalResult,
    winner,
    awardedCards: canonicalResult === 'draw' ? 0 : awardedCards,
    terminal: isTerminalState(nextState),
    matchScore: isTerminalState(nextState) ? terminalMatchScore(nextState) : null
  };
}

module.exports = {
  RANKED_RULES_VERSION,
  INITIAL_HAND_SIZE,
  FULL_HAND_MASK,
  CARD_IDS,
  CARD_INDEX_BY_ID,
  applyRound,
  assertRankedState,
  cardBit,
  cardFromIndex,
  cardIdFromIndex,
  cardIndexFromId,
  cloneRankedState,
  createInitialRankedState,
  getCurrentRound,
  getLegalCardIds,
  getLegalCardIndices,
  isTerminalState,
  popcount,
  stateFromKey,
  stateKey,
  terminalMatchScore
};
