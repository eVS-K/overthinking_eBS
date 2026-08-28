'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CARD_DEFINITIONS } = require('./game-rules');
const {
  CLASSIC_PRIVATE_RULESET,
  CLASSIC_PRIVATE_RULESET_ID,
  CLASSIC_ROUND_LIMIT,
  CLASSIC_SCORE_TARGET,
  EXPANDED_PRIVATE_RULESET_ID,
  MAX_PRIVATE_CARD_INSTANCES,
  assertClassicPrivateRuleset,
  assertPrivateExpansionLimits,
  createClassicPrivateRuleset,
  createExpandedPrivateRuleset,
  isSupportedPrivateTurnTimeLimit
} = require('./private-ruleset');

test('Privateクラシック preset は現行の7枚・9枚先取・90秒を正確に保つ', () => {
  const rules = createClassicPrivateRuleset();
  assert.notEqual(rules, CLASSIC_PRIVATE_RULESET);
  assert.equal(rules.ruleset, CLASSIC_PRIVATE_RULESET_ID);
  assert.equal(rules.turnTimeLimitMs, 90_000);
  assert.equal(rules.roundLimit, CARD_DEFINITIONS.length);
  assert.equal(rules.roundLimit, CLASSIC_ROUND_LIMIT);
  assert.equal(rules.scoreTarget, CLASSIC_SCORE_TARGET);
  assert.equal(rules.timeoutPolicy, 'random-legal');
  assert.doesNotThrow(() => assertClassicPrivateRuleset(rules));
});

test('Privateの制限時間は60/90/120秒だけを受理し、他の設定注入を受けない', () => {
  assert.equal(isSupportedPrivateTurnTimeLimit(60_000), true);
  assert.equal(isSupportedPrivateTurnTimeLimit(90_000), true);
  assert.equal(isSupportedPrivateTurnTimeLimit(120_000), true);
  assert.equal(isSupportedPrivateTurnTimeLimit(61_000), false);
  assert.equal(isSupportedPrivateTurnTimeLimit('120000'), false);

  const rules = createClassicPrivateRuleset({
    turnTimeLimitMs: 120_000,
    ruleset: 'forged',
    roundLimit: 99,
    scoreTarget: 1,
    timeoutPolicy: 'blank'
  });
  assert.equal(rules.ruleset, CLASSIC_PRIVATE_RULESET_ID);
  assert.equal(rules.turnTimeLimitMs, 120_000);
  assert.equal(rules.roundLimit, CLASSIC_ROUND_LIMIT);
  assert.equal(rules.scoreTarget, CLASSIC_SCORE_TARGET);
  assert.equal(rules.timeoutPolicy, 'random-legal');
  assert.throws(() => assertClassicPrivateRuleset({ ...rules, scoreTarget: 1 }), /immutable/);
});

test('将来の拡張設定にはカード数・ラウンド・履歴などの絶対上限を強制する', () => {
  assert.doesNotThrow(() => assertPrivateExpansionLimits({
    initialCardsPerSide: 7,
    maximumHandSize: 14,
    totalCardInstances: 28,
    roundLimit: 14,
    effectStepsPerRound: 12,
    historyLimit: 32,
    spectatorLimit: 8
  }));
  assert.throws(() => assertPrivateExpansionLimits({
    initialCardsPerSide: 7,
    maximumHandSize: 14,
    totalCardInstances: MAX_PRIVATE_CARD_INSTANCES + 1,
    roundLimit: 14,
    effectStepsPerRound: 12,
    historyLimit: 32,
    spectatorLimit: 8
  }), /totalCardInstances/);
});

test('Private拡張presetは総ラウンド・任意の即時勝利・タイムアウト方針を凍結する', () => {
  const rules = createExpandedPrivateRuleset({
    turnTimeLimitMs: 120_000,
    roundLimit: 10,
    scoreTarget: null,
    blankEnabled: true,
    forged: 'ignored'
  });
  assert.equal(rules.ruleset, EXPANDED_PRIVATE_RULESET_ID);
  assert.equal(rules.turnTimeLimitMs, 120_000);
  assert.equal(rules.roundLimit, 10);
  assert.equal(rules.scoreTarget, null);
  assert.equal(rules.blankEnabled, true);
  assert.equal(rules.timeoutPolicy, 'random-legal-with-blank');
  assert.throws(() => createExpandedPrivateRuleset({ roundLimit: 0 }), /round limit/);
  assert.throws(() => createExpandedPrivateRuleset({ scoreTarget: -1 }), /score target/);
  assert.equal(createExpandedPrivateRuleset({ timeoutPolicy: 'forged' }).timeoutPolicy, 'random-legal');
});
