'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryRankedRepository } = require('./ranked-repository');
const { RankedError, RankedService } = require('./ranked-service');
const { decryptSeed } = require('./ranked-crypto');
const { applyRound } = require('./ranked-engine');
const { deriveAiCardId } = require('./ranked-rng');
const { RankedValueLookup, createSignedRankedValueTable } = require('./ranked-values');

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const REQUEST_A = '10000000-0000-4000-8000-000000000001';
const REQUEST_B = '10000000-0000-4000-8000-000000000002';
const TEST_KEY = Buffer.alloc(32, 11);

function makeService() {
  let current = new Date('2026-08-24T00:00:00.000Z');
  const repository = new MemoryRankedRepository();
  const service = new RankedService({
    repository,
    valueLookup: new RankedValueLookup(createSignedRankedValueTable()),
    seedEncryptionKey: TEST_KEY,
    now: () => new Date(current)
  });
  return {
    repository,
    service,
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); }
  };
}

test('1 userにつきactive Ranked gameは1件だけで、active stateはseedを漏らさない', async () => {
  const { service } = makeService();
  const [first, second] = await Promise.all([service.createOrResumeGame(USER_A), service.createOrResumeGame(USER_A)]);
  assert.equal(first.id, second.id);
  assert.equal(first.status, 'active');
  assert.equal(first.playerHand.length, 7);
  assert.equal(first.opponentHand.length, 7);
  assert.deepEqual(first.opponentHand, ['ace', 'king', 'queen', 'jack', 'joker', 'three', 'two']);
  assert.equal(first.aiRemainingCards, 7);
  assert.equal(typeof first.seedCommitment, 'string');
  assert.equal(Object.hasOwn(first, 'seed'), false);
  assert.equal(JSON.stringify(first).includes('encryptedSeed'), false);
});

test('公開handleは20文字以内のASCII許可文字だけを受け入れ、空白と不可視文字を拒否する', async () => {
  const { service } = makeService();
  for (const invalid of ['ab', 'abcdefghijklmnopqrstu', 'valid handle', ' valid', 'valid ', 'valid\u200Bhandle', 'valid\nhandle', '全角Handle']) {
    await assert.rejects(
      service.updateHandle(USER_A, invalid),
      (error) => error instanceof RankedError && error.code === 'INVALID_HANDLE'
    );
  }
  const updated = await service.updateHandle(USER_A, 'Player-2026');
  assert.equal(updated.handle, 'Player-2026');
});

test('moveはserver authoritativeで、同一requestIdはidempotent、カードは一度しか消費されない', async () => {
  const { service, repository } = makeService();
  const game = await service.createOrResumeGame(USER_A);
  const first = await service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A });
  const duplicate = await service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A });
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(first.round.playerCardId, duplicate.round.playerCardId);
  assert.equal(first.game.opponentHand.length, 6);
  assert.equal(first.game.opponentHand.includes(first.round.aiCardId), false);
  const persisted = await repository.findGameById(game.id);
  assert.equal(persisted.currentRound, 2);
  assert.equal(persisted.state.playerMask.toString(2).split('1').length - 1, 6);
  assert.equal((await repository.listMoves(game.id)).length, 1);
});

test('invalid card / stale round / ownership違反は状態を変更しない', async () => {
  const { service, repository } = makeService();
  const game = await service.createOrResumeGame(USER_A);
  await assert.rejects(
    service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'not-a-card', requestId: REQUEST_A }),
    (error) => error instanceof RankedError && error.code === 'INVALID_CARD'
  );
  await assert.rejects(
    service.submitMove(USER_B, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A }),
    (error) => error instanceof RankedError && error.code === 'GAME_NOT_FOUND'
  );
  await assert.rejects(
    service.submitMove(USER_A, game.id, { expectedRound: 2, cardId: 'ace', requestId: REQUEST_B }),
    (error) => error instanceof RankedError && error.code === 'ROUND_MISMATCH'
  );
  const persisted = await repository.findGameById(game.id);
  assert.equal(persisted.currentRound, 1);
  assert.equal((await repository.listMoves(game.id)).length, 0);
});

test('parallel move requestsは一つのroundしか処理しない', async () => {
  const { service, repository } = makeService();
  const game = await service.createOrResumeGame(USER_A);
  const results = await Promise.all([
    service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A }),
    service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A })
  ]);
  assert.equal(results.filter((result) => result.idempotent).length, 1);
  assert.equal((await repository.listMoves(game.id)).length, 1);
  assert.equal((await repository.findGameById(game.id)).currentRound, 2);
});

test('異なるrequestIdのparallel moveも一枚だけ消費し、片方はstaleとして拒否される', async () => {
  const { service, repository } = makeService();
  const game = await service.createOrResumeGame(USER_A);
  const results = await Promise.allSettled([
    service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A }),
    service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'king', requestId: REQUEST_B })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'ROUND_MISMATCH').length, 1);
  assert.equal((await repository.listMoves(game.id)).length, 1);
  assert.equal((await repository.findGameById(game.id)).currentRound, 2);
});

