'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  INITIAL_DECISION_EV,
  PERFECT_PLAY_RATING,
  RANDOM_LEVEL_RATING,
  LEADERBOARD_ELIGIBILITY_GAMES,
  RATING_LAMBDA,
  calculateRating,
  clampDecisionPerformance,
  createEmptyRatingProfile,
  effectiveSampleSize,
  isEligibleForLeaderboard,
  standardError,
  updateRatingProfile
} = require('./rating');
const { applyRound, createInitialRankedState, getLegalCardIds, isTerminalState } = require('./ranked-engine');
const { INITIAL_VALUE_SCALED, scaledToNumber } = require('./ranked-service');
const { RankedValueLookup, createSignedRankedValueTable } = require('./ranked-values');

test('rating lambda はhalf-life 50 gamesの定義と一致する', () => {
  assert.equal(RATING_LAMBDA, 2 ** (-1 / 50));
  assert.ok(Math.abs(RATING_LAMBDA - 0.9862327044933592) < 1e-15);
});

test('random baselineは1000、perfect decisionは1500へ写像される', () => {
  assert.equal(calculateRating(0.5), RANDOM_LEVEL_RATING);
  assert.equal(calculateRating(INITIAL_DECISION_EV), PERFECT_PLAY_RATING);
});

test('perfect strategyの有効平均は理論上限を超えない', () => {
  let profile = createEmptyRatingProfile();
  for (let index = 0; index < 200; index += 1) {
    profile = updateRatingProfile(profile, { decisionPerformance: INITIAL_DECISION_EV, matchScore: 1 });
  }
  assert.equal(profile.rating, PERFECT_PLAY_RATING);
  assert.ok(profile.rating <= PERFECT_PLAY_RATING);
});

test('forfeitはrated game数とloss/forfeitへ一度ずつ反映される', () => {
  const profile = updateRatingProfile(createEmptyRatingProfile(), {
    decisionPerformance: 0,
    matchScore: 0,
    forfeit: true
  });
  assert.deepEqual({ games: profile.ratedGames, losses: profile.losses, forfeits: profile.forfeits }, { games: 1, losses: 1, forfeits: 1 });
  assert.equal(LEADERBOARD_ELIGIBILITY_GAMES, 10);
  assert.equal(isEligibleForLeaderboard({ ratedGames: 9 }), false);
  assert.equal(isEligibleForLeaderboard({ ratedGames: 10 }), true);
});

test('一様random strategyのDecision Performance期待値は1000近傍へ写像される', () => {
  const lookup = new RankedValueLookup(createSignedRankedValueTable());
  let randomState = 0x12345678;
  const random = () => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 2 ** 32;
  };
  let total = 0;
  const games = 2_000;
  for (let game = 0; game < games; game += 1) {
    let state = createInitialRankedState();
    let regret = 0n;
    while (!isTerminalState(state)) {
      const playerCards = getLegalCardIds(state.playerMask);
      const aiCards = getLegalCardIds(state.aiMask);
      const playerCardId = playerCards[Math.floor(random() * playerCards.length)];
      const aiCardId = aiCards[Math.floor(random() * aiCards.length)];
      regret += lookup.getDecision(state, playerCardId).regret;
      state = applyRound(state, playerCardId, aiCardId).state;
    }
    total += scaledToNumber(INITIAL_VALUE_SCALED - regret);
  }
  const mean = total / games;
  assert.ok(Math.abs(mean - 0.5) < 0.04, `mean=${mean}`);
  assert.ok(Math.abs(calculateRating(mean) - RANDOM_LEVEL_RATING) < 80);
});

test('Ratingは不正なperformanceを拒否し、負のsampleと統計補助値を安全に扱う', () => {
  assert.equal(clampDecisionPerformance(-0.25), -0.25);
  assert.throws(() => clampDecisionPerformance(Number.NaN), TypeError);
  assert.throws(() => clampDecisionPerformance(INITIAL_DECISION_EV + 0.001), RangeError);
  assert.throws(() => updateRatingProfile(null, { decisionPerformance: 0.5, matchScore: 0.25 }), RangeError);

  const profile = updateRatingProfile(createEmptyRatingProfile(), {
    decisionPerformance: -0.1,
    matchScore: 0,
    now: '2026-01-02T03:04:05.000Z'
  });
  assert.equal(profile.ratedGames, 1);
  assert.ok(profile.rating < RANDOM_LEVEL_RATING);
  assert.equal(profile.lastRankedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(effectiveSampleSize(createEmptyRatingProfile()), 0);
  assert.equal(standardError(createEmptyRatingProfile()), null);

  const twoSamples = updateRatingProfile(profile, { decisionPerformance: 0.4, matchScore: 0.5 });
  assert.ok(effectiveSampleSize(twoSamples) > 1);
  assert.ok(Number.isFinite(standardError(twoSamples)));
});
