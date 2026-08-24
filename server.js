const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createInitialHand, resolveRound } = require('./game-rules');
const { createFixedWindowLimiter, getClientIp, readPositiveInteger } = require('./security');
const { MAX_CHAT_MESSAGES_PER_SESSION, appendChatMessage } = require('./chat');
const { registerRankedRoutes } = require('./ranked-api');
const { createRankedRuntime, startRankedDeadlineSweeper } = require('./ranked-runtime');

const app = express();
const server = http.createServer(app);

const TURN_TIME_LIMIT_MS = 90_000;
const RECONNECT_GRACE_MS = 30_000;
const MAX_ROOM_ID_LENGTH = 24;
const MAX_PLAYER_NAME_LENGTH = 20;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://evs-k.github.io',
  'https://overthinking-ebs.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const MAX_ACTIVE_ROOMS = readPositiveInteger(process.env.MAX_ACTIVE_ROOMS, 300, { max: 5_000 });
const MAX_SPECTATORS_PER_ROOM = readPositiveInteger(process.env.MAX_SPECTATORS_PER_ROOM, 40, { max: 500 });
const MAX_SOCKETS_PER_IP = readPositiveInteger(process.env.MAX_SOCKETS_PER_IP, 32, { max: 500 });
const MAX_HTTP_CONNECTIONS = readPositiveInteger(process.env.MAX_HTTP_CONNECTIONS, 800, { max: 10_000 });
const RATE_LIMIT_TRACKED_IPS = readPositiveInteger(process.env.RATE_LIMIT_TRACKED_IPS, 5_000, { max: 50_000 });
const SOCKET_EVENT_LIMIT = readPositiveInteger(process.env.SOCKET_EVENT_LIMIT, 24, { max: 1_000 });
const SOCKET_EVENT_WINDOW_MS = 10_000;
const MAX_CHAT_SESSIONS_PER_ROOM = 128;
const CHAT_SESSION_RETENTION_MS = 30 * 60_000;
const ALLOW_ORIGINLESS_SOCKET_CONNECTIONS = process.env.ALLOW_ORIGINLESS_SOCKET_CONNECTIONS === 'true'
  && process.env.NODE_ENV !== 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

function getRequestIp(request) {
  return getClientIp(request, { trustProxy: TRUST_PROXY });
}

function normalizeOrigin(value) {
  if (typeof value !== 'string') return '';
  try {
    return new URL(value.trim()).origin;
  } catch {
    return '';
  }
}

const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean));

function isAllowedOrigin(origin) {
  if (!origin) return ALLOW_ORIGINLESS_SOCKET_CONNECTIONS;
  return allowedOrigins.has(normalizeOrigin(origin));
}

const rooms = new Map();
const roomTimers = new Map();
const disconnectTimers = new Map();
const activeSocketsByIp = new Map();
const httpRequestLimiter = createFixedWindowLimiter({
  limit: 240,
  windowMs: 60_000,
  maxEntries: RATE_LIMIT_TRACKED_IPS
});
const handshakeLimiter = createFixedWindowLimiter({
  limit: 40,
  windowMs: 60_000,
  maxEntries: RATE_LIMIT_TRACKED_IPS
});
const roomCreationLimiter = createFixedWindowLimiter({
  limit: 10,
  windowMs: 10 * 60_000,
  maxEntries: RATE_LIMIT_TRACKED_IPS
});

const limiterCleanupTimer = setInterval(() => {
  httpRequestLimiter.prune();
  handshakeLimiter.prune();
  roomCreationLimiter.prune();
}, 60_000);
limiterCleanupTimer.unref();

function activeSocketCount(ip) {
  return activeSocketsByIp.get(ip) || 0;
}

function trackSocket(ip) {
  activeSocketsByIp.set(ip, activeSocketCount(ip) + 1);
}

function untrackSocket(ip) {
  const nextCount = activeSocketCount(ip) - 1;
  if (nextCount > 0) activeSocketsByIp.set(ip, nextCount);
  else activeSocketsByIp.delete(ip);
}

function allowSocketRequest(request, callback) {
  const origin = request.headers.origin;
  const ip = getRequestIp(request);
  if (!isAllowedOrigin(origin)) return callback('Origin is not allowed', false);
  if (!handshakeLimiter.consume(ip)) return callback('Too many connection attempts', false);
  if (activeSocketCount(ip) >= MAX_SOCKETS_PER_IP) return callback('Too many active connections', false);
  return callback(null, true);
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST'],
    credentials: false
  },
  allowRequest: allowSocketRequest,
  maxHttpBufferSize: 16 * 1024,
  httpCompression: false,
  perMessageDeflate: false
});

