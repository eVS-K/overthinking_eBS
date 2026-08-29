'use strict';

/**
 * Private拡張用の純粋ゲーム状態遷移。
 *
 * 追加通常札・仮想Blankを含むPrivate設定を、既存クラシックとは別の
 * immutable stateとして扱う。UIやSocket.IOはここに入れず、複製札・
 * Blank・得点・終了判定を独立して検証できるようにする。
 */
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const {
  CLASSIC_PRIVATE_RULESET,
  EXPANDED_PRIVATE_RULESET_ID,
  MAX_PRIVATE_CARD_INSTANCES,
  MAX_PRIVATE_HAND_SIZE,
  MAX_PRIVATE_HISTORY_RECORDS,
  MAX_PRIVATE_INITIAL_CARDS_PER_SIDE,
  assertPrivateRuleset,
  createClassicPrivateRuleset,
  createExpandedPrivateRuleset
} = require('./private-ruleset');
const {
  clonePrivateCardInstance,
  createClassicPrivateCardInstances,
  createPrivateCardInstances,
  getClassicCardDefinition,
  getPrivateCardDefinition
} = require('./private-card-instances');
const { expandPrivateDeckEntries, normalizePrivateDeckEntries } = require('./private-deck');
const { resolvePrivateRoundWithContext } = require('./private-card-effects');
const {
  VIRTUAL_BLANK_SELECTION_ID,
  createVirtualBlankCard,
  isVirtualBlankCard,
  isVirtualBlankSelectionId
} = require('./private-blank');

const CLASSIC_DEFINITION_IDS = Object.freeze(CARD_DEFINITIONS.map((card) => card.id));

function recordedStrengthToUnits(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value * 2;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)\.5$/.test(value)) return null;
  const wholePart = Number(value.slice(0, -2));
  return Number.isSafeInteger(wholePart) ? wholePart * 2 + 1 : null;
}

function cloneHand(hand) {
  if (!Array.isArray(hand)) throw new TypeError('private hand must be an array');
  return hand.map(clonePrivateCardInstance);
}

function clonePlayedPrivateCard(card) {
  return isVirtualBlankCard(card) ? createVirtualBlankCard() : clonePrivateCardInstance(card);
}

function clonePrivateGameState(state) {
  assertPrivateGameState(state);
  return {
    rules: { ...state.rules },
    ...(state.deck ? { deck: state.deck.map((entry) => ({ ...entry })) } : {}),
    initialCardsPerSide: state.initialCardsPerSide,
    round: state.round,
    p1: { hand: cloneHand(state.p1.hand), score: state.p1.score },
    p2: { hand: cloneHand(state.p2.hand), score: state.p2.score },
    stack: cloneHand(state.stack),
    history: state.history.map((record) => ({
      ...record,
      p1Card: clonePlayedPrivateCard(record.p1Card),
      p2Card: clonePlayedPrivateCard(record.p2Card)
    }))
  };
}

function resolvePrivateRound(p1Card, p2Card) {
  return resolveRound(
    getPrivateCardDefinition(p1Card.definitionId),
    getPrivateCardDefinition(p2Card.definitionId)
  );
}

function assertCardIsAllowedByRuleset(card, ruleset) {
  if (isVirtualBlankCard(card)) {
    if (ruleset.ruleset !== EXPANDED_PRIVATE_RULESET_ID || ruleset.blankEnabled !== true) {
      throw new RangeError('virtual Blank is not enabled for this private ruleset');
    }
    return createVirtualBlankCard();
  }
  const normalized = clonePrivateCardInstance(card);
  if (ruleset.ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    getPrivateCardDefinition(normalized.definitionId);
  } else {
    // Do not let a forged extended definition alter the classic engine.
    getClassicCardDefinition(normalized.definitionId);
  }
  return normalized;
}

