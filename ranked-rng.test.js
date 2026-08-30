'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialRankedState } = require('./ranked-engine');
const { decryptSeed, encryptSeed } = require('./ranked-crypto');
const {
  createGameSeed,
  deriveAiCardId,
  deriveTimeoutPlayerCardId,
  deriveUniformIndex,
  mapUniformCandidate,
  rejectionLimit,
  seedCommitment,
  seedFromPublicString,
  seedToPublicString
} = require('./ranked-rng');

const TEST_KEY = Buffer.alloc(32, 7);

test('Ranked RNGはseed reveal後にdeterministic replayできる', () => {
  const seed = createGameSeed();
  const state = createInitialRankedState();
  const context = { gameId: '00000000-0000-4000-8000-000000000001', round: 1, state };
  const revealed = seedFromPublicString(seedToPublicString(seed));
  assert.equal(deriveAiCardId(seed, context), deriveAiCardId(revealed, context));
  assert.equal(seedCommitment(revealed), seedCommitment(seed));
  assert.equal(seedCommitment(seed).length, 64);
});

test('AI cardはcurrent player cardを乱数入力に含めない', () => {
  const seed = Buffer.alloc(32, 3);
  const state = createInitialRankedState();
  const base = { gameId: '00000000-0000-4000-8000-000000000002', round: 1, state };
  assert.equal(
    deriveAiCardId(seed, { ...base, playerCardId: 'ace' }),
    deriveAiCardId(seed, { ...base, playerCardId: 'two' })
  );
});

test('timeout選択とAI選択は別domainで再現可能', () => {
  const seed = Buffer.alloc(32, 9);
  const context = { gameId: '00000000-0000-4000-8000-000000000003', round: 1, state: createInitialRankedState() };
  assert.equal(deriveTimeoutPlayerCardId(seed, context), deriveTimeoutPlayerCardId(seed, context));
  assert.equal(deriveAiCardId(seed, context), deriveAiCardId(seed, context));
});

test('rejection samplingはmodulo biasを生む末尾領域を捨てる', () => {
  const limit = rejectionLimit(7);
  assert.equal(limit % 7n, 0n);
  assert.equal(mapUniformCandidate(limit, 7), null);
  assert.equal(mapUniformCandidate(limit - 1n, 7), Number((limit - 1n) % 7n));
});

test('game seedはAES-256-GCMで暗号化して保存・復号できる', () => {
  const seed = createGameSeed();
  const encrypted = encryptSeed(seed, TEST_KEY);
  assert.notDeepEqual(encrypted.ciphertext, seed);
  assert.deepEqual(decryptSeed(encrypted, TEST_KEY), seed);
  assert.throws(() => decryptSeed({ ...encrypted, authTag: Buffer.alloc(16) }, TEST_KEY));
});

test('Ranked RNGは不正なseed・context・候補値を境界で拒否する', () => {
  const seed = Buffer.alloc(32, 5);
  const state = createInitialRankedState();
  const validContext = { gameId: 'rng-boundary-game', round: 1, state };
  assert.equal(seedFromPublicString(seedToPublicString(seed)).equals(seed), true);
  assert.throws(() => seedToPublicString(Buffer.alloc(31)), TypeError);
  assert.throws(() => seedFromPublicString('invalid'), TypeError);
  assert.throws(() => seedCommitment(Buffer.alloc(33)), TypeError);
  assert.throws(() => rejectionLimit(0), RangeError);
  assert.throws(() => rejectionLimit(257), RangeError);
  assert.throws(() => mapUniformCandidate(-1n, 7), RangeError);
  assert.throws(() => mapUniformCandidate(1n << 256n, 7), RangeError);
  assert.throws(() => deriveUniformIndex(seed, 'test', { ...validContext, gameId: '' }, 2), TypeError);
  assert.throws(() => deriveUniformIndex(seed, 'test', { ...validContext, round: 8 }, 2), RangeError);
  assert.throws(() => deriveUniformIndex(seed, 'test', { ...validContext, stateKey: '' }, 2), TypeError);
  assert.throws(() => deriveUniformIndex(seed, 'test', { ...validContext, stateKey: 'x'.repeat(101) }, 2), TypeError);
  assert.throws(() => deriveUniformIndex(seed, 'test', validContext, 0), RangeError);

  const terminalState = { playerMask: 0, aiMask: 0, playerScore: 7, aiScore: 7, stackCount: 0 };
  assert.throws(() => deriveAiCardId(seed, { ...validContext, state: terminalState }), /no legal cards/);
  assert.throws(() => deriveTimeoutPlayerCardId(seed, { ...validContext, state: terminalState }), /no legal cards/);
});