server.maxConnections = MAX_HTTP_CONNECTIONS;
server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://cdn.socket.io; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'"
  );
  if (process.env.NODE_ENV === 'production') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (!httpRequestLimiter.consume(getRequestIp(request))) {
    response.setHeader('Retry-After', '60');
    response.status(429).type('text').send('Too Many Requests');
    return;
  }
  next();
});

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));
app.get(['/index.html', '/main.js', '/oauth-recovery.js', '/style.css'], (request, response) => {
  response.sendFile(path.join(__dirname, request.path));
});
// Ranked/Auth lives on the backend origin so the opaque session cookie is never
// exposed to the GitHub Pages legacy client.  The legacy PvP entry point above
// remains deliberately unchanged and continues to work without an account.
app.get('/ranked', (_request, response) => response.sendFile(path.join(__dirname, 'ranked.html')));
app.get(['/ranked.html', '/ranked-client.js', '/ranked.css'], (request, response) => {
  response.sendFile(path.join(__dirname, request.path));
});
app.use('/images', express.static(path.join(__dirname, 'images')));
const rankedRuntime = createRankedRuntime();
const rankedDeadlineSweeper = startRankedDeadlineSweeper(rankedRuntime);
registerRankedRoutes(app, { runtime: rankedRuntime, getClientIp: getRequestIp });

app.get('/health', (_request, response) => response.json({ status: 'ok', ranked: rankedRuntime.available ? 'available' : 'unavailable' }));

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
    needsFreshGame: false,
    chat: [],
    chatUsage: new Map(),
    chatSequence: 0
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

function getBoundRoom(socket, suppliedRoomId) {
  const roomId = normalizeText(suppliedRoomId, MAX_ROOM_ID_LENGTH);
  if (!roomId || socket.data.roomId !== roomId) return null;
  return getRoom(roomId);
}

function consumeSocketEvent(socket) {
  const now = Date.now();
  const state = socket.data.eventRate || { count: 0, resetAt: now + SOCKET_EVENT_WINDOW_MS };
  if (state.resetAt <= now) {
    state.count = 0;
    state.resetAt = now + SOCKET_EVENT_WINDOW_MS;
  }
  if (state.count >= SOCKET_EVENT_LIMIT) return false;
  state.count += 1;
  socket.data.eventRate = state;
  return true;
}

function getParticipant(room, socketId) {
  return room.players.find((player) => player.id === socketId)
    || room.spectators.find((spectator) => spectator.id === socketId)
    || null;
}

function pruneChatUsage(room, now = Date.now()) {
  const activeClientIds = new Set([
    ...room.players.map((player) => player.clientId),
    ...room.spectators.map((spectator) => spectator.clientId)
  ]);
  for (const [clientId, usage] of room.chatUsage) {
    if (!activeClientIds.has(clientId) && now - usage.lastSeenAt >= CHAT_SESSION_RETENTION_MS) {
      room.chatUsage.delete(clientId);
    }
  }
}

function emitChatState(socket, room, clientId) {
  pruneChatUsage(room);
  const usage = room.chatUsage.get(clientId);
  socket.emit('chat_state', {
    messages: room.chat,
    sent: usage?.count || 0,
    limit: MAX_CHAT_MESSAGES_PER_SESSION
  });
}

function replyToChat(acknowledge, result) {
  if (typeof acknowledge === 'function') acknowledge(result);
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

function resetAfterPlayerDeparture(room, playerIndex) {
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
    rooms.delete(room.id);
    return false;
  }
  if (room.players.length === 2) startNewGame(room);
  broadcastRoom(room);
  return true;
}

