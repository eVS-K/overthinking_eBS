const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createInitialHand, resolveRound } = require('./game-rules');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] }
});

const TURN_TIME_LIMIT_MS = 90_000;
const RECONNECT_GRACE_MS = 30_000;
const MAX_ROOM_ID_LENGTH = 24;
const MAX_PLAYER_NAME_LENGTH = 20;

const rooms = new Map();
const roomTimers = new Map();
const disconnectTimers = new Map();

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));
app.get(['/index.html', '/main.js', '/style.css'], (request, response) => {
  response.sendFile(path.join(__dirname, request.path));
});
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/health', (_request, response) => response.json({ status: 'ok' }));

function normalizeText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLength) || fallback;
}

function createRoom(id) {
  return {
    id,
    players: [],
    spectators: [],
    round: 1,
    stack: [],
    history: [],
    lastRound: null,
    gameState: 'waiting',
    selections: {},
    deadline: 0,
    pausedRemainingMs: TURN_TIME_LIMIT_MS,
    winner: null,
    needsFreshGame: false
  };
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function getTimerKey(roomId, clientId) {
  return `${roomId}:${clientId}`;
}

function clearTurnTimer(roomId) {
  const timer = roomTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomTimers.delete(roomId);
}

function clearDisconnectTimer(roomId, clientId) {
  const key = getTimerKey(roomId, clientId);
  const timer = disconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  disconnectTimers.delete(key);
}

function resetGame(room) {
  clearTurnTimer(room.id);
  room.round = 1;
  room.stack = [];
  room.history = [];
  room.lastRound = null;
  room.selections = {};
  room.deadline = 0;
  room.pausedRemainingMs = TURN_TIME_LIMIT_MS;
  room.winner = null;
  room.players.forEach((player) => {
    player.hand = createInitialHand();
    player.score = 0;
  });
}

function startNewGame(room) {
  resetGame(room);
  room.needsFreshGame = false;
  if (room.players.length === 2 && room.players.every((player) => player.connected)) {
    room.gameState = 'playing';
    startTurnTimer(room);
  } else {
    room.gameState = 'waiting';
  }
}

function startTurnTimer(room, durationMs = TURN_TIME_LIMIT_MS) {
  clearTurnTimer(room.id);
  if (room.gameState !== 'playing' || room.players.length !== 2 || !room.players.every((player) => player.connected)) return;

  const safeDuration = Math.max(0, Math.min(durationMs, TURN_TIME_LIMIT_MS));
  room.deadline = Date.now() + safeDuration;
  room.pausedRemainingMs = safeDuration;

  roomTimers.set(room.id, setTimeout(() => {
    const latestRoom = getRoom(room.id);
    if (!latestRoom || latestRoom.gameState !== 'playing') return;

    latestRoom.players.forEach((player) => {
      if (!latestRoom.selections[player.id] && player.hand.length > 0) {
        const index = Math.floor(Math.random() * player.hand.length);
        latestRoom.selections[player.id] = player.hand[index].id;
      }
    });
    processTurn(latestRoom);
  }, safeDuration));
}

function pauseForReconnect(room) {
  if (room.gameState !== 'playing') return;
  room.pausedRemainingMs = Math.max(0, room.deadline - Date.now());
  room.deadline = 0;
  room.gameState = 'reconnecting';
  clearTurnTimer(room.id);
}

function createRoomView(room, socketId) {
  const player = room.players.find((candidate) => candidate.id === socketId);
  const isSpectator = !player;

  return {
    id: room.id,
    players: room.players.map(({ id, name, suit, hand, score, connected }) => ({
      id,
      name,
      suit,
      hand,
      score,
      connected
    })),
    spectatorCount: room.spectators.length,
    round: room.round,
    stack: room.stack,
    history: room.history,
    lastRound: room.lastRound,
    gameState: room.gameState,
    deadline: room.deadline,
    winner: room.winner,
    viewer: {
      isSpectator,
      hasConfirmedSelection: Boolean(player && room.selections[player.id])
    }
  };
}

function broadcastRoom(room) {
  const members = io.sockets.adapter.rooms.get(room.id);
  if (!members) return;
  members.forEach((socketId) => {
    const member = io.sockets.sockets.get(socketId);
    if (member) member.emit('room_updated', createRoomView(room, socketId));
  });
}

function emitError(socket, message) {
  socket.emit('room_error', { message });
}

function processTurn(room) {
  clearTurnTimer(room.id);
  if (room.gameState !== 'playing' || room.players.length !== 2) return;

  const [firstPlayer, secondPlayer] = room.players;
  const firstCardId = room.selections[firstPlayer.id];
  const secondCardId = room.selections[secondPlayer.id];
  const firstIndex = firstPlayer.hand.findIndex((card) => card.id === firstCardId);
  const secondIndex = secondPlayer.hand.findIndex((card) => card.id === secondCardId);

  // サーバー側でカードを再検証する。状態が壊れても別のカードを消費しない。
  if (firstIndex < 0 || secondIndex < 0) {
    room.selections = {};
    startTurnTimer(room, TURN_TIME_LIMIT_MS);
    broadcastRoom(room);
    return;
  }

  const [firstCard] = firstPlayer.hand.splice(firstIndex, 1);
  const [secondCard] = secondPlayer.hand.splice(secondIndex, 1);
  const result = resolveRound(firstCard, secondCard);
  const awardedCards = 2 + room.stack.length;

  let roundWinner = 'Draw';
  if (result === 'p1') {
    firstPlayer.score += awardedCards;
    roundWinner = firstPlayer.name;
    room.stack = [];
  } else if (result === 'p2') {
    secondPlayer.score += awardedCards;
    roundWinner = secondPlayer.name;
    room.stack = [];
  } else {
    room.stack.push(firstCard, secondCard);
  }

  const resultRecord = {
    id: `${room.round}-${Date.now()}`,
    round: room.round,
    p1Card: firstCard,
    p2Card: secondCard,
    winner: roundWinner,
    awardedCards: result === 'draw' ? 0 : awardedCards
  };
  room.history.push(resultRecord);
  room.lastRound = resultRecord;
  room.selections = {};
  room.deadline = 0;

  if (firstPlayer.score > 8 || secondPlayer.score > 8 || room.round >= 7) {
    room.gameState = 'finished';
    room.winner = firstPlayer.score === secondPlayer.score
      ? '引き分け'
      : firstPlayer.score > secondPlayer.score ? firstPlayer.name : secondPlayer.name;
  } else {
    room.round += 1;
    startTurnTimer(room);
  }

  broadcastRoom(room);
}

function removePlayerAfterGrace(roomId, clientId) {
  const room = getRoom(roomId);
  if (!room) return;
  const playerIndex = room.players.findIndex((player) => player.clientId === clientId && !player.connected);
  if (playerIndex < 0) return;

  room.players.splice(playerIndex, 1);
  room.needsFreshGame = true;
  resetGame(room);
  room.gameState = 'waiting';

  // 空いた席にすでに観戦者がいれば、先着順で次の対戦者にする。
  // 中断された対局の手札・得点は resetGame で必ず初期化済み。
  while (room.players.length < 2 && room.spectators.length > 0) {
    const spectator = room.spectators.shift();
    const spectatorSocket = io.sockets.sockets.get(spectator.id);
    if (!spectatorSocket) continue;
    room.players.push({
      id: spectator.id,
      clientId: spectator.clientId,
      name: spectator.name,
      suit: room.players.length === 0 ? '♠' : '♥',
      hand: createInitialHand(),
      score: 0,
      connected: true
    });
  }

  if (room.players.length === 0) {
    rooms.delete(roomId);
    return;
  }
  if (room.players.length === 2) startNewGame(room);
  broadcastRoom(room);
}

function scheduleDisconnectRemoval(room, player) {
  clearDisconnectTimer(room.id, player.clientId);
  const key = getTimerKey(room.id, player.clientId);
  disconnectTimers.set(key, setTimeout(() => {
    disconnectTimers.delete(key);
    removePlayerAfterGrace(room.id, player.clientId);
  }, RECONNECT_GRACE_MS));
}

io.on('connection', (socket) => {
  socket.on('join_room', (payload = {}) => {
    const roomId = normalizeText(payload.roomId, MAX_ROOM_ID_LENGTH);
    const playerName = normalizeText(payload.playerName, MAX_PLAYER_NAME_LENGTH, 'Player');
    const clientId = normalizeText(payload.clientId, 80);

    if (!roomId || !clientId) {
      emitError(socket, '部屋キーを確認してから、もう一度入室してください。');
      return;
    }

    socket.join(roomId);
    let room = getRoom(roomId);
    if (!room) {
      room = createRoom(roomId);
      rooms.set(roomId, room);
    }

    const returningPlayer = room.players.find((player) => player.clientId === clientId);
    if (returningPlayer) {
      const previousSocketId = returningPlayer.id;
      clearDisconnectTimer(room.id, clientId);
      returningPlayer.id = socket.id;
      returningPlayer.name = playerName;
      returningPlayer.connected = true;
      if (room.selections[previousSocketId]) {
        room.selections[socket.id] = room.selections[previousSocketId];
        delete room.selections[previousSocketId];
      }
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket && previousSocketId !== socket.id) previousSocket.disconnect(true);

      if (room.gameState === 'reconnecting' && room.players.every((player) => player.connected)) {
        room.gameState = 'playing';
        startTurnTimer(room, room.pausedRemainingMs);
      }
    } else if (room.players.length < 2) {
      room.players.push({
        id: socket.id,
        clientId,
        name: playerName,
        suit: room.players.length === 0 ? '♠' : '♥',
        hand: createInitialHand(),
        score: 0,
        connected: true
      });

      if (room.players.length === 2) startNewGame(room);
    } else if (!room.spectators.some((spectator) => spectator.id === socket.id)) {
      room.spectators.push({ id: socket.id, clientId, name: playerName });
    }

    broadcastRoom(room);
  });

  socket.on('confirm_card', (payload = {}) => {
    const room = getRoom(payload.roomId);
    if (!room || room.gameState !== 'playing') return;

    const player = room.players.find((candidate) => candidate.id === socket.id);
    if (!player || !player.connected || room.selections[player.id]) return;
    if (typeof payload.cardId !== 'string' || !player.hand.some((card) => card.id === payload.cardId)) {
      emitError(socket, 'そのカードは選択できません。もう一度選んでください。');
      return;
    }

    room.selections[player.id] = payload.cardId;
    if (room.players.every((candidate) => room.selections[candidate.id])) {
      processTurn(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('restart_game', (payload = {}) => {
    const room = getRoom(payload.roomId);
    if (!room || room.gameState !== 'finished') return;
    if (!room.players.some((player) => player.id === socket.id)) return;
    if (!room.players.every((player) => player.connected)) return;
    startNewGame(room);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find((candidate) => candidate.id === socket.id);
      if (player) {
        player.connected = false;
        pauseForReconnect(room);
        scheduleDisconnectRemoval(room, player);
        broadcastRoom(room);
        return;
      }

      const spectatorIndex = room.spectators.findIndex((spectator) => spectator.id === socket.id);
      if (spectatorIndex >= 0) {
        room.spectators.splice(spectatorIndex, 1);
        broadcastRoom(room);
        return;
      }
    }
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