function getPrivateTerminalReasonUnchecked(state) {
  if (state.rules.scoreTarget !== null
    && (state.p1.score >= state.rules.scoreTarget || state.p2.score >= state.rules.scoreTarget)) {
    return 'score-target';
  }
  const playedRounds = state.history.length;
  if (playedRounds >= state.rules.roundLimit) return 'round-limit';
  if (state.p1.hand.length === 0 || state.p2.hand.length === 0) return 'hand-exhausted';
  return null;
}

function getPrivateTerminalReason(state) {
  assertPrivateGameState(state);
  return getPrivateTerminalReasonUnchecked(state);
}

function countDefinitionIds(cards) {
  const counts = new Map();
  for (const card of cards) {
    const normalized = clonePrivateCardInstance(card);
    counts.set(normalized.definitionId, (counts.get(normalized.definitionId) || 0) + 1);
  }
  return counts;
}

function matchesDeckSnapshot(cards, deck) {
  const counts = countDefinitionIds(cards);
  if (counts.size !== deck.length) return false;
  return deck.every((entry) => counts.get(entry.definitionId) === entry.copies);
}

function assertPrivateGameState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('private state must be an object');
  assertPrivateRuleset(state.rules);
  if (!Number.isSafeInteger(state.initialCardsPerSide)
    || state.initialCardsPerSide < 1
    || state.initialCardsPerSide > MAX_PRIVATE_INITIAL_CARDS_PER_SIDE
    || state.initialCardsPerSide > MAX_PRIVATE_HAND_SIZE
    || state.initialCardsPerSide * 2 > MAX_PRIVATE_CARD_INSTANCES) {
    throw new RangeError('invalid private initial card count');
  }
  if (state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    if (!Array.isArray(state.deck)) throw new TypeError('expanded private state requires a deck snapshot');
    const normalizedDeck = normalizePrivateDeckEntries(state.deck, state.rules);
    if (JSON.stringify(normalizedDeck) !== JSON.stringify(state.deck)) {
      throw new RangeError('expanded private deck snapshot is not normalized');
    }
    const totalDeckCards = normalizedDeck.reduce((total, entry) => total + entry.copies, 0);
    if (state.initialCardsPerSide !== totalDeckCards) {
      throw new RangeError('expanded private deck does not match initial card count');
    }
  } else if (state.deck !== undefined) {
    throw new RangeError('classic private state cannot carry an expanded deck snapshot');
  }
  if (!Number.isSafeInteger(state.round) || state.round < 1 || state.round > state.rules.roundLimit) {
    throw new RangeError('invalid private round');
  }
  for (const seat of ['p1', 'p2']) {
    const player = state[seat];
    if (!player || typeof player !== 'object' || !Array.isArray(player.hand) || !Number.isSafeInteger(player.score)) {
      throw new TypeError(`invalid private ${seat} state`);
    }
    if (player.score < 0 || player.hand.length > state.initialCardsPerSide) {
      throw new RangeError(`invalid private ${seat} cards or score`);
    }
  }
  if (!Array.isArray(state.stack)) {
    throw new TypeError('private stack must be an array');
  }
  if (state.rules.ruleset !== EXPANDED_PRIVATE_RULESET_ID
    && (state.p1.hand.length !== state.p2.hand.length || state.stack.length % 2 !== 0)) {
    throw new RangeError('classic private hands must be balanced and stack must be even');
  }
  if (!Array.isArray(state.history) || state.history.length > MAX_PRIVATE_HISTORY_RECORDS) {
    throw new RangeError('invalid private history');
  }

  const activeHandInstanceIds = new Set();
  for (const card of [...state.p1.hand, ...state.p2.hand]) {
    const normalized = assertCardIsAllowedByRuleset(card, state.rules);
    if (isVirtualBlankCard(normalized)) throw new RangeError('virtual Blank cannot be held in a hand');
    if (activeHandInstanceIds.has(normalized.instanceId)) throw new RangeError('duplicate private card instance');
    activeHandInstanceIds.add(normalized.instanceId);
  }
  const stackInstanceIds = new Set();
  for (const card of state.stack) {
    const normalized = assertCardIsAllowedByRuleset(card, state.rules);
    if (isVirtualBlankCard(normalized)) throw new RangeError('virtual Blank cannot enter the stack');
    if (activeHandInstanceIds.has(normalized.instanceId) || stackInstanceIds.has(normalized.instanceId)) {
      throw new RangeError('duplicate private card instance');
    }
    stackInstanceIds.add(normalized.instanceId);
  }
  let reconstructedP1Score = 0;
  let reconstructedP2Score = 0;
  let reconstructedStack = 0;
  const historicalInstanceIds = new Set();
  let unresolvedStackInstanceIds = new Set();
  for (let index = 0; index < state.history.length; index += 1) {
    const record = state.history[index];
    if (!record || typeof record !== 'object' || record.round !== index + 1) {
      throw new TypeError('invalid private history record');
    }
    const p1Card = assertCardIsAllowedByRuleset(record.p1Card, state.rules);
    const p2Card = assertCardIsAllowedByRuleset(record.p2Card, state.rules);
    for (const card of [p1Card, p2Card]) {
      if (isVirtualBlankCard(card)) continue;
      if (activeHandInstanceIds.has(card.instanceId) || historicalInstanceIds.has(card.instanceId)) {
        throw new RangeError('duplicate private card instance');
      }
      historicalInstanceIds.add(card.instanceId);
    }
    const historicalContext = {
      round: record.round,
      p1: { score: reconstructedP1Score },
      p2: { score: reconstructedP2Score },
      stack: Array.from({ length: reconstructedStack })
    };
    const resolution = resolvePrivateRoundWithContext(historicalContext, p1Card, p2Card);
    const canonicalResult = resolution.canonicalResult;
    if (record.canonicalResult !== canonicalResult) throw new RangeError('private history outcome does not match canonical rules');
    const hasStrengthSnapshot = record.p1Strength !== undefined || record.p2Strength !== undefined;
    if (hasStrengthSnapshot) {
      const p1StrengthUnits = recordedStrengthToUnits(record.p1Strength);
      const p2StrengthUnits = recordedStrengthToUnits(record.p2Strength);
      if (p1StrengthUnits === null
        || p2StrengthUnits === null
        || p1StrengthUnits !== resolution.p1.resolvedStrengthUnits
        || p2StrengthUnits !== resolution.p2.resolvedStrengthUnits) {
        throw new RangeError('private history strength does not match the round context');
      }
    }
    const expectedWinnerSeat = canonicalResult === 'p1' ? 'p1' : canonicalResult === 'p2' ? 'p2' : null;
    const physicalPlayedCards = [p1Card, p2Card].filter((card) => !isVirtualBlankCard(card));
    const expectedAwardedCards = expectedWinnerSeat ? physicalPlayedCards.length + reconstructedStack : 0;
    if (record.winnerSeat !== expectedWinnerSeat || record.awardedCards !== expectedAwardedCards) {
      throw new RangeError('private history award is inconsistent');
    }
    if (expectedWinnerSeat === 'p1') {
      reconstructedP1Score += expectedAwardedCards;
      reconstructedStack = 0;
    } else if (expectedWinnerSeat === 'p2') {
      reconstructedP2Score += expectedAwardedCards;
      reconstructedStack = 0;
    } else {
      reconstructedStack += physicalPlayedCards.length;
      for (const card of physicalPlayedCards) unresolvedStackInstanceIds.add(card.instanceId);
    }
    if (expectedWinnerSeat) unresolvedStackInstanceIds = new Set();
  }

  const p1PhysicalPlayed = state.initialCardsPerSide - state.p1.hand.length;
  const p2PhysicalPlayed = state.initialCardsPerSide - state.p2.hand.length;
  const playedPhysicalCards = p1PhysicalPlayed + p2PhysicalPlayed;
  const accountedCards = state.p1.score + state.p2.score + state.stack.length;
  if (accountedCards !== playedPhysicalCards
    || reconstructedP1Score !== state.p1.score
    || reconstructedP2Score !== state.p2.score
    || reconstructedStack !== state.stack.length
    || unresolvedStackInstanceIds.size !== stackInstanceIds.size
    || [...unresolvedStackInstanceIds].some((instanceId) => !stackInstanceIds.has(instanceId))) {
    throw new RangeError('private score and stack do not account for played cards');
  }
  if (state.rules.ruleset !== EXPANDED_PRIVATE_RULESET_ID
    && (p1PhysicalPlayed !== p2PhysicalPlayed || state.history.length !== p1PhysicalPlayed)) {
    throw new RangeError('classic private history must consume one card per side per round');
  }
  if (state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    const p1DeckCards = [
      ...state.p1.hand,
      ...state.history.map((record) => record.p1Card).filter((card) => !isVirtualBlankCard(card))
    ];
    const p2DeckCards = [
      ...state.p2.hand,
      ...state.history.map((record) => record.p2Card).filter((card) => !isVirtualBlankCard(card))
    ];
    if (!matchesDeckSnapshot(p1DeckCards, state.deck) || !matchesDeckSnapshot(p2DeckCards, state.deck)) {
      throw new RangeError('expanded private cards do not match the frozen deck snapshot');
    }
  }
  const terminal = getPrivateTerminalReasonUnchecked(state) !== null;
  const expectedRound = terminal ? state.history.length : state.history.length + 1;
  if (state.round !== expectedRound) throw new RangeError('private round does not match the game state');
  return state;
}

