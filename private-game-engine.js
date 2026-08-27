'use strict';

/**
 * Private拡張用の純粋ゲーム状態遷移。
 *
 * 現段階ではクラシック preset を instanceId 化して再現するだけで、
 * server.js の現行対局フローへはまだ接続しない。これにより追加カード
 * やTarotを実装する前に、複製札・不変条件・終了判定を独立して検証できる。
 */
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const {
  CLASSIC_PRIVATE_RULESET,
  MAX_PRIVATE_CARD_INSTANCES,
  MAX_PRIVATE_HAND_SIZE,
  MAX_PRIVATE_HISTORY_RECORDS,
  MAX_PRIVATE_INITIAL_CARDS_PER_SIDE,
  assertClassicPrivateRuleset,
  createClassicPrivateRuleset
} = require('./private-ruleset');
const {
  clonePrivateCardInstance,
  createClassicPrivateCardInstances,
  getClassicCardDefinition
} = require('./private-card-instances');

const CLASSIC_DEFINITION_IDS = Object.freeze(CARD_DEFINITIONS.map((card) => card.id));

function cloneHand(hand) {
  if (!Array.isArray(hand)) throw new TypeError('private hand must be an array');
  return hand.map(clonePrivateCardInstance);
}

function clonePrivateGameState(state) {
  assertPrivateGameState(state);
  return {
    rules: { ...state.rules },
    initialCardsPerSide: state.initialCardsPerSide,
    round: state.round,
    p1: { hand: cloneHand(state.p1.hand), score: state.p1.score },
    p2: { hand: cloneHand(state.p2.hand), score: state.p2.score },
    stack: cloneHand(state.stack),
    history: state.history.map((record) => ({
      ...record,
      p1Card: clonePrivateCardInstance(record.p1Card),
      p2Card: clonePrivateCardInstance(record.p2Card)
    }))
  };
}

function assertPrivateGameState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('private state must be an object');
  assertClassicPrivateRuleset(state.rules);
  if (!Number.isSafeInteger(state.initialCardsPerSide)
    || state.initialCardsPerSide < 1
    || state.initialCardsPerSide > MAX_PRIVATE_INITIAL_CARDS_PER_SIDE
    || state.initialCardsPerSide > MAX_PRIVATE_HAND_SIZE
    || state.initialCardsPerSide * 2 > MAX_PRIVATE_CARD_INSTANCES
    || state.initialCardsPerSide > state.rules.roundLimit) {
    throw new RangeError('invalid private initial card count');
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
  if (state.p1.hand.length !== state.p2.hand.length || !Array.isArray(state.stack) || state.stack.length % 2 !== 0) {
    throw new RangeError('private hands must be balanced and stack must be even');
  }
  if (!Array.isArray(state.history) || state.history.length > MAX_PRIVATE_HISTORY_RECORDS) {
    throw new RangeError('invalid private history');
  }

  const activeHandInstanceIds = new Set();
  for (const card of [...state.p1.hand, ...state.p2.hand]) {
    const normalized = clonePrivateCardInstance(card);
    if (activeHandInstanceIds.has(normalized.instanceId)) throw new RangeError('duplicate private card instance');
    activeHandInstanceIds.add(normalized.instanceId);
  }
  const stackInstanceIds = new Set();
  for (const card of state.stack) {
    const normalized = clonePrivateCardInstance(card);
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
    const p1Card = clonePrivateCardInstance(record.p1Card);
    const p2Card = clonePrivateCardInstance(record.p2Card);
    for (const card of [p1Card, p2Card]) {
      if (activeHandInstanceIds.has(card.instanceId) || historicalInstanceIds.has(card.instanceId)) {
        throw new RangeError('duplicate private card instance');
      }
      historicalInstanceIds.add(card.instanceId);
    }
    const canonicalResult = resolveRound(
      getClassicCardDefinition(p1Card.definitionId),
      getClassicCardDefinition(p2Card.definitionId)
    );
    if (record.canonicalResult !== canonicalResult) throw new RangeError('private history outcome does not match canonical rules');
    const expectedWinnerSeat = canonicalResult === 'p1' ? 'p1' : canonicalResult === 'p2' ? 'p2' : null;
    const expectedAwardedCards = expectedWinnerSeat ? 2 + reconstructedStack : 0;
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
      reconstructedStack += 2;
      unresolvedStackInstanceIds.add(p1Card.instanceId);
      unresolvedStackInstanceIds.add(p2Card.instanceId);
    }
    if (expectedWinnerSeat) unresolvedStackInstanceIds = new Set();
  }

  const playedPerSide = state.initialCardsPerSide - state.p1.hand.length;
  const accountedCards = state.p1.score + state.p2.score + state.stack.length;
  if (accountedCards !== playedPerSide * 2
    || state.history.length !== playedPerSide
    || reconstructedP1Score !== state.p1.score
    || reconstructedP2Score !== state.p2.score
    || reconstructedStack !== state.stack.length
    || unresolvedStackInstanceIds.size !== stackInstanceIds.size
    || [...unresolvedStackInstanceIds].some((instanceId) => !stackInstanceIds.has(instanceId))) {
    throw new RangeError('private score and stack do not account for played cards');
  }
  const terminal = state.p1.score >= state.rules.scoreTarget
    || state.p2.score >= state.rules.scoreTarget
    || state.p1.hand.length === 0;
  const expectedRound = terminal ? playedPerSide : playedPerSide + 1;
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

