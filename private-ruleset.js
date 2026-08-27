'use strict';

/**
 * Private PvP の拡張用設定境界。
 *
 * ここは将来の拡張カード用の土台であり、game-rules.js のクラシック
 * ルールを置き換えない。現段階で選べるのは既存ルールと
 * 60 / 90 / 120 秒の制限時間だけである。
 */
const { CARD_DEFINITIONS } = require('./game-rules');

const PRIVATE_RULESET_VERSION = 'private-rules-v1';
const CLASSIC_PRIVATE_RULESET_ID = 'classic-v1';
const CLASSIC_ROUND_LIMIT = CARD_DEFINITIONS.length;
const CLASSIC_SCORE_TARGET = 9;
const PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS = Object.freeze([60_000, 90_000, 120_000]);
const PRIVATE_TURN_TIME_LIMIT_OPTION_SET = new Set(PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS);

// Expansion work must remain bounded before it is ever connected to a room.
// These are intentionally conservative hard limits, not client-configurable
// values. The current classic preset is far below every cap.
const MAX_PRIVATE_INITIAL_CARDS_PER_SIDE = 14;
const MAX_PRIVATE_HAND_SIZE = 24;
const MAX_PRIVATE_CARD_INSTANCES = 64;
const MAX_PRIVATE_ROUNDS = 20;
const MAX_PRIVATE_EFFECT_STEPS_PER_ROUND = 24;
const MAX_PRIVATE_HISTORY_RECORDS = 64;
const MAX_PRIVATE_EXPANSION_SPECTATORS = 16;

const CLASSIC_PRIVATE_RULESET = Object.freeze({
  ruleset: CLASSIC_PRIVATE_RULESET_ID,
  turnTimeLimitMs: 90_000,
  roundLimit: CLASSIC_ROUND_LIMIT,
  scoreTarget: CLASSIC_SCORE_TARGET,
  timeoutPolicy: 'random-legal'
});

function isSupportedPrivateTurnTimeLimit(value) {
  return Number.isSafeInteger(value) && PRIVATE_TURN_TIME_LIMIT_OPTION_SET.has(value);
}

function createClassicPrivateRuleset(settings = {}) {
  const turnTimeLimitMs = isSupportedPrivateTurnTimeLimit(settings?.turnTimeLimitMs)
    ? settings.turnTimeLimitMs
    : CLASSIC_PRIVATE_RULESET.turnTimeLimitMs;
  // Do not accept client-selected rule/deck/score/effect fields. They become
  // selectable only after the corresponding private engine is implemented and
  // audited as a complete preset.
  return {
    ...CLASSIC_PRIVATE_RULESET,
    turnTimeLimitMs
  };
}

function assertClassicPrivateRuleset(ruleset) {
  if (!ruleset || typeof ruleset !== 'object' || Array.isArray(ruleset)) {
    throw new TypeError('private ruleset must be an object');
  }
  if (ruleset.ruleset !== CLASSIC_PRIVATE_RULESET_ID) {
    throw new RangeError('unsupported private ruleset');
  }
  if (!isSupportedPrivateTurnTimeLimit(ruleset.turnTimeLimitMs)) {
    throw new RangeError('unsupported private turn time limit');
  }
  if (ruleset.roundLimit !== CLASSIC_ROUND_LIMIT || ruleset.scoreTarget !== CLASSIC_SCORE_TARGET) {
    throw new RangeError('classic private end conditions are immutable');
  }
  if (ruleset.timeoutPolicy !== 'random-legal') {
    throw new RangeError('classic private timeout policy is immutable');
  }
  return ruleset;
}

function assertPrivateExpansionLimits({
  initialCardsPerSide,
  maximumHandSize,
  totalCardInstances,
  roundLimit,
  effectStepsPerRound,
  historyLimit,
  spectatorLimit
} = {}) {
  const boundedValues = [
    ['initialCardsPerSide', initialCardsPerSide, 1, MAX_PRIVATE_INITIAL_CARDS_PER_SIDE],
    ['maximumHandSize', maximumHandSize, 1, MAX_PRIVATE_HAND_SIZE],
    ['totalCardInstances', totalCardInstances, 2, MAX_PRIVATE_CARD_INSTANCES],
    ['roundLimit', roundLimit, 1, MAX_PRIVATE_ROUNDS],
    ['effectStepsPerRound', effectStepsPerRound, 1, MAX_PRIVATE_EFFECT_STEPS_PER_ROUND],
    ['historyLimit', historyLimit, 1, MAX_PRIVATE_HISTORY_RECORDS],
    ['spectatorLimit', spectatorLimit, 0, MAX_PRIVATE_EXPANSION_SPECTATORS]
  ];
  for (const [name, value, minimum, maximum] of boundedValues) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} is outside the private expansion limit`);
    }
  }
  if (maximumHandSize < initialCardsPerSide) {
    throw new RangeError('maximumHandSize cannot be lower than initialCardsPerSide');
  }
  if (totalCardInstances < initialCardsPerSide * 2) {
    throw new RangeError('totalCardInstances cannot be lower than both initial hands');
  }
  return true;
}

module.exports = {
  CLASSIC_PRIVATE_RULESET,
  CLASSIC_PRIVATE_RULESET_ID,
  CLASSIC_ROUND_LIMIT,
  CLASSIC_SCORE_TARGET,
  MAX_PRIVATE_CARD_INSTANCES,
  MAX_PRIVATE_EFFECT_STEPS_PER_ROUND,
  MAX_PRIVATE_EXPANSION_SPECTATORS,
  MAX_PRIVATE_HAND_SIZE,
  MAX_PRIVATE_HISTORY_RECORDS,
  MAX_PRIVATE_INITIAL_CARDS_PER_SIDE,
  MAX_PRIVATE_ROUNDS,
  PRIVATE_RULESET_VERSION,
  PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS,
  assertClassicPrivateRuleset,
  assertPrivateExpansionLimits,
  createClassicPrivateRuleset,
  isSupportedPrivateTurnTimeLimit
};