function createClassicPrivateGameState({ rules = CLASSIC_PRIVATE_RULESET, instanceNamespace = 'private' } = {}) {
  const snapshot = createClassicPrivateRuleset(rules);
  const p1Hand = createClassicPrivateCardInstances({
    namespace: instanceNamespace,
    seat: 'p1',
    definitionIds: CLASSIC_DEFINITION_IDS
  });
  const p2Hand = createClassicPrivateCardInstances({
    namespace: instanceNamespace,
    seat: 'p2',
    definitionIds: CLASSIC_DEFINITION_IDS
  });
  const state = {
    rules: snapshot,
    initialCardsPerSide: CLASSIC_DEFINITION_IDS.length,
    round: 1,
    p1: { hand: p1Hand, score: 0 },
    p2: { hand: p2Hand, score: 0 },
    stack: [],
    history: []
  };
  assertPrivateGameState(state);
  return state;
}

function createExpandedPrivateGameState({ rules, deck, instanceNamespace = 'private-expanded' } = {}) {
  const snapshot = createExpandedPrivateRuleset(rules);
  const normalizedDeck = normalizePrivateDeckEntries(deck, snapshot);
  const definitionIds = expandPrivateDeckEntries(normalizedDeck);
  const state = {
    rules: snapshot,
    deck: normalizedDeck,
    initialCardsPerSide: definitionIds.length,
    round: 1,
    p1: {
      hand: createPrivateCardInstances({ namespace: instanceNamespace, seat: 'p1', definitionIds }),
      score: 0
    },
    p2: {
      hand: createPrivateCardInstances({ namespace: instanceNamespace, seat: 'p2', definitionIds }),
      score: 0
    },
    stack: [],
    history: []
  };
  assertPrivateGameState(state);
  return state;
}