function removePlayerAfterGrace(roomId, clientId) {
  const room = getRoom(roomId);
  if (!room) return;
  const playerIndex = room.players.findIndex((player) => player.clientId === clientId && !player.connected);
  if (playerIndex < 0) return;
  resetAfterPlayerDeparture(room, playerIndex);
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
  const clientIp = getRequestIp(socket.handshake);
  if (activeSocketCount(clientIp) >= MAX_SOCKETS_PER_IP) {
    socket.disconnect(true);
    return;
  }

  trackSocket(clientIp);
  socket.data.clientIp = clientIp;
  socket.use((_event, next) => {
    if (consumeSocketEvent(socket)) {
      next();
      return;
    }
    emitError(socket, '短時間に多くの操作が送信されました。少し待ってから再接続してください。');
    socket.disconnect(true);
  });

  socket.on('join_room', (payload = {}) => {
    const roomId = normalizeText(payload.roomId, MAX_ROOM_ID_LENGTH);
    const playerName = normalizeText(payload.playerName, MAX_PLAYER_NAME_LENGTH, 'Player');
    const clientId = normalizeText(payload.clientId, 80);

    if (!roomId || !clientId) {
      emitError(socket, '部屋キーを確認してから、もう一度入室してください。');
      return;
    }

    if (socket.data.roomId) {
      const currentRoom = getRoom(socket.data.roomId);
      if (socket.data.roomId === roomId && currentRoom) {
        socket.emit('room_updated', createRoomView(currentRoom, socket.id));
        emitChatState(socket, currentRoom, socket.data.clientId);
        return;
      }
      emitError(socket, '一度に参加できる部屋は一つです。ホームへ戻ってから別の部屋に入室してください。');
      return;
    }

    let room = getRoom(roomId);
    if (!room) {
      if (rooms.size >= MAX_ACTIVE_ROOMS) {
        emitError(socket, '現在、多くの部屋が使用中です。少し待ってから入室してください。');
        return;
      }
      if (!roomCreationLimiter.consume(socket.data.clientIp)) {
        emitError(socket, '部屋の作成回数が上限に達しました。時間をおいて再試行してください。');
        return;
      }
      room = createRoom(roomId);
      rooms.set(roomId, room);
    }

    const returningPlayer = room.players.find((player) => player.clientId === clientId);
    const returningSpectator = room.spectators.find((spectator) => spectator.clientId === clientId);
    if (!returningPlayer && !returningSpectator && room.players.length >= 2 && room.spectators.length >= MAX_SPECTATORS_PER_ROOM) {
      emitError(socket, 'この部屋の観戦者数は上限に達しています。');
      return;
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.clientId = clientId;

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
    } else if (returningSpectator) {
      const previousSocketId = returningSpectator.id;
      returningSpectator.id = socket.id;
      returningSpectator.name = playerName;
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket && previousSocketId !== socket.id) previousSocket.disconnect(true);
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
    } else {
      room.spectators.push({ id: socket.id, clientId, name: playerName });
    }

    broadcastRoom(room);
    emitChatState(socket, room, clientId);
  });

  socket.on('send_chat', (payload = {}, acknowledge) => {
    const room = getRoom(socket.data.roomId);
    const participant = room && getParticipant(room, socket.id);
    if (!room || !participant) {
      replyToChat(acknowledge, { ok: false, message: 'チャットに参加していません。' });
      return;
    }

    const now = Date.now();
    pruneChatUsage(room, now);
    if (!room.chatUsage.has(participant.clientId) && room.chatUsage.size >= MAX_CHAT_SESSIONS_PER_ROOM) {
      replyToChat(acknowledge, { ok: false, message: 'この部屋では新しいチャット参加を受け付けられません。' });
      return;
    }

    const result = appendChatMessage(room, {
      clientId: participant.clientId,
      author: participant.name,
      text: payload?.message,
      now
    });
    if (!result.ok) {
      replyToChat(acknowledge, { ok: false, message: result.error });
      return;
    }

    io.to(room.id).emit('chat_message', result.message);
    replyToChat(acknowledge, { ok: true, sent: result.sent, limit: result.limit });
  });

  socket.on('confirm_card', (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room || room.gameState !== 'playing') return;

    const player = room.players.find((candidate) => candidate.id === socket.id);
    if (!player || !player.connected || room.selections[player.id]) return;
    const cardId = normalizeText(payload.cardId, 40);
    if (!cardId || !player.hand.some((card) => card.id === cardId)) {
      emitError(socket, 'そのカードは選択できません。もう一度選んでください。');
      return;
    }

    room.selections[player.id] = cardId;
    if (room.players.every((candidate) => room.selections[candidate.id])) {
      processTurn(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('restart_game', (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room || room.gameState !== 'finished') return;
    if (!room.players.some((player) => player.id === socket.id)) return;
    if (!room.players.every((player) => player.connected)) return;
    startNewGame(room);
    broadcastRoom(room);
  });

  socket.on('leave_room', (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room) return;
    socket.leave(room.id);
    socket.data.roomId = undefined;

    const playerIndex = room.players.findIndex((player) => player.id === socket.id);
    if (playerIndex >= 0) {
      const [player] = room.players.slice(playerIndex, playerIndex + 1);
      clearDisconnectTimer(room.id, player.clientId);
      resetAfterPlayerDeparture(room, playerIndex);
    } else {
      const spectatorIndex = room.spectators.findIndex((spectator) => spectator.id === socket.id);
      if (spectatorIndex >= 0) {
        room.spectators.splice(spectatorIndex, 1);
        broadcastRoom(room);
      }
    }
  });

  socket.on('disconnect', () => {
    untrackSocket(socket.data.clientIp);
    const room = getRoom(socket.data.roomId);
    if (!room) return;

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
    }
  });
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
}

module.exports = { app, server, io, rankedRuntime, rankedDeadlineSweeper };
