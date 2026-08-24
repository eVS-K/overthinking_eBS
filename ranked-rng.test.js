'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialRankedState } = require('./ranked-engine');
const { decryptSeed, encryptSeed } = require('./ranked-crypto');
const {
  createGameSeed,
  deriveAiCardId,
  deriveTimeoutPlayerCardId,
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