function isTerminalPrivateGameState(state) {
  assertPrivateGameState(state);
  return getPrivateTerminalReasonUnchecked(state) !== null;
}

function findLegalCardIndex(hand, instanceId) {
  if (typeof instanceId !== 'string') return -1;
  return hand.findIndex((card) => card.instanceId === instanceId && card.state.locked !== true);
}

function legalPrivateCardInstanceIds(state, seat) {
  assertPrivateGameState(state);
  if (seat !== 'p1' && seat !== 'p2') throw new RangeError('unknown private seat');
  const legalHandIds = state[seat].hand
    .filter((card) => card.state.locked !== true)
    .map((card) => card.instanceId);
  return state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID && state.rules.blankEnabled
    ? [...legalHandIds, VIRTUAL_BLANK_SELECTION_ID]
    : legalHandIds;
}

function privateMatchScore(state) {
  assertPrivateGameState(state);
  if (!isTerminalPrivateGameState(state)) throw new Error('private state is not terminal');
  if (state.p1.score > state.p2.score) return 1;
  if (state.p1.score < state.p2.score) return 0;
  return 0.5;
}

function applyPrivateRound(state, p1InstanceId, p2InstanceId) {
  assertPrivateGameState(state);
  if (isTerminalPrivateGameState(state)) throw new Error('cannot apply a private round to a terminal state');

  const p1IsVirtualBlank = isVirtualBlankSelectionId(p1InstanceId);
  const p2IsVirtualBlank = isVirtualBlankSelectionId(p2InstanceId);
  const p1Index = p1IsVirtualBlank ? -1 : findLegalCardIndex(state.p1.hand, p1InstanceId);
  const p2Index = p2IsVirtualBlank ? -1 : findLegalCardIndex(state.p2.hand, p2InstanceId);
  if ((p1IsVirtualBlank && !state.rules.blankEnabled)
    || (p2IsVirtualBlank && !state.rules.blankEnabled)
    || (!p1IsVirtualBlank && p1Index < 0)
    || (!p2IsVirtualBlank && p2Index < 0)) {
    throw new RangeError('selected private card is not legal');
  }

  const next = clonePrivateGameState(state);
  const p1Card = p1IsVirtualBlank ? createVirtualBlankCard() : next.p1.hand.splice(p1Index, 1)[0];
  const p2Card = p2IsVirtualBlank ? createVirtualBlankCard() : next.p2.hand.splice(p2Index, 1)[0];
  const resolution = resolvePrivateRoundWithContext(state, p1Card, p2Card);
  const canonicalResult = resolution.canonicalResult;
  const physicalPlayedCards = [p1Card, p2Card].filter((card) => !isVirtualBlankCard(card));
  const awardedCards = physicalPlayedCards.length + next.stack.length;
  let winnerSeat = null;
  if (canonicalResult === 'p1') {
    next.p1.score += awardedCards;
    next.stack = [];
    winnerSeat = 'p1';
  } else if (canonicalResult === 'p2') {
    next.p2.score += awardedCards;
    next.stack = [];
    winnerSeat = 'p2';
  } else {
    next.stack.push(...physicalPlayedCards);
  }

  const record = {
    round: state.round,
    p1Card: clonePlayedPrivateCard(p1Card),
    p2Card: clonePlayedPrivateCard(p2Card),
    canonicalResult,
    p1Strength: resolution.p1.resolvedStrength,
    p2Strength: resolution.p2.resolvedStrength,
    winnerSeat,
    awardedCards: winnerSeat ? awardedCards : 0
  };
  next.history = [...next.history, record].slice(-MAX_PRIVATE_HISTORY_RECORDS);
  const terminalReason = getPrivateTerminalReasonUnchecked(next);
  const terminal = terminalReason !== null;
  if (!terminal) next.round += 1;
  assertPrivateGameState(next);
  return {
    state: next,
    ...record,
    terminal,
    terminalReason,
    matchScore: terminal ? privateMatchScore(next) : null
  };
}

module.exports = {
  CLASSIC_DEFINITION_IDS,
  applyPrivateRound,
  assertPrivateGameState,
  clonePrivateGameState,
  createClassicPrivateGameState,
  createExpandedPrivateGameState,
  findLegalCardIndex,
  getPrivateTerminalReason,
  isTerminalPrivateGameState,
  legalPrivateCardInstanceIds,
  privateMatchScore,
  resolvePrivateRound
};