function isTerminalPrivateGameState(state) {
  assertPrivateGameState(state);
  return state.p1.score >= state.rules.scoreTarget
    || state.p2.score >= state.rules.scoreTarget
    || state.p1.hand.length === 0;
}

function findLegalCardIndex(hand, instanceId) {
  if (typeof instanceId !== 'string') return -1;
  return hand.findIndex((card) => card.instanceId === instanceId && card.state.locked !== true);
}

function legalPrivateCardInstanceIds(state, seat) {
  assertPrivateGameState(state);
  if (seat !== 'p1' && seat !== 'p2') throw new RangeError('unknown private seat');
  return state[seat].hand
    .filter((card) => card.state.locked !== true)
    .map((card) => card.instanceId);
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

  const p1Index = findLegalCardIndex(state.p1.hand, p1InstanceId);
  const p2Index = findLegalCardIndex(state.p2.hand, p2InstanceId);
  if (p1Index < 0 || p2Index < 0) throw new RangeError('selected private card is not legal');

  const next = clonePrivateGameState(state);
  const [p1Card] = next.p1.hand.splice(p1Index, 1);
  const [p2Card] = next.p2.hand.splice(p2Index, 1);
  const canonicalResult = resolveRound(
    getClassicCardDefinition(p1Card.definitionId),
    getClassicCardDefinition(p2Card.definitionId)
  );
  const awardedCards = 2 + next.stack.length;
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
    next.stack.push(p1Card, p2Card);
  }

  const record = {
    round: state.round,
    p1Card: clonePrivateCardInstance(p1Card),
    p2Card: clonePrivateCardInstance(p2Card),
    canonicalResult,
    winnerSeat,
    awardedCards: winnerSeat ? awardedCards : 0
  };
  next.history = [...next.history, record].slice(-MAX_PRIVATE_HISTORY_RECORDS);
  const terminal = next.p1.score >= next.rules.scoreTarget
    || next.p2.score >= next.rules.scoreTarget
    || next.p1.hand.length === 0;
  if (!terminal) next.round += 1;
  assertPrivateGameState(next);
  return {
    state: next,
    ...record,
    terminal,
    matchScore: terminal ? privateMatchScore(next) : null
  };
}

module.exports = {
  CLASSIC_DEFINITION_IDS,
  applyPrivateRound,
  assertPrivateGameState,
  clonePrivateGameState,
  createClassicPrivateGameState,
  findLegalCardIndex,
  isTerminalPrivateGameState,
  legalPrivateCardInstanceIds,
  privateMatchScore
};
