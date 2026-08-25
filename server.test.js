'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialHand } = require('./game-rules');
const {
  MAX_CHAT_IPS_PER_ROOM,
  PRIVATE_ROOM_IDLE_TTL_MS,
  app,
  buildDefaultAllowedOrigins,
  consumeChatIpQuota,
  createRoom,
  createRoomView,
  finishGameByForfeit,
  isPrivateRoomIdleExpired,
  normalizeJoinPreferences,
  processTurn,
  promoteVolunteerSpectators,
  startWhenBothPlayersAgree
} = require('./server');

function start(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('Guest chatのIP補助quotaはroom内の追跡IP数を上限で抑える', () => {
  const room = createRoom('chat-cap-test');
  const now = Date.now();
  for (let index = 0; index < MAX_CHAT_IPS_PER_ROOM; index += 1) {
    assert.equal(consumeChatIpQuota(room, `192.0.2.${index}`, now).ok, true);
  }
  const overflow = consumeChatIpQuota(room, '198.51.100.1', now);
  assert.equal(overflow.ok, false);
  assert.equal(room.chatIpUsage.size, MAX_CHAT_IPS_PER_ROOM);
});

test('Originの既定値はNODE_ENV未設定・productionでlocalhostを許可しない', () => {
  for (const environment of [{}, { NODE_ENV: 'production' }]) {
    const origins = buildDefaultAllowedOrigins(environment);
    assert.equal(origins.includes('http://localhost:3000'), false);
    assert.equal(origins.includes('http://127.0.0.1:3000'), false);
  }
  assert.equal(buildDefaultAllowedOrigins({ NODE_ENV: 'development' }).includes('http://localhost:3000'), true);
  assert.equal(buildDefaultAllowedOrigins({ NODE_ENV: 'test' }).includes('http://127.0.0.1:3000'), true);
});

test('観戦参加・空席への参加は明示的なboolean opt-inだけを受け入れる', () => {
  assert.deepEqual(normalizeJoinPreferences({}), { joinAsSpectator: false, autoJoinWhenSeatAvailable: false });
  assert.deepEqual(normalizeJoinPreferences({ joinAsSpectator: 'true', autoJoinWhenSeatAvailable: true }), { joinAsSpectator: false, autoJoinWhenSeatAvailable: false });
  assert.deepEqual(normalizeJoinPreferences({ joinAsSpectator: true }), { joinAsSpectator: true, autoJoinWhenSeatAvailable: false });
  assert.deepEqual(normalizeJoinPreferences({ joinAsSpectator: true, autoJoinWhenSeatAvailable: true }), { joinAsSpectator: true, autoJoinWhenSeatAvailable: true });
});

test('Private PvPの待機・終了ルームだけがアイドル期限の対象となり、対局中は期限切れにならない', () => {
  const waitingRoom = createRoom('idle-waiting');
  waitingRoom.idleDeadline = 10_000;
  assert.equal(isPrivateRoomIdleExpired(waitingRoom, 9_999), false);
  assert.equal(isPrivateRoomIdleExpired(waitingRoom, 10_000), true);

  const finishedRoom = createRoom('idle-finished');
  finishedRoom.gameState = 'finished';
  finishedRoom.idleDeadline = 10_000;
  assert.equal(isPrivateRoomIdleExpired(finishedRoom, 10_000), true);

  const playingRoom = createRoom('idle-playing');
  playingRoom.gameState = 'playing';
  playingRoom.idleDeadline = 10_000;
  assert.equal(isPrivateRoomIdleExpired(playingRoom, 10_000), false);

  const randomRoom = createRoom('idle-random', { matchType: 'random' });
  randomRoom.idleDeadline = 10_000;
  assert.equal(isPrivateRoomIdleExpired(randomRoom, 10_000), false);
  assert.ok(PRIVATE_ROOM_IDLE_TTL_MS >= 60_000);
});

test('観戦者には常に両者の手札を渡し、希望していない観戦者を空席へ昇格させない', () => {
  const room = createRoom('spectator-view');
  room.players = [
    { id: 'p1', clientId: 'p1-client', name: '♠側', suit: '♠', hand: [{ id: 'ace' }], score: 2, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '♥側', suit: '♥', hand: [{ id: 'king' }], score: 3, connected: true }
  ];
  room.spectators = [{ id: 'viewer', clientId: 'viewer-client', name: '観戦者', autoJoinWhenSeatAvailable: false }];
  const view = createRoomView(room, 'viewer');
  assert.equal(view.viewer.isSpectator, true);
  assert.equal(view.viewer.autoJoinWhenSeatAvailable, false);
  assert.deepEqual(view.players.map((player) => player.hand[0].id), ['ace', 'king']);

  room.players.pop();
  room.spectators.push({ id: 'volunteer', clientId: 'volunteer-client', name: '希望者', autoJoinWhenSeatAvailable: true });
  const promoted = promoteVolunteerSpectators(room, (socketId) => socketId === 'volunteer' ? {} : null);
  assert.equal(promoted, 1);
  assert.equal(room.players[1].id, 'volunteer');
  assert.deepEqual(room.spectators.map((spectator) => spectator.id), ['viewer']);
});

test('降参は対局を一度だけ終了し、相手を勝者として確定する', () => {
  const room = createRoom('forfeit');
  room.gameState = 'playing';
  room.players = [
    { id: 'p1', clientId: 'p1-client', name: '先手', suit: '♠', hand: [], score: 1, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '後手', suit: '♥', hand: [], score: 2, connected: true }
  ];
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
  assert.equal(room.gameState, 'finished');
  assert.equal(room.winner, '後手');
  assert.equal(room.winnerSeat, 'p2');
  assert.deepEqual(room.finishReason.type, 'forfeit');
  assert.equal(room.finishReason.forfeitedBy, '先手');
  assert.equal(room.finishReason.forfeitedBySeat, 'p1');
  assert.equal(finishGameByForfeit(room, room.players[0]), false);
});

test('勝敗は同名やDrawという表示名ではなくp1/p2席で確定し、終了理由も保存する', () => {
  const scoreLimit = createRoom('score-limit');
  scoreLimit.gameState = 'playing';
  scoreLimit.players = [
    { id: 'p1', clientId: 'p1-client', name: 'Draw', suit: '♠', hand: createInitialHand(), score: 8, connected: true },
    { id: 'p2', clientId: 'p2-client', name: 'Draw', suit: '♥', hand: createInitialHand(), score: 0, connected: true }
  ];
  scoreLimit.selections = { p1: 'ace', p2: 'king' };
  processTurn(scoreLimit);
  assert.equal(scoreLimit.gameState, 'finished');
  assert.equal(scoreLimit.winner, 'Draw');
  assert.equal(scoreLimit.winnerSeat, 'p1');
  assert.equal(scoreLimit.lastRound.winnerSeat, 'p1');
  assert.equal(scoreLimit.finishReason.type, 'score-limit');

  const roundLimit = createRoom('round-limit');
  roundLimit.gameState = 'playing';
  roundLimit.round = 7;
  roundLimit.players = [
    { id: 'p1', clientId: 'p1-client', name: '同名', suit: '♠', hand: createInitialHand(), score: 0, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '同名', suit: '♥', hand: createInitialHand(), score: 1, connected: true }
  ];
  roundLimit.selections = { p1: 'king', p2: 'ace' };
  processTurn(roundLimit);
  assert.equal(roundLimit.gameState, 'finished');
  assert.equal(roundLimit.winnerSeat, 'p2');
  assert.equal(roundLimit.lastRound.winnerSeat, 'p2');
  assert.equal(roundLimit.finishReason.type, 'round-limit');

  const drawLimit = createRoom('round-draw');
  drawLimit.gameState = 'playing';
  drawLimit.round = 7;
  drawLimit.players = [
    { id: 'p1', clientId: 'p1-client', name: 'Draw', suit: '♠', hand: createInitialHand(), score: 1, connected: true },
    { id: 'p2', clientId: 'p2-client', name: 'Draw', suit: '♥', hand: createInitialHand(), score: 1, connected: true }
  ];
  drawLimit.selections = { p1: 'ace', p2: 'ace' };
  processTurn(drawLimit);
  assert.equal(drawLimit.winnerSeat, null);
  assert.equal(drawLimit.lastRound.winnerSeat, null);
  assert.equal(drawLimit.finishReason.type, 'round-limit');
});

test('二人の対戦者がそれぞれ同意するまで対局は始まらず、観戦者の同意は数えない', () => {
  const room = createRoom('start-consent');
  room.players = [
    { id: 'p1', clientId: 'p1-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.spectators = [{ id: 'viewer', clientId: 'viewer-client', name: '観戦者', autoJoinWhenSeatAvailable: false }];
  room.startAgreements.add('viewer-client');
  room.startAgreements.add('p1-client');
  assert.equal(startWhenBothPlayersAgree(room), false);
  assert.equal(room.gameState, 'waiting');
  assert.equal(createRoomView(room, 'p1').startReadyCount, 1);

  room.startAgreements.add('p2-client');
  assert.equal(startWhenBothPlayersAgree(room), true);
  assert.equal(room.gameState, 'playing');
  assert.equal(room.startAgreements.size, 0);
  finishGameByForfeit(room, room.players[0]);
});

test('legacy applicationはRanked未設定でも起動し、Ranked入口を安全に配信する', async (t) => {
  const localServer = http.createServer(app);
  const port = await start(localServer);
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  const [health, ready, ranked, rankedUi, legacyIndex, oauthRecovery, socketLoader, pageRedirect] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/health`),
    fetch(`http://127.0.0.1:${port}/readyz`),
    fetch(`http://127.0.0.1:${port}/ranked`),
    fetch(`http://127.0.0.1:${port}/ranked-ui.js`),
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/oauth-recovery.js`),
    fetch(`http://127.0.0.1:${port}/socket-loader.js`),
    fetch(`http://127.0.0.1:${port}/page-redirect.js`)
  ]);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready', guestPvp: 'ready', ranked: 'disabled' });
  assert.equal(ranked.status, 200);
  assert.match(ranked.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(ranked.headers.get('content-security-policy'), /script-src 'self'/);
  const rankedHtml = await ranked.text();
  assert.match(rankedHtml, /ランク戦/);
  assert.match(rankedHtml, /ranked-ui\.js/);
  assert.match(rankedHtml, /href="\/"/);
  assert.equal(rankedUi.status, 200);
  assert.match(await rankedUi.text(), /HANDLE_PATTERN/);
  const legacyHtml = await legacyIndex.text();
  assert.match(legacyHtml, /page-redirect\.js/);
  assert.match(legacyHtml, /Content-Security-Policy/);
  assert.match(legacyHtml, /socket-loader\.js/);
  assert.equal(socketLoader.status, 200);
  const socketLoaderText = await socketLoader.text();
  assert.match(socketLoaderText, /overthinking-ebs\.onrender\.com\/socket\.io\/socket\.io\.js/);
  assert.match(socketLoaderText, /\/socket\.io\/socket\.io\.js/);
  assert.doesNotMatch(legacyHtml, /cdn\.socket\.io/);
  assert.equal(pageRedirect.status, 200);
  assert.match(await pageRedirect.text(), /window\.location\.replace/);
  assert.equal(oauthRecovery.status, 200);
  assert.match(await oauthRecovery.text(), /HttpOnly transaction cookie/);
});
