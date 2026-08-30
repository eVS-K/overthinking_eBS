'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: createSocketClient } = require('socket.io-client');
const { server } = require('./server');

const TEST_ORIGIN = 'https://evs-k.github.io';
const EVENT_TIMEOUT_MS = 2_500;

function waitForEvent(socket, eventName, predicate = () => true, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timer;
    const listener = (payload) => {
      try {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        socket.off(eventName, listener);
        resolve(payload);
      } catch (error) {
        clearTimeout(timer);
        socket.off(eventName, listener);
        reject(error);
      }
    };
    timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    socket.on(eventName, listener);
  });
}

function waitForRoom(socket, roomId, predicate = () => true) {
  return waitForEvent(socket, 'room_updated', (room) => room?.id === roomId && predicate(room));
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

async function connectClient(port) {
  const socket = createSocketClient(`http://127.0.0.1:${port}`, {
    forceNew: true,
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
    extraHeaders: { Origin: TEST_ORIGIN }
  });
  socket.testEvents = [];
  socket.onAny((eventName) => socket.testEvents.push(eventName));
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error('Socket.IO connection failed'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out connecting the Socket.IO test client'));
    }, EVENT_TIMEOUT_MS);
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
  return socket;
}

async function closeServer(clients) {
  clients.forEach((client) => client?.disconnect());
  await new Promise((resolve) => server.close(resolve));
}

