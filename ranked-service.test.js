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

test('新規game作成はseason rotationと同じlockを先に取得して競合を防ぐ', async () => {
  const { service, repository } = makeService();
  const order = [];
  const originalLockSeason = repository.lockSeason.bind(repository);
  const originalGetActiveSeason = repository.getActiveSeason.bind(repository);
  repository.lockSeason = async (...args) => { order.push('lock'); return originalLockSeason(...args); };
  repository.getActiveSeason = async (...args) => { order.push('get'); return originalGetActiveSeason(...args); };
  await repository.transaction((tx) => service.ensureCurrentSeasonInTransaction(tx, { lockActive: true }));
  assert.equal(order[0], 'lock');
  assert.equal(order.includes('get'), true);
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
  const repeated = await service.updateHandle(USER_A, 'Player-2026');
  assert.equal(repeated.handle, 'Player-2026');
});

test('ランキング掲載は10局からで、公開可否を切り替えると順位・一覧の双方に即時反映する', async () => {
  const { service, repository } = makeService();
  await service.createOrResumeGame(USER_A);
  const season = await repository.getActiveSeason();
  const ratingProfile = await repository.getOrCreateRankedProfile(USER_A, season.id);
  await repository.saveRankedProfile({
    ...ratingProfile,
    ratedGames: 10,
    wins: 7,
    losses: 3,
    ewWeight: 10,
    ewWeightSq: 9,
    ewSum: 6,
    ewSumSq: 4,
    decisionEv: 0.6,
    rating: 1188
  });

  const visible = await service.getProfileSummary(USER_A);
  assert.equal(visible.leaderboardEligible, true);
  assert.equal(visible.leaderboardVisible, true);
  assert.equal(visible.rank, 1);
  assert.equal((await service.getLeaderboard()).entries.length, 1);

  const hidden = await service.updateProfileSettings(USER_A, { leaderboardVisible: false });
  assert.equal(hidden.leaderboardEligible, true);
  assert.equal(hidden.leaderboardVisible, false);
  assert.equal(hidden.rank, null);
  assert.equal((await service.getLeaderboard()).entries.length, 0);

  const restored = await service.updateProfileSettings(USER_A, { leaderboardVisible: true });
  assert.equal(restored.rank, 1);
  assert.equal((await service.getLeaderboard()).entries.length, 1);
  await assert.rejects(
    service.updateProfileSettings(USER_A, { leaderboardVisible: 'yes' }),
    (error) => error instanceof RankedError && error.code === 'INVALID_PROFILE_UPDATE'
  );
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

test('deadline後も読み取りは状態を変えず、明示的なsettleだけがserver-side timeout moveを確定する', async () => {
  const runtime = makeService();
  const game = await runtime.service.createOrResumeGame(USER_A);
  runtime.advance(90_000);
  const readOnly = await runtime.service.getActiveGame(USER_A);
  assert.equal(readOnly.currentRound, 1);
  assert.equal(readOnly.history.length, 0);
  assert.equal((await runtime.repository.listMoves(game.id)).length, 0);
  const settled = await runtime.service.settleActiveGame(USER_A);
  assert.equal(settled.currentRound, 2);
  assert.equal(settled.history.length, 1);
  assert.equal(settled.history[0].timeout, true);
  assert.equal(settled.history[0].playerCardId.length > 0, true);
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
  const settled = await runtime.service.settleActiveGame(USER_A);
  assert.equal(settled.status, 'completed');
  const moves = await runtime.repository.listMoves(initial.id);
  assert.equal(moves.at(-1).timeout, true);
  assert.equal(moves.at(-1).thinkingTimeMs, 15_000);
});

test('長時間放置されたdeadlineはforfeitとして一回だけratingへ反映される', async () => {
  const runtime = makeService();
  const game = await runtime.service.createOrResumeGame(USER_A);
  runtime.advance(24 * 60 * 60_000 + 90_000);
  const settled = await runtime.service.settleActiveGame(USER_A);
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

test('計算表の互換性が失われたactive gameは操作を止めるが、安全に投了して解除できる', async () => {
  const { service, repository } = makeService();
  const game = await service.createOrResumeGame(USER_A);
  const stored = await repository.findGameById(game.id);
  await repository.transaction((tx) => tx.saveGame({ ...stored, valueTableChecksum: 'obsolete-checksum' }));

  const view = await service.getActiveGame(USER_A);
  assert.equal(view.versionMismatch, true);
  assert.equal(view.status, 'active');
  const resumed = await service.createOrResumeGame(USER_A);
  assert.equal(resumed.id, game.id);
  assert.equal(resumed.versionMismatch, true);
  await assert.rejects(
    service.submitMove(USER_A, game.id, { expectedRound: 1, cardId: 'ace', requestId: REQUEST_A }),
    (error) => error instanceof RankedError && error.code === 'GAME_VERSION_MISMATCH'
  );
  assert.equal((await repository.findGameById(game.id)).currentRound, 1);

  const forfeited = await service.forfeitGame(USER_A, game.id);
  assert.equal(forfeited.status, 'forfeited');
  assert.equal((await service.getProfileSummary(USER_A)).ratedGames, 1);
});

test('期限切れOAuth transactionとsessionは定期的に削除できる', async () => {
  const runtime = makeService();
  const now = new Date('2026-08-24T00:00:00.000Z');
  await runtime.repository.createOAuthTransaction({
    stateHash: 'expired-oauth', provider: 'github', codeVerifier: 'verifier', redirectUri: 'https://example.test/auth/callback', expiresAt: new Date(now.getTime() - 1)
  });
  await runtime.repository.createSession({
    id: '30000000-0000-4000-8000-000000000099', userId: USER_A, sessionTokenHash: 'expired-session', csrfTokenHash: 'expired-csrf', expiresAt: new Date(now.getTime() - 1), idleExpiresAt: new Date(now.getTime() - 1)
  });
  const pruned = await runtime.service.pruneExpiredAuthArtifacts();
  assert.deepEqual(pruned, { oauthTransactions: 1, sessions: 1 });
  assert.equal(runtime.repository.oauthTransactions.size, 0);
  assert.equal(runtime.repository.sessions.size, 0);
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
  await service.createOrResumeGame(USER_A);
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

test('Rankedの読み取りはseason・rating profile・game stateを新規作成しない', async () => {
  const { service, repository } = makeService();
  await repository.ensureProfile(USER_A);

  const profile = await service.getProfileSummary(USER_A);
  const leaderboard = await service.getLeaderboard({ limit: 25, offset: 0 });

  assert.equal(profile.ratedGames, 0);
  assert.equal(profile.provisional, true);
  assert.equal(leaderboard.season, null);
  assert.deepEqual(leaderboard.entries, []);
  assert.equal(repository.seasons.size, 0);
  assert.equal(repository.rankedProfiles.size, 0);
  assert.equal(repository.games.size, 0);
});

test('leaderboard cacheは期限切れを掃除し、ページキーが増えても上限を超えない', async () => {
  const { repository } = makeService();
  const service = new RankedService({
    repository,
    valueLookup: new RankedValueLookup(createSignedRankedValueTable()),
    seedEncryptionKey: TEST_KEY,
    leaderboardCacheMaxEntries: 2
  });
  await service.createOrResumeGame(USER_A);
  await service.getLeaderboard({ limit: 1, offset: 0 });
  await service.getLeaderboard({ limit: 1, offset: 1 });
  await service.getLeaderboard({ limit: 1, offset: 2 });
  assert.equal(service.leaderboardCache.size, 2);
  for (const entry of service.leaderboardCache.values()) entry.expiresAt = 0;
  await service.getLeaderboard({ limit: 1, offset: 3 });
  assert.equal(service.leaderboardCache.size, 1);
});
