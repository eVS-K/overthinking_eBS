'use strict';

const INITIAL_EV_NUMERATOR = 1931;
const INITIAL_EV_DENOMINATOR = 2520;
const INITIAL_DECISION_EV = INITIAL_EV_NUMERATOR / INITIAL_EV_DENOMINATOR;
const RATING_HALF_LIFE_GAMES = 50;
const RATING_LAMBDA = 2 ** (-1 / RATING_HALF_LIFE_GAMES);
const RANDOM_LEVEL_RATING = 1000;
const PERFECT_PLAY_RATING = 1500;

function createEmptyRatingProfile() {
  return {
    ratedGames: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    forfeits: 0,
    ewWeight: 0,
    ewWeightSq: 0,
    ewSum: 0,
    ewSumSq: 0,
    decisionEv: null,
    rating: null,
    lastRankedAt: null
  };
}

function isEligibleForLeaderboard(profile) {
  return Number(profile?.ratedGames || 0) >= 50;
}

function clampDecisionPerformance(value) {
  if (!Number.isFinite(value)) throw new TypeError('decision performance must be finite');
  // Regret cannot be negative. A tiny tolerance only absorbs decimal conversion noise.
  // A realised sequence can accumulate more regret than V0, so its sample may
  // be negative. Only an above-perfect value is invalid.
  if (value > INITIAL_DECISION_EV + 1e-12) throw new RangeError('decision performance exceeds perfect play');
  return Math.min(INITIAL_DECISION_EV, value);
}

function classifyMatchScore(matchScore) {
  if (matchScore === 1) return 'win';
  if (matchScore === 0.5) return 'draw';
  if (matchScore === 0) return 'loss';
  throw new RangeError('match score must be 0, 0.5, or 1');
}

function calculateRating(decisionEv) {
  if (decisionEv >= INITIAL_DECISION_EV - 1e-12) return PERFECT_PLAY_RATING;
  const raw = RANDOM_LEVEL_RATING
    + 500 * (decisionEv - 0.5) / (INITIAL_DECISION_EV - 0.5);
  // A valid decision sample cannot exceed perfect play. Preserve no artificial lower floor.
  return Math.min(PERFECT_PLAY_RATING, raw);
}

function effectiveSampleSize(profile) {
  const weight = Number(profile?.ewWeight || 0);
  const weightSq = Number(profile?.ewWeightSq || 0);
  return weight > 0 && weightSq > 0 ? (weight * weight) / weightSq : 0;
}

function standardError(profile) {
  const weight = Number(profile?.ewWeight || 0);
  const sumSq = Number(profile?.ewSumSq || 0);
  const mean = Number(profile?.decisionEv);
  const nEff = effectiveSampleSize(profile);
  if (!(weight > 0) || !Number.isFinite(mean) || !(nEff > 1)) return null;
  const variance = Math.max(0, sumSq / weight - mean * mean);
  return Math.sqrt(variance / nEff);
}

function updateRatingProfile(profile, { decisionPerformance, matchScore, forfeit = false, now = new Date() }) {
  const previous = { ...createEmptyRatingProfile(), ...(profile || {}) };
  const sample = clampDecisionPerformance(decisionPerformance);
  const outcome = classifyMatchScore(matchScore);
  const ewWeight = RATING_LAMBDA * Number(previous.ewWeight || 0) + 1;
  const ewWeightSq = RATING_LAMBDA ** 2 * Number(previous.ewWeightSq || 0) + 1;
  const ewSum = RATING_LAMBDA * Number(previous.ewSum || 0) + sample;
  const ewSumSq = RATING_LAMBDA * Number(previous.ewSumSq || 0) + sample * sample;
  const decisionEv = ewSum / ewWeight;

  const next = {
    ...previous,
    ratedGames: Number(previous.ratedGames || 0) + 1,
    wins: Number(previous.wins || 0) + (outcome === 'win' ? 1 : 0),
    draws: Number(previous.draws || 0) + (outcome === 'draw' ? 1 : 0),
    losses: Number(previous.losses || 0) + (outcome === 'loss' ? 1 : 0),
    forfeits: Number(previous.forfeits || 0) + (forfeit ? 1 : 0),
    ewWeight,
    ewWeightSq,
    ewSum,
    ewSumSq,
    decisionEv,
    rating: calculateRating(decisionEv),
    lastRankedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  };
  return next;
}

module.exports = {
  INITIAL_DECISION_EV,
  INITIAL_EV_DENOMINATOR,
  INITIAL_EV_NUMERATOR,
  PERFECT_PLAY_RATING,
  RANDOM_LEVEL_RATING,
  RATING_HALF_LIFE_GAMES,
  RATING_LAMBDA,
  calculateRating,
  clampDecisionPerformance,
  createEmptyRatingProfile,
  effectiveSampleSize,
  isEligibleForLeaderboard,
  standardError,
  updateRatingProfile
};
