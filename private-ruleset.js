'use strict';

/**
 * Private PvP の拡張用設定境界。
 *
 * ここは将来の拡張カード用の土台であり、game-rules.js のクラシック
 * ルールを置き換えない。クラシックでは60 / 90 / 120秒の制限時間、
 * 拡張Privateでは凍結済みのデッキ・終了条件・仮想Blankを扱う。
 */
const { CARD_DEFINITIONS } = require('./game-rules');

const PRIVATE_RULESET_VERSION = 'private-rules-v1';
const CLASSIC_PRIVATE_RULESET_ID = 'classic-v1';
const EXPANDED_PRIVATE_RULESET_ID = 'private-expanded-v1';
const CLASSIC_ROUND_LIMIT = CARD_DEFINITIONS.length;
const CLASSIC_SCORE_TARGET = 9;
const PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS = Object.freeze([60_000, 90_000, 120_000]);
const PRIVATE_TURN_TIME_LIMIT_OPTION_SET = new Set(PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS);
const EXPANDED_TIMEOUT_POLICIES = Object.freeze([
  'random-legal',
  'random-legal-with-blank'
]);
const EXPANDED_TIMEOUT_POLICY_SET = new Set(EXPANDED_TIMEOUT_POLICIES);
// Features are server-owned preset capabilities.  Deck payloads can name a
// card definition and copy count only; they cannot turn on unimplemented
// mechanics themselves.
const EXPANDED_PRIVATE_FEATURES = Object.freeze([
  'public-cards-v1',
  'conditional-strength-v1'
]);

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

// Blank is a reusable virtual card, not a deck entry.  When enabled it can be
// selected deliberately and is included in server-side timeout selection.
// The exact timeout policy is derived from this boolean so a client cannot
// claim a display rule the game engine did not apply.
const EXPANDED_PRIVATE_RULESET = Object.freeze({
  ruleset: EXPANDED_PRIVATE_RULESET_ID,
  turnTimeLimitMs: 90_000,
  roundLimit: CLASSIC_ROUND_LIMIT,
  scoreTarget: CLASSIC_SCORE_TARGET,
  blankEnabled: false,
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

function isSupportedExpandedTimeoutPolicy(value) {
  return typeof value === 'string' && EXPANDED_TIMEOUT_POLICY_SET.has(value);
}

function normalizeExpandedScoreTarget(value) {
  // A room may deliberately disable early victory and decide the match only
  // after its configured total round count.  `null`, not a magic number,
  // represents that choice in a frozen rules snapshot.
  if (value === null) return null;
  return Number.isSafeInteger(value) ? value : EXPANDED_PRIVATE_RULESET.scoreTarget;
}

function createExpandedPrivateRuleset(settings = {}) {
  const turnTimeLimitMs = isSupportedPrivateTurnTimeLimit(settings?.turnTimeLimitMs)
    ? settings.turnTimeLimitMs
    : EXPANDED_PRIVATE_RULESET.turnTimeLimitMs;
  const roundLimit = Number.isSafeInteger(settings?.roundLimit)
    ? settings.roundLimit
    : EXPANDED_PRIVATE_RULESET.roundLimit;
  const scoreTarget = normalizeExpandedScoreTarget(settings?.scoreTarget);
  const blankEnabled = settings?.blankEnabled === true;
  const timeoutPolicy = blankEnabled ? 'random-legal-with-blank' : 'random-legal';
  const ruleset = {
    ruleset: EXPANDED_PRIVATE_RULESET_ID,
    turnTimeLimitMs,
    roundLimit,
    scoreTarget,
    blankEnabled,
    timeoutPolicy
  };
  assertExpandedPrivateRuleset(ruleset);
  return ruleset;
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

function assertExpandedPrivateRuleset(ruleset) {
  if (!ruleset || typeof ruleset !== 'object' || Array.isArray(ruleset)) {
    throw new TypeError('private ruleset must be an object');
  }
  if (ruleset.ruleset !== EXPANDED_PRIVATE_RULESET_ID) {
    throw new RangeError('unsupported private expanded ruleset');
  }
  if (!isSupportedPrivateTurnTimeLimit(ruleset.turnTimeLimitMs)) {
    throw new RangeError('unsupported private turn time limit');
  }
  if (!Number.isSafeInteger(ruleset.roundLimit) || ruleset.roundLimit < 1 || ruleset.roundLimit > MAX_PRIVATE_ROUNDS) {
    throw new RangeError('expanded private round limit is outside the supported range');
  }
  if (ruleset.scoreTarget !== null
    && (!Number.isSafeInteger(ruleset.scoreTarget) || ruleset.scoreTarget < 1 || ruleset.scoreTarget > MAX_PRIVATE_CARD_INSTANCES)) {
    throw new RangeError('expanded private score target is outside the supported range');
  }
  if (typeof ruleset.blankEnabled !== 'boolean') {
    throw new RangeError('expanded private blank setting must be boolean');
  }
  const expectedTimeoutPolicy = ruleset.blankEnabled ? 'random-legal-with-blank' : 'random-legal';
  if (ruleset.timeoutPolicy !== expectedTimeoutPolicy) {
    throw new RangeError('expanded private timeout policy must match the blank setting');
  }
  if (!isSupportedExpandedTimeoutPolicy(ruleset.timeoutPolicy)) {
    throw new RangeError('unsupported expanded private timeout policy');
  }
  return ruleset;
}

function assertPrivateRuleset(ruleset) {
  if (ruleset?.ruleset === CLASSIC_PRIVATE_RULESET_ID) return assertClassicPrivateRuleset(ruleset);
  if (ruleset?.ruleset === EXPANDED_PRIVATE_RULESET_ID) return assertExpandedPrivateRuleset(ruleset);
  throw new RangeError('unsupported private ruleset');
}

function getPrivateRulesetFeatures(ruleset) {
  assertPrivateRuleset(ruleset);
  return ruleset.ruleset === EXPANDED_PRIVATE_RULESET_ID ? EXPANDED_PRIVATE_FEATURES : Object.freeze([]);
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
  EXPANDED_PRIVATE_FEATURES,
  EXPANDED_PRIVATE_RULESET,
  EXPANDED_PRIVATE_RULESET_ID,
  EXPANDED_TIMEOUT_POLICIES,
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
  assertExpandedPrivateRuleset,
  assertPrivateExpansionLimits,
  assertPrivateRuleset,
  createClassicPrivateRuleset,
  createExpandedPrivateRuleset,
  getPrivateRulesetFeatures,
  isSupportedExpandedTimeoutPolicy,
  isSupportedPrivateTurnTimeLimit
};
