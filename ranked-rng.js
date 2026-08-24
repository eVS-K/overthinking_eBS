'use strict';

const crypto = require('crypto');
const { cardIdFromIndex, getLegalCardIndices, stateKey } = require('./ranked-engine');

const RANKED_AI_POLICY_VERSION = 'uniform-random-ai-v1';
const RANKED_TIMEOUT_POLICY_VERSION = 'timeout-uniform-random-v1';
const SEED_BYTES = 32;
const UINT256_RANGE = 1n << 256n;

function assertSeed(seed) {
  const bytes = Buffer.isBuffer(seed) ? seed : Buffer.from(seed || '');
  if (bytes.length !== SEED_BYTES) throw new TypeError('ranked seed must be exactly 256 bits');
  return bytes;
}

function createGameSeed() {
  return crypto.randomBytes(SEED_BYTES);
}

function seedToPublicString(seed) {
  return assertSeed(seed).toString('base64url');
}

function seedFromPublicString(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new TypeError('invalid public seed encoding');
  return assertSeed(Buffer.from(value, 'base64url'));
}

function seedCommitment(seed) {
  return crypto.createHash('sha256').update(assertSeed(seed)).digest('hex');
}

function assertContext(context) {
  if (!context || typeof context !== 'object') throw new TypeError('rng context is required');
  if (typeof context.gameId !== 'string' || context.gameId.length < 1 || context.gameId.length > 80) {
    throw new TypeError('rng context gameId is invalid');
  }
  if (!Number.isSafeInteger(context.round) || context.round < 1 || context.round > 7) {
    throw new RangeError('rng context round is invalid');
  }
  if (typeof context.stateKey !== 'string' || context.stateKey.length < 1 || context.stateKey.length > 100) {
    throw new TypeError('rng context stateKey is invalid');
  }
}

function hmacBlock(seed, domain, context, counter) {
  assertContext(context);
  const message = JSON.stringify([domain, context.gameId, context.round, context.stateKey, counter]);
  return crypto.createHmac('sha256', assertSeed(seed)).update(message, 'utf8').digest();
}

function rejectionLimit(upperBound) {
  if (!Number.isSafeInteger(upperBound) || upperBound < 1 || upperBound > 256) {
    throw new RangeError('upper bound must be an integer between 1 and 256');
  }
  const bound = BigInt(upperBound);
  return UINT256_RANGE - (UINT256_RANGE % bound);
}

function mapUniformCandidate(candidate, upperBound) {
  const value = BigInt(candidate);
  if (value < 0n || value >= UINT256_RANGE) throw new RangeError('candidate is outside uint256');
  const limit = rejectionLimit(upperBound);
  return value < limit ? Number(value % BigInt(upperBound)) : null;
}

/**
 * Uniformly maps a PRF stream into [0, upperBound) without modulo bias.
 */
function deriveUniformIndex(seed, domain, context, upperBound) {
  if (!Number.isSafeInteger(upperBound) || upperBound < 1 || upperBound > 256) {
    throw new RangeError('upper bound must be an integer between 1 and 256');
  }
  const acceptedRange = rejectionLimit(upperBound);
  for (let counter = 0; counter < 1_000_000; counter += 1) {
    const candidate = BigInt(`0x${hmacBlock(seed, domain, context, counter).toString('hex')}`);
    if (candidate < acceptedRange) return Number(candidate % BigInt(upperBound));
  }
  throw new Error('PRF rejection sampling exhausted unexpectedly');
}

function createStateContext(gameId, round, state) {
  return { gameId, round, stateKey: stateKey(state) };
}

function deriveAiCardIndex(seed, { gameId, round, state }) {
  const legalCards = getLegalCardIndices(state.aiMask);
  if (!legalCards.length) throw new Error('AI has no legal cards');
  const index = deriveUniformIndex(seed, RANKED_AI_POLICY_VERSION, createStateContext(gameId, round, state), legalCards.length);
  return legalCards[index];
}

function deriveAiCardId(seed, context) {
  return cardIdFromIndex(deriveAiCardIndex(seed, context));
}

function deriveTimeoutPlayerCardIndex(seed, { gameId, round, state }) {
  const legalCards = getLegalCardIndices(state.playerMask);
  if (!legalCards.length) throw new Error('player has no legal cards');
  const index = deriveUniformIndex(seed, RANKED_TIMEOUT_POLICY_VERSION, createStateContext(gameId, round, state), legalCards.length);
  return legalCards[index];
}

function deriveTimeoutPlayerCardId(seed, context) {
  return cardIdFromIndex(deriveTimeoutPlayerCardIndex(seed, context));
}

module.exports = {
  RANKED_AI_POLICY_VERSION,
  RANKED_TIMEOUT_POLICY_VERSION,
  SEED_BYTES,
  createGameSeed,
  deriveAiCardId,
  deriveAiCardIndex,
  deriveTimeoutPlayerCardId,
  deriveTimeoutPlayerCardIndex,
  deriveUniformIndex,
  mapUniformCandidate,
  rejectionLimit,
  seedCommitment,
  seedFromPublicString,
  seedToPublicString
};