function joinRoom(socket, roomId, clientId, playerName, options = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('room_updated', onRoom);
      socket.off('room_error', onError);
    };
    const onRoom = (room) => {
      if (room?.id !== roomId) return;
      cleanup();
      resolve(room);
    };
    const onError = (error) => {
      cleanup();
      reject(new Error(`join_room rejected: ${error?.message || 'unknown error'}`));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for join_room response for ${playerName} (${socket.id || 'disconnected'}); received: ${socket.testEvents.join(', ')}`));
    }, EVENT_TIMEOUT_MS);
    socket.on('room_updated', onRoom);
    socket.once('room_error', onError);
    socket.emit('join_room', {
      roomId,
      clientId,
      playerName,
      joinAsSpectator: options.joinAsSpectator === true,
      autoJoinWhenSeatAvailable: options.autoJoinWhenSeatAvailable === true
    });
  });
}

function requestCurrentRoom(socket, roomId, clientId, playerName, options = {}) {
  return joinRoom(socket, roomId, clientId, playerName, options);
}

function ownPlayer(room, socket) {
  const player = room.players.find((candidate) => candidate.id === socket.id);
  assert.ok(player, 'client must have a server-authoritative player seat');
  return player;
}

function emitWithAcknowledgement(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName} acknowledgement`)), EVENT_TIMEOUT_MS);
    socket.emit(eventName, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

test('実Socket.IOで、入室・観戦・開始・確定・再接続・観戦予約の権限境界を通す', async (t) => {
  const port = await startServer();
  const clients = [];
  t.after(() => closeServer(clients));

  // Guest room keys are deliberately bounded to 24 characters by the server.
  const roomId = `sl-${crypto.randomBytes(8).toString('hex')}`;
  const firstClientId = 'socket-life-first';
  const secondClientId = 'socket-life-second';
  const spectatorClientId = 'socket-life-spectator';

  const first = await connectClient(port);
  clients.push(first);
  let firstView = await joinRoom(first, roomId, firstClientId, '先手');
  assert.equal(firstView.gameState, 'waiting');
  assert.equal(firstView.players.length, 1);

  const second = await connectClient(port);
  clients.push(second);
  const firstAfterSecond = waitForRoom(first, roomId, (room) => room.players.length === 2);
  let secondView = await joinRoom(second, roomId, secondClientId, '後手');
  firstView = await firstAfterSecond;
  assert.equal(firstView.gameState, 'waiting');
  assert.equal(secondView.players.length, 2);

  const spectator = await connectClient(port);
  clients.push(spectator);
  const firstAfterSpectator = waitForRoom(first, roomId, (room) => room.spectatorCount === 1);
  let spectatorView = await joinRoom(spectator, roomId, spectatorClientId, '観戦者', { joinAsSpectator: true });
  firstView = await firstAfterSpectator;
  assert.equal(firstView.spectatorCount, 1);
  assert.equal(spectatorView.viewer.isSpectator, true);
  assert.equal(spectatorView.players.length, 2);
  assert.equal(spectatorView.players.every((player) => player.hand.length === 7), true);

  // A spectator is allowed to see the public settings, but cannot modify or
  // transfer their authority. The acknowledgement is a deterministic
  // permission boundary, not a visual-only UI assertion.
  const originalConfigRevision = spectatorView.rules.configRevision;
  const settingsAttempt = await emitWithAcknowledgement(spectator, 'update_private_settings', {
    roomId,
    configRevision: originalConfigRevision,
    turnTimeLimitMs: 60_000
  });
  assert.equal(settingsAttempt.ok, false);
  const transferAttempt = await emitWithAcknowledgement(spectator, 'transfer_private_settings_owner', { roomId });
  assert.equal(transferAttempt.ok, false);
  spectatorView = await requestCurrentRoom(spectator, roomId, spectatorClientId, '観戦者', { joinAsSpectator: true });
  assert.equal(spectatorView.rules.configRevision, originalConfigRevision);
  assert.equal(spectatorView.viewer.isRoomHost, false);

  // A single player's consent must never start the game, and a spectator's
  // forged consent must not count as a second player consent.
  const firstReady = waitForRoom(first, roomId, (room) => room.startReadyCount === 1);
  first.emit('agree_to_start', { roomId });
  firstView = await firstReady;
  assert.equal(firstView.gameState, 'waiting');
  spectator.emit('agree_to_start', { roomId });
  // Re-query through the same socket: Socket.IO preserves ordering for a
  // socket, so this is a deterministic barrier after the forged event.
  spectatorView = await requestCurrentRoom(spectator, roomId, spectatorClientId, '観戦者', { joinAsSpectator: true });
  assert.equal(spectatorView.gameState, 'waiting');
  assert.equal(spectatorView.startReadyCount, 1);

  const firstPlaying = waitForRoom(first, roomId, (room) => room.gameState === 'playing');
  const secondPlaying = waitForRoom(second, roomId, (room) => room.gameState === 'playing');
  const spectatorPlaying = waitForRoom(spectator, roomId, (room) => room.gameState === 'playing');
  second.emit('agree_to_start', { roomId });
  [firstView, secondView, spectatorView] = await Promise.all([firstPlaying, secondPlaying, spectatorPlaying]);
  assert.equal(firstView.players.every((player) => player.hand.length === 7), true);
  assert.equal(spectatorView.players.every((player) => player.hand.length === 7), true);

  // A spectator receives a complete view but cannot affect a live game.
  const forgedCardId = spectatorView.players[0].hand[0].id;
  spectator.emit('confirm_card', { roomId, cardId: forgedCardId });
  spectator.emit('forfeit_game', { roomId });
  spectatorView = await requestCurrentRoom(spectator, roomId, spectatorClientId, '観戦者', { joinAsSpectator: true });
  assert.equal(spectatorView.gameState, 'playing');
  assert.equal(spectatorView.history.length, 0);
  assert.equal(spectatorView.round, 1);

  const firstCardId = ownPlayer(firstView, first).hand[0].id;
  const firstSelected = waitForRoom(first, roomId, (room) => room.viewer.hasConfirmedSelection === true);
  first.emit('confirm_card', { roomId, cardId: firstCardId });
  first.emit('confirm_card', { roomId, cardId: firstCardId });
  firstView = await firstSelected;
  assert.equal(firstView.history.length, 0);

  secondView = await requestCurrentRoom(second, roomId, secondClientId, '後手');
  const secondCardId = ownPlayer(secondView, second).hand[0].id;
  const firstResolved = waitForRoom(first, roomId, (room) => room.round === 2 && room.history.length === 1);
  const secondResolved = waitForRoom(second, roomId, (room) => room.round === 2 && room.history.length === 1);
  const spectatorResolved = waitForRoom(spectator, roomId, (room) => room.round === 2 && room.history.length === 1);
  second.emit('confirm_card', { roomId, cardId: secondCardId });
  [firstView, secondView, spectatorView] = await Promise.all([firstResolved, secondResolved, spectatorResolved]);
  assert.equal(firstView.players.every((player) => player.hand.length === 6), true);
  assert.deepEqual(firstView.history, secondView.history);
  assert.deepEqual(firstView.history, spectatorView.history);

  // Message delivery also crosses the real room-membership boundary.
  const spectatorMessage = waitForEvent(spectator, 'chat_message', (message) => message?.text === '接続テスト');
  const chatResult = await emitWithAcknowledgement(second, 'send_chat', { message: '接続テスト' });
  assert.equal(chatResult.ok, true);
  assert.equal((await spectatorMessage).isOwn, false);

  // A browser reload uses the same durable client id.  The live game pauses,
  // then resumes with the existing hand and round rather than resetting.
  const secondReconnecting = waitForRoom(second, roomId, (room) => room.gameState === 'reconnecting');
  const disconnectedFirstSocketId = first.id;
  first.disconnect();
  secondView = await secondReconnecting;
  assert.ok(secondView.reconnectDeadline > Date.now());
  assert.equal(secondView.players.find((player) => player.suit === '♠').connected, false);

  const returningFirst = await connectClient(port);
  clients.push(returningFirst);
  const secondResumed = waitForRoom(second, roomId, (room) => room.gameState === 'playing' && room.round === 2);
  const returnedView = await joinRoom(returningFirst, roomId, firstClientId, '先手・復帰');
  secondView = await secondResumed;
  assert.equal(returnedView.gameState, 'playing');
  assert.equal(returnedView.history.length, 1);
  assert.equal(ownPlayer(returnedView, returningFirst).hand.length, 6);
  assert.equal(returnedView.players.some((player) => player.id === disconnectedFirstSocketId), false);
  assert.equal(returnedView.players.some((player) => player.id === returningFirst.id), true);
  assert.equal(secondView.players.every((player) => player.hand.length === 6), true);

  // Ordered spectator opt-in is applied through the live event path.  When a
  // player deliberately becomes a spectator, the queued spectator alone is
  // promoted into the newly available seat.
  const spectatorQueued = waitForRoom(spectator, roomId, (room) => room.viewer.autoJoinWhenSeatAvailable === true);
  spectator.emit('set_spectator_auto_join', { roomId, enabled: true });
  spectatorView = await spectatorQueued;
  assert.equal(spectatorView.viewer.seatQueuePosition, 1);

  const spectatorPromoted = waitForRoom(spectator, roomId, (room) => room.viewer.isSpectator === false && room.players.length === 2);
  second.emit('switch_to_spectator', { roomId });
  spectatorView = await spectatorPromoted;
  assert.equal(spectatorView.gameState, 'waiting');
  assert.equal(spectatorView.players.length, 2);
  assert.equal(spectatorView.spectatorCount, 1);
  assert.equal(ownPlayer(spectatorView, spectator).name, '観戦者');
  assert.equal(ownPlayer(spectatorView, spectator).suit, '♥');

  // Random Match has a separate recovery path: when one participant leaves,
  // the other must leave the closed room and be paired with the next eligible
  // waiting client instead of being stranded in a private-only room.
  const randomFirst = await connectClient(port);
  const randomSecond = await connectClient(port);
  const randomThird = await connectClient(port);
  clients.push(randomFirst, randomSecond, randomThird);
  const randomFirstClientId = 'socket-random-first';
  const randomSecondClientId = 'socket-random-second';
  const randomThirdClientId = 'socket-random-third';

  assert.equal((await emitWithAcknowledgement(randomFirst, 'join_random_match', {
    clientId: randomFirstClientId,
    playerName: 'ランダム先手',
    requestId: 'socket-random-request-1'
  })).ok, true);
  const firstRandomMatch = waitForEvent(randomFirst, 'room_updated', (room) => room?.matchType === 'random' && room.players.length === 2);
  const secondRandomMatch = waitForEvent(randomSecond, 'room_updated', (room) => room?.matchType === 'random' && room.players.length === 2);
  assert.equal((await emitWithAcknowledgement(randomSecond, 'join_random_match', {
    clientId: randomSecondClientId,
    playerName: 'ランダム後手',
    requestId: 'socket-random-request-2'
  })).ok, true);
  const [randomFirstView, randomSecondView] = await Promise.all([firstRandomMatch, secondRandomMatch]);
  const firstRandomRoomId = randomFirstView.id;
  assert.equal(randomSecondView.id, firstRandomRoomId);

  const randomSpectatorError = waitForEvent(randomFirst, 'room_error', (event) => event?.message?.includes('観戦者に切り替えられません'));
  randomFirst.emit('switch_to_spectator', { roomId: firstRandomRoomId });
  await randomSpectatorError;
  const randomViewAfterRejectedSwitch = await requestCurrentRoom(randomFirst, firstRandomRoomId, randomFirstClientId, 'ランダム先手');
  assert.equal(randomViewAfterRejectedSwitch.viewer.isSpectator, false);
  assert.equal(randomViewAfterRejectedSwitch.players.length, 2);

  // Queue a third player before the first opponent leaves. The remaining
  // player must automatically receive a new random room with that third
  // client, not a waiting view of the old room.
  assert.equal((await emitWithAcknowledgement(randomThird, 'join_random_match', {
    clientId: randomThirdClientId,
    playerName: '次の相手',
    requestId: 'socket-random-request-3'
  })).ok, true);
  const interrupted = waitForEvent(randomFirst, 'random_match_interrupted', (event) => event?.roomId === firstRandomRoomId && event.state === 'searching');
  const firstRematched = waitForEvent(randomFirst, 'room_updated', (room) => room?.matchType === 'random' && room.id !== firstRandomRoomId && room.players.length === 2);
  const thirdMatched = waitForEvent(randomThird, 'room_updated', (room) => room?.matchType === 'random' && room.id !== firstRandomRoomId && room.players.length === 2);
  randomSecond.emit('leave_room', { roomId: firstRandomRoomId });
  assert.equal((await interrupted).state, 'searching');
  const [randomFirstRematchedView, randomThirdView] = await Promise.all([firstRematched, thirdMatched]);
  assert.equal(randomFirstRematchedView.id, randomThirdView.id);
  assert.notEqual(randomFirstRematchedView.id, firstRandomRoomId);
  assert.deepEqual(
    randomFirstRematchedView.players.map((player) => player.name).sort(),
    ['ランダム先手', '次の相手'].sort()
  );
});
