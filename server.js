const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createInitialHand, resolveRound } = require('./game-rules');
const { createFixedWindowLimiter, getClientIp, readPositiveInteger } = require('./security');
const { MAX_CHAT_MESSAGES_PER_SESSION, appendChatMessage } = require('./chat');
const { RandomMatchQueue } = require('./matchmaking');
const { registerRankedRoutes } = require('./ranked-api');
const { createRankedRuntime, startRankedDeadlineSweeper } = require('./ranked-runtime');

const app = express();
const server = http.createServer(app);

const TURN_TIME_LIMIT_MS = 90_000;
const RECONNECT_GRACE_MS = 30_000;
const MAX_ROOM_ID_LENGTH = 24;
const MAX_PLAYER_NAME_LENGTH = 20;
function buildDefaultAllowedOrigins(environment = process.env) {
  const origins = [
    'https://evs-k.github.io',
    'https://overthinking-ebs.onrender.com'
  ];
  // An omitted NODE_ENV must not quietly make a deployment accept localhost.
  // Local origins are only a deliberate development/test convenience.
  if (environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test') {
    origins.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  return origins;
}

const DEFAULT_ALLOWED_ORIGINS = buildDefaultAllowedOrigins();

const MAX_ACTIVE_ROOMS = readPositiveInteger(process.env.MAX_ACTIVE_ROOMS, 300, { max: 5_000 });
const MAX_SPECTATORS_PER_ROOM = readPositiveInteger(process.env.MAX_SPECTATORS_PER_ROOM, 40, { max: 500 });
const MAX_SOCKETS_PER_IP = readPositiveInteger(process.env.MAX_SOCKETS_PER_IP, 32, { max: 500 });
const MAX_HTTP_CONNECTIONS = readPositiveInteger(process.env.MAX_HTTP_CONNECTIONS, 800, { max: 10_000 });
const RATE_LIMIT_TRACKED_IPS = readPositiveInteger(process.env.RATE_LIMIT_TRACKED_IPS, 5_000, { max: 50_000 });
const SOCKET_EVENT_LIMIT = readPositiveInteger(process.env.SOCKET_EVENT_LIMIT, 24, { max: 1_000 });
const SOCKET_EVENT_WINDOW_MS = 10_000;
const MAX_CHAT_SESSIONS_PER_ROOM = 128;
const CHAT_SESSION_RETENTION_MS = 30 * 60_000;
// Guest PvP intentionally has no login.  A client-controlled reconnect id is
// useful for reconnecting, but cannot be the only anti-abuse key; bound chat
// volume per room/IP as a second line of defense without making two ordinary
// players on the same network hit the 50-message per-session limit.
const MAX_CHAT_MESSAGES_PER_IP_WINDOW = 120;
const CHAT_IP_WINDOW_MS = 30 * 60_000;
const MAX_CHAT_IPS_PER_ROOM = 256;
const MAX_RANDOM_MATCH_QUEUE = readPositiveInteger(process.env.MAX_RANDOM_MATCH_QUEUE, 300, { max: 5_000 });
const MAX_RANDOM_QUEUE_PER_IP = readPositiveInteger(process.env.MAX_RANDOM_QUEUE_PER_IP, 3, { max: 20 });
const RANDOM_MATCH_REQUEST_LIMIT = readPositiveInteger(process.env.RANDOM_MATCH_REQUEST_LIMIT, 18, { max: 120 });
const RANDOM_MATCH_REQUEST_WINDOW_MS = 60_000;
const RANDOM_MATCH_ENTRY_MAX_AGE_MS = 10 * 60_000;
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
const randomMatchLimiter = createFixedWindowLimiter({
  limit: RANDOM_MATCH_REQUEST_LIMIT,
  windowMs: RANDOM_MATCH_REQUEST_WINDOW_MS,
  maxEntries: RATE_LIMIT_TRACKED_IPS
});
const randomMatchQueue = new RandomMatchQueue({
  maxEntries: MAX_RANDOM_MATCH_QUEUE,
  maxAgeMs: RANDOM_MATCH_ENTRY_MAX_AGE_MS
});

const limiterCleanupTimer = setInterval(() => {
  httpRequestLimiter.prune();
  handshakeLimiter.prune();
  roomCreationLimiter.prune();
  randomMatchLimiter.prune();
  if (randomMatchQueue.prune() > 0) schedulePresenceBroadcast();
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
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://overthinking-ebs.onrender.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'"
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
app.get(['/index.html', '/main.js', '/oauth-recovery.js', '/socket-loader.js', '/style.css'], (request, response) => {
  response.sendFile(path.join(__dirname, request.path));
});
// Ranked/Auth lives on the backend origin so the opaque session cookie is never
// exposed to the GitHub Pages legacy client.  The legacy PvP entry point above
// remains deliberately unchanged and continues to work without an account.
app.get('/ranked', (_request, response) => response.sendFile(path.join(__dirname, 'ranked.html')));
app.get(['/ranked.html', '/ranked-client.js', '/ranked-ui.js', '/ranked.css'], (request, response) => {
  response.sendFile(path.join(__dirname, request.path));
});
app.use('/images', express.static(path.join(__dirname, 'images')));
const rankedRuntime = createRankedRuntime();
const rankedDeadlineSweeper = startRankedDeadlineSweeper(rankedRuntime);
registerRankedRoutes(app, { runtime: rankedRuntime, getClientIp: getRequestIp });

app.get('/health', (_request, response) => response.json({ status: 'ok', ranked: rankedRuntime.available ? 'available' : 'unavailable' }));

function normalizeText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/[\u0000-\u001F\u007F]/g, '').replace(/\p{Cf}/gu, '').slice(0, maxLength) || fallback;
}

function normalizeJoinPreferences(payload) {
  // Spectating and automatic seat-taking are explicit opt-ins.  Do not treat
  // truthy strings from an untrusted client as consent to change roles.
  const joinAsSpectator = payload?.joinAsSpectator === true;
  return {
    joinAsSpectator,
    autoJoinWhenSeatAvailable: joinAsSpectator && payload?.autoJoinWhenSeatAvailable === true
  };
}

function createPlayer({ id, clientId, name }, seatIndex) {
  return {
    id,
    clientId,
    name,
    suit: seatIndex === 0 ? '♠' : '♥',
    hand: createInitialHand(),
    score: 0,
    connected: true
  };
}

function promoteVolunteerSpectators(room, getSocketById = (socketId) => io.sockets.sockets.get(socketId)) {
  let promoted = 0;
  while (room.players.length < 2) {
    const spectatorIndex = room.spectators.findIndex((spectator) => spectator.autoJoinWhenSeatAvailable === true);
    if (spectatorIndex < 0) break;
    const spectator = room.spectators[spectatorIndex];
    const spectatorSocket = getSocketById(spectator.id);
    // A disconnected spectator should have been removed by the socket handler,
    // but discard a stale entry rather than blocking volunteers behind it.
    room.spectators.splice(spectatorIndex, 1);
    if (!spectatorSocket) continue;
    room.players.push(createPlayer(spectator, room.players.length));
    promoted += 1;
  }
  return promoted;
}

function createRoom(id, { matchType = 'private', allowedRandomClientIds = [] } = {}) {
  return {
    id,
    matchType: matchType === 'random' ? 'random' : 'private',
    // Random-room ids are unguessable, and this extra admission list prevents
    // a copied id from becoming an accidental public spectator invitation.
    allowedRandomClientIds: new Set(allowedRandomClientIds),
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
    finishReason: null,
    // A match starts only after both occupied player seats opt in. Client ids
    // survive reconnects, unlike Socket.IO ids.
    startAgreements: new Set(),
    needsFreshGame: false,
    chat: [],
    chatUsage: new Map(),
    chatIpUsage: new Map(),
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
  room.finishReason = null;
  room.startAgreements = new Set();
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
  const spectator = room.spectators.find((candidate) => candidate.id === socketId);
  const isSpectator = Boolean(spectator);
  const startAgreements = room.startAgreements || new Set();

  return {
    id: room.id,
    matchType: room.matchType,
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
    finishReason: room.finishReason,
    startReadyCount: room.players.filter((candidate) => startAgreements.has(candidate.clientId)).length,
    viewer: {
      isSpectator,
      hasConfirmedSelection: Boolean(player && room.selections[player.id]),
      hasAgreedToStart: Boolean(player && startAgreements.has(player.clientId)),
      autoJoinWhenSeatAvailable: Boolean(spectator?.autoJoinWhenSeatAvailable)
    }
  };
}

function startWhenBothPlayersAgree(room) {
  if (!room || room.players.length !== 2 || !room.players.every((player) => player.connected)) return false;
  const agreements = room.startAgreements || new Set();
  if (!room.players.every((player) => agreements.has(player.clientId))) return false;
  startNewGame(room);
  return room.gameState === 'playing';
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
  for (const [ip, usage] of room.chatIpUsage) {
    if (now - usage.lastSeenAt >= CHAT_IP_WINDOW_MS) room.chatIpUsage.delete(ip);
  }
}

function consumeChatIpQuota(room, ip, now = Date.now()) {
  const key = typeof ip === 'string' && ip ? ip : 'unknown';
  const current = room.chatIpUsage.get(key);
  if (!current && room.chatIpUsage.size >= MAX_CHAT_IPS_PER_ROOM) {
    return { ok: false, error: 'この部屋では新しいネットワークからのチャット送信を一時的に受け付けられません。' };
  }
  const usage = !current || now - current.windowStartedAt >= CHAT_IP_WINDOW_MS
    ? { count: 0, windowStartedAt: now, lastSeenAt: now }
    : current;
  if (usage.count >= MAX_CHAT_MESSAGES_PER_IP_WINDOW) {
    return { ok: false, error: 'このネットワークからのチャット送信が一時的に多すぎます。少し待ってからお試しください。' };
  }
  usage.count += 1;
  usage.lastSeenAt = now;
  room.chatIpUsage.set(key, usage);
  return { ok: true };
}

function releaseChatIpQuota(room, ip) {
  const key = typeof ip === 'string' && ip ? ip : 'unknown';
  const usage = room.chatIpUsage.get(key);
  if (!usage) return;
  usage.count -= 1;
  if (usage.count <= 0) room.chatIpUsage.delete(key);
  else room.chatIpUsage.set(key, usage);
}

function emitChatState(socket, room, clientId) {
  pruneChatUsage(room);
  const usage = room.chatUsage.get(clientId);
  socket.emit('chat_state', {
    messages: room.chat.map(({ authorClientId, ...message }) => ({ ...message, isOwn: clientId === authorClientId })),
    sent: usage?.count || 0,
    limit: MAX_CHAT_MESSAGES_PER_SESSION
  });
}

let presenceBroadcastTimer = null;

function getPresenceView() {
  return {
    // Guest PvP rooms are intentionally in-process today, so this is the
    // currently connected population of this deployment instance only.
    onlineCount: io.sockets.sockets.size,
    queueCount: randomMatchQueue.size
  };
}

function emitPresence(socket) {
  socket.emit('presence_updated', getPresenceView());
}

function schedulePresenceBroadcast() {
  if (presenceBroadcastTimer) return;
  presenceBroadcastTimer = setTimeout(() => {
    presenceBroadcastTimer = null;
    io.emit('presence_updated', getPresenceView());
  }, 250);
  presenceBroadcastTimer.unref();
}

function emitRandomMatchStatus(socket, state = 'searching') {
  socket.emit('random_match_status', {
    state,
    ...getPresenceView()
  });
}

function createRandomRoomId() {
  // 96 bits of CSPRNG output encoded as URL-safe text fits within the existing
  // room id limit and is not intended to be discoverable.
  return `m_${crypto.randomBytes(12).toString('base64url')}`;
}

function isRandomQueueEntryAvailable(entry) {
  const socket = io.sockets.sockets.get(entry.socketId);
  return Boolean(
    socket
      && socket.connected
      && !socket.data.roomId
      && socket.data.clientId === entry.clientId
      && socket.data.randomQueueClientId === entry.clientId
  );
}

function createRandomMatch(firstEntry, secondEntry) {
  const firstSocket = io.sockets.sockets.get(firstEntry.socketId);
  const secondSocket = io.sockets.sockets.get(secondEntry.socketId);
  if (!firstSocket || !secondSocket || firstSocket === secondSocket) return false;

  let roomId = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = createRandomRoomId();
    if (!rooms.has(candidate)) {
      roomId = candidate;
      break;
    }
  }
  if (!roomId) return false;

  const room = createRoom(roomId, {
    matchType: 'random',
    allowedRandomClientIds: [firstEntry.clientId, secondEntry.clientId]
  });
  rooms.set(roomId, room);

  const matchedPlayers = [
    { entry: firstEntry, socket: firstSocket },
    { entry: secondEntry, socket: secondSocket }
  ];
  matchedPlayers.forEach(({ entry, socket }, seatIndex) => {
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.clientId = entry.clientId;
    socket.data.randomQueueClientId = undefined;
    room.players.push(createPlayer({
      id: socket.id,
      clientId: entry.clientId,
      name: entry.name
    }, seatIndex));
  });

  broadcastRoom(room);
  matchedPlayers.forEach(({ entry, socket }) => emitChatState(socket, room, entry.clientId));
  return true;
}

function startQueuedRandomMatches() {
  while (rooms.size < MAX_ACTIVE_ROOMS) {
    const firstEntry = randomMatchQueue.takeNext(isRandomQueueEntryAvailable);
    if (!firstEntry) break;
    const secondEntry = randomMatchQueue.takeNext(isRandomQueueEntryAvailable);
    if (!secondEntry) {
      randomMatchQueue.enqueue(firstEntry);
      break;
    }
    if (!createRandomMatch(firstEntry, secondEntry)) {
      if (isRandomQueueEntryAvailable(firstEntry)) randomMatchQueue.enqueue(firstEntry);
      if (isRandomQueueEntryAvailable(secondEntry)) randomMatchQueue.enqueue(secondEntry);
      break;
    }
  }
  schedulePresenceBroadcast();
}

function removeEmptyRoom(room) {
  if (!room || room.players.length > 0 || room.spectators.length > 0) return false;
  rooms.delete(room.id);
  startQueuedRandomMatches();
  return true;
}

function leaveRandomMatchQueue(socket, { notify = true } = {}) {
  const removed = randomMatchQueue.removeBySocket(socket.id);
  if (!removed) return false;
  if (socket.data.randomQueueClientId === removed.clientId) socket.data.randomQueueClientId = undefined;
  if (notify) emitRandomMatchStatus(socket, 'idle');
  schedulePresenceBroadcast();
  return true;
}

function queueRandomMatch(socket, { clientId, playerName }) {
  if (socket.data.roomId) {
    emitError(socket, '対局中または観戦中は、ランダムマッチを検索できません。');
    return false;
  }
  if (!randomMatchLimiter.consume(socket.data.clientIp)) {
    emitError(socket, 'ランダムマッチの検索回数が多すぎます。少し待ってからお試しください。');
    return false;
  }

  const safeClientId = normalizeText(clientId, 80);
  const safePlayerName = normalizeText(playerName, MAX_PLAYER_NAME_LENGTH, 'プレイヤー');
  if (!safeClientId) {
    emitError(socket, '接続情報を確認できませんでした。ページを再読み込みしてお試しください。');
    return false;
  }

  const previousEntry = randomMatchQueue.remove(safeClientId);
  if (previousEntry && previousEntry.socketId !== socket.id) {
    const previousSocket = io.sockets.sockets.get(previousEntry.socketId);
    if (previousSocket) previousSocket.disconnect(true);
  }
  if (!previousEntry && randomMatchQueue.countByIp(socket.data.clientIp) >= MAX_RANDOM_QUEUE_PER_IP) {
    emitError(socket, 'このネットワークからのランダムマッチ待機が多すぎます。少し待ってからお試しください。');
    return false;
  }

  socket.data.clientId = safeClientId;
  socket.data.randomQueueClientId = safeClientId;
  const queued = randomMatchQueue.enqueue({
    clientId: safeClientId,
    socketId: socket.id,
    name: safePlayerName,
    ip: socket.data.clientIp
  });
  if (!queued.ok) {
    socket.data.randomQueueClientId = undefined;
    emitError(socket, '現在ランダムマッチの待機が混み合っています。少し待ってからお試しください。');
    return false;
  }

  startQueuedRandomMatches();
  if (!socket.data.roomId) emitRandomMatchStatus(socket, 'searching');
  schedulePresenceBroadcast();
  return true;
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

function finishGameByForfeit(room, player) {
  if (!room || !player || !['playing', 'reconnecting'].includes(room.gameState)) return false;
  const winner = room.players.find((candidate) => candidate.id !== player.id);
  if (!winner) return false;

  clearTurnTimer(room.id);
  room.selections = {};
  room.deadline = 0;
  room.gameState = 'finished';
  room.winner = winner.name;
  room.finishReason = {
    id: `forfeit-${Date.now()}`,
    type: 'forfeit',
    forfeitedBy: player.name
  };
  return true;
}

function resetAfterPlayerDeparture(room, playerIndex, { moveToSpectators = false } = {}) {
  const [departingPlayer] = room.players.splice(playerIndex, 1);
  room.needsFreshGame = true;
  resetGame(room);
  room.gameState = 'waiting';

  // Switching voluntarily to spectating must not immediately put the same
  // person back in a player seat. Their optional future seat-taking consent
  // is deliberately reset to false here.
  if (moveToSpectators && departingPlayer) {
    room.spectators.push({
      id: departingPlayer.id,
      clientId: departingPlayer.clientId,
      name: departingPlayer.name,
      autoJoinWhenSeatAvailable: false
    });
  }

  // Only spectators who explicitly opted in may take an empty player seat.
  // Everyone else remains a spectator after a player departs or a game ends.
  // resetGame already clears every interrupted hand and score before promotion.
  promoteVolunteerSpectators(room);

  if (removeEmptyRoom(room)) return false;
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
  emitPresence(socket);
  schedulePresenceBroadcast();
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
    const playerName = normalizeText(payload.playerName, MAX_PLAYER_NAME_LENGTH, 'プレイヤー');
    const clientId = normalizeText(payload.clientId, 80);
    const joinPreferences = normalizeJoinPreferences(payload);

    // Switching from the random-match entry screen to Private PvP must never
    // leave a second, invisible queue entry behind.
    leaveRandomMatchQueue(socket, { notify: false });

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
    if (room.matchType === 'random' && !returningPlayer && !returningSpectator) {
      emitError(socket, 'ランダムマッチの部屋へは、マッチした対戦者だけが入室できます。');
      return;
    }
    if (!returningPlayer && !returningSpectator) {
      if (joinPreferences.joinAsSpectator && room.spectators.length >= MAX_SPECTATORS_PER_ROOM) {
        emitError(socket, 'この部屋の観戦者数は上限に達しています。');
        return;
      }
      if (!joinPreferences.joinAsSpectator && room.players.length >= 2) {
        emitError(socket, 'この部屋は対戦中です。観戦者として入室する場合は、観戦者として参加にチェックを入れてください。');
        return;
      }
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
      if (joinPreferences.joinAsSpectator) {
        returningSpectator.autoJoinWhenSeatAvailable = joinPreferences.autoJoinWhenSeatAvailable;
      }
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket && previousSocketId !== socket.id) previousSocket.disconnect(true);
    } else if (!joinPreferences.joinAsSpectator) {
      room.players.push(createPlayer({ id: socket.id, clientId, name: playerName }, room.players.length));
    } else {
      room.spectators.push({
        id: socket.id,
        clientId,
        name: playerName,
        autoJoinWhenSeatAvailable: joinPreferences.autoJoinWhenSeatAvailable
      });
    }

    broadcastRoom(room);
    emitChatState(socket, room, clientId);
  });

  socket.on('get_presence', () => {
    emitPresence(socket);
  });

  socket.on('join_random_match', (payload = {}) => {
    queueRandomMatch(socket, {
      clientId: payload?.clientId,
      playerName: payload?.playerName
    });
  });

  socket.on('leave_random_queue', () => {
    if (socket.data.roomId) return;
    leaveRandomMatchQueue(socket);
  });

  socket.on('find_next_random_match', (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room || room.matchType !== 'random') return;
    if (!['waiting', 'finished'].includes(room.gameState)) {
      emitError(socket, '対局中は別の対戦相手を検索できません。先に降参または対局終了をお待ちください。');
      return;
    }
    const playerIndex = room.players.findIndex((player) => player.id === socket.id);
    if (playerIndex < 0) return;
    const player = room.players[playerIndex];
    socket.leave(room.id);
    socket.data.roomId = undefined;
    clearDisconnectTimer(room.id, player.clientId);
    resetAfterPlayerDeparture(room, playerIndex);
    queueRandomMatch(socket, {
      clientId: player.clientId,
      playerName: player.name
    });
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

    const ipQuota = consumeChatIpQuota(room, socket.data.clientIp, now);
    if (!ipQuota.ok) {
      replyToChat(acknowledge, { ok: false, message: ipQuota.error });
      return;
    }
    const result = appendChatMessage(room, {
      clientId: participant.clientId,
      author: participant.name,
      text: payload?.message,
      now
    });
    if (!result.ok) {
      releaseChatIpQuota(room, socket.data.clientIp);
      replyToChat(acknowledge, { ok: false, message: result.error });
      return;
    }

    const members = io.sockets.adapter.rooms.get(room.id);
    members?.forEach((memberId) => {
      const member = io.sockets.sockets.get(memberId);
      if (member) {
        const { authorClientId, ...message } = result.message;
        member.emit('chat_message', { ...message, isOwn: member.data.clientId === authorClientId });
      }
    });
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

  const agreeToStart = (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room || !['waiting', 'finished'].includes(room.gameState)) return;
    const player = room.players.find((candidate) => candidate.id === socket.id);
    if (!player || !player.connected) return;
    if (!room.players.every((player) => player.connected)) return;
    if (!room.startAgreements) room.startAgreements = new Set();
    room.startAgreements.add(player.clientId);
    startWhenBothPlayersAgree(room);
    broadcastRoom(room);
  };
  socket.on('agree_to_start', agreeToStart);
  // Older cached pages used restart_game. Preserve it as a safe alias while
  // requiring the same two-player consent as the current client.
  socket.on('restart_game', agreeToStart);

  socket.on('forfeit_game', (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room) return;
    const player = room.players.find((candidate) => candidate.id === socket.id);
    // Spectators never obtain a player object, so a forged event cannot end a
    // game. A player may forfeit while the opponent is reconnecting too.
    if (!player || !player.connected) return;
    if (!finishGameByForfeit(room, player)) return;
    broadcastRoom(room);
  });

  socket.on('switch_to_spectator', (payload = {}) => {
    const room = getBoundRoom(socket, payload.roomId);
    if (!room) return;
    const playerIndex = room.players.findIndex((candidate) => candidate.id === socket.id);
    if (playerIndex < 0) return;
    const player = room.players[playerIndex];
    clearDisconnectTimer(room.id, player.clientId);
    resetAfterPlayerDeparture(room, playerIndex, { moveToSpectators: true });
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
        if (!removeEmptyRoom(room)) broadcastRoom(room);
      }
    }
  });

  socket.on('disconnect', () => {
    untrackSocket(socket.data.clientIp);
    leaveRandomMatchQueue(socket, { notify: false });
    schedulePresenceBroadcast();
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
      if (!removeEmptyRoom(room)) broadcastRoom(room);
    }
  });
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
}

module.exports = {
  MAX_CHAT_IPS_PER_ROOM,
  app,
  buildDefaultAllowedOrigins,
  createRoomView,
  consumeChatIpQuota,
  createRoom,
  finishGameByForfeit,
  io,
  normalizeJoinPreferences,
  promoteVolunteerSpectators,
  startWhenBothPlayersAgree,
  rankedDeadlineSweeper,
  rankedRuntime
};