test('deadline後はserver-side deterministic timeout moveとなり、resume可能', async () => {
  const runtime = makeService();
  const game = await runtime.service.createOrResumeGame(USER_A);
  runtime.advance(90_000);
  const resumed = await runtime.service.getActiveGame(USER_A);
  assert.equal(resumed.currentRound, 2);
  assert.equal(resumed.history.length, 1);
  assert.equal(resumed.history[0].timeout, true);
  assert.equal(resumed.history[0].playerCardId.length > 0, true);
  const [move] = await runtime.repository.listMoves(game.id);
  assert.equal(move.timeout, true);
  assert.ok(move.regret >= 0n);
});

test('最終ラウンドはserver-sideで15秒締切になり、timeout記録も15秒になる', async () => {
  const runtime = makeService();
  const now = new Date('2026-08-24T00:00:00.000Z');
  const initial = await runtime.service.createOrResumeGame(USER_A);
  const stored = await runtime.repository.findGameById(initial.id);
  let state = stored.state;
  // Five draws leave a valid round-six state with a ten-card stack.  Select
  // the deterministic opponent card in round six too, so the forced seventh
  // round is reached without an early score-based game end.
  for (const cardId of ['ace', 'king', 'queen', 'jack', 'joker']) {
    state = applyRound(state, cardId, cardId).state;
  }
  const staged = {
    ...stored,
    state,
    currentRound: 6,
    turnStartedAt: now,
    deadline: new Date(now.getTime() + 90_000)
  };
  const seed = decryptSeed(staged.encryptedSeed, TEST_KEY);
  const playerCardId = deriveAiCardId(seed, { gameId: staged.id, round: staged.currentRound, state: staged.state });
  const sixthRound = await runtime.repository.transaction((tx) => runtime.service.executeRoundInTransaction(tx, staged, {
    playerCardId,
    requestId: REQUEST_A,
    timeout: false,
    thinkingTimeMs: 0,
    now
  }));
  assert.equal(sixthRound.game.currentRound, 7);
  assert.equal(new Date(sixthRound.game.deadline).getTime() - now.getTime(), 15_000);

  runtime.advance(15_000);
  const settled = await runtime.service.getActiveGame(USER_A);
  assert.equal(settled.status, 'completed');
  const moves = await runtime.repository.listMoves(initial.id);
  assert.equal(moves.at(-1).timeout, true);
  assert.equal(moves.at(-1).thinkingTimeMs, 15_000);
});

test('長時間放置されたdeadlineはforfeitとして一回だけratingへ反映される', async () => {
  const runtime = makeService();
  const game = await runtime.service.createOrResumeGame(USER_A);
  runtime.advance(24 * 60 * 60_000 + 90_000);
  const settled = await runtime.service.getActiveGame(USER_A);
  assert.equal(settled.status, 'forfeited');
  assert.equal(settled.actualResult, 'forfeit');
  assert.equal((await runtime.repository.listMoves(game.id)).length, 0);
  const profile = await runtime.service.getProfileSummary(USER_A);
  assert.equal(profile.forfeits, 1);
});

test('forfeitはDecision Performance 0でratingを一回だけfinalizeする', async () => {
  const { service } = makeService();
  const game = await service.createOrResumeGame(USER_A);
  const first = await service.forfeitGame(USER_A, game.id);
  const second = await service.forfeitGame(USER_A, game.id);
  assert.equal(first.status, 'forfeited');
  assert.equal(first.decisionPerformance, 0);
  assert.equal(second.ratingAfter, first.ratingAfter);
  const profile = await service.getProfileSummary(USER_A);
  assert.deepEqual({ games: profile.ratedGames, losses: profile.losses, forfeits: profile.forfeits }, { games: 1, losses: 1, forfeits: 1 });
});

test('season rotationは古いgame/ratingを保持し、新seasonを分離する', async () => {
  const { service, repository } = makeService();
  const oldGame = await service.createOrResumeGame(USER_A);
  await service.forfeitGame(USER_A, oldGame.id);
  await repository.transaction((tx) => tx.closeActiveSeason(new Date('2026-08-25T00:00:00.000Z')));

  const newSummary = await service.getProfileSummary(USER_A);
  const newGame = await service.createOrResumeGame(USER_A);
  const persistedOld = await repository.findGameById(oldGame.id);

  assert.equal(newSummary.ratedGames, 0);
  assert.notEqual(newGame.seasonId, oldGame.seasonId);
  assert.equal(persistedOld.seasonId, oldGame.seasonId);
  assert.equal(persistedOld.status, 'forfeited');
});

test('leaderboardは短時間cacheし、同時取得を一つのDB queryへまとめる', async () => {
  const { service, repository } = makeService();
  let queries = 0;
  const original = repository.getLeaderboard.bind(repository);
  repository.getLeaderboard = async (...args) => {
    queries += 1;
    return original(...args);
  };

  const [first, second] = await Promise.all([
    service.getLeaderboard({ limit: 25, offset: 0 }),
    service.getLeaderboard({ limit: 25, offset: 0 })
  ]);
  const third = await service.getLeaderboard({ limit: 25, offset: 0 });
  assert.equal(queries, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});
