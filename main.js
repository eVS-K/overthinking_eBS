const GAME_SERVER_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? window.location.origin
  : 'https://overthinking-ebs.onrender.com';
const RANKED_APP_URL = new URL('/ranked', GAME_SERVER_URL).toString();
const TURN_TIME_LIMIT_MS = 90_000;
const PRIVATE_TURN_TIME_OPTIONS_MS = new Set([60_000, 90_000, 120_000]);
const CHAT_MESSAGE_LIMIT = 50;
const MAX_RENDERED_CHAT_MESSAGES = 100;
const CARD_MARKS = Object.freeze({ ace: 'A', king: 'K', queen: 'Q', jack: 'J', joker: 'JK', three: '3', two: '2' });

const socket = window.io
  ? window.io(GAME_SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelayMax: 5_000
  })
  : null;

const savedSession = getSavedSession();
let currentRoomId = savedSession?.roomId || '';
let myPlayerName = savedSession?.playerName || '';
let joinAsSpectator = Boolean(savedSession?.joinAsSpectator);
let autoJoinWhenSeatAvailable = Boolean(savedSession?.autoJoinWhenSeatAvailable);
let entryMode = 'private';
let randomSearchActive = false;
let randomSearchWanted = false;
let randomSearchRequestId = '';
let randomSearchSourceRoomId = '';
let nextRandomMatchPending = false;
let nextRandomMatchTimeout = null;
let onlineCount = null;
let randomQueueCount = null;
let mySelectedCardId = null;
let committedCardId = null;
let joinedRoom = Boolean(savedSession);
let currentRoom = null;
let timerInterval = null;
let privateSettingsPending = null;
let privateSettingsTimeout = null;
let privateSettingsFeedback = '';
let lastRoundId = null;
let lastFinaleId = null;
let finalResultAnimationTimer = null;
const previousScores = new Map();
let chatMessages = [];
let chatSentCount = 0;
let chatLimit = CHAT_MESSAGE_LIMIT;
let chatSending = false;
let pendingChatText = '';
let chatSendTimeout = null;
let chatRequestId = 0;
let chatReady = false;
let chatSoundEnabled = readChatSoundPreference();
let chatAudioContext = null;
let lastChatSoundAt = 0;

const elements = {
  loginScreen: document.getElementById('login-screen'),
  gameScreen: document.getElementById('game-screen'),
  joinForm: document.getElementById('join-form'),
  privateModeButton: document.getElementById('private-mode-btn'),
  randomModeButton: document.getElementById('random-mode-btn'),
  privateJoinFields: document.getElementById('private-join-fields'),
  randomMatchPanel: document.getElementById('random-match-panel'),
  joinOptions: document.getElementById('join-options'),
  roomIdInput: document.getElementById('roomIdInput'),
  playerNameInput: document.getElementById('playerNameInput'),
  spectateModeInput: document.getElementById('spectate-mode-input'),
  autoJoinSeatInput: document.getElementById('auto-join-seat-input'),
  joinButton: document.getElementById('joinBtn'),
  joinButtonLabel: document.getElementById('join-button-label'),
  cancelRandomSearchButton: document.getElementById('cancel-random-search-btn'),
  randomOnlineCount: document.getElementById('random-online-count'),
  randomQueueCount: document.getElementById('random-queue-count'),
  loginMessage: document.getElementById('login-message'),
  roomId: document.getElementById('display-room-id'),
  roomChipLabel: document.getElementById('room-chip-label'),
  fullscreenButton: document.getElementById('fullscreenBtn'),
  homeButton: document.getElementById('homeBtn'),
  homeButtonLabel: document.getElementById('home-btn-label'),
  spectatorModeBadge: document.getElementById('spectator-mode-badge'),
  randomMatchBadge: document.getElementById('random-match-badge'),
  connectionState: document.getElementById('connection-state'),
  connectionNotice: document.getElementById('connection-notice'),
  round: document.getElementById('current-round'),
  roundLimit: document.getElementById('round-limit'),
  timer: document.getElementById('timer-count'),
  timerProgress: document.getElementById('timer-progress'),
  stack: document.getElementById('stack-count'),
  status: document.getElementById('status-message'),
  revealArea: document.getElementById('reveal-area'),
  finalResultPanel: document.getElementById('final-result-panel'),
  myName: document.getElementById('my-name'),
  mySideLabel: document.getElementById('my-side-label'),
  myScore: document.getElementById('my-score'),
  myHand: document.getElementById('my-hand'),
  opponentName: document.getElementById('opp-name'),
  opponentSideLabel: document.getElementById('opp-side-label'),
  opponentScore: document.getElementById('opp-score'),
  opponentHand: document.getElementById('opp-hand'),
  opponentZone: document.getElementById('opponent-zone'),
  myZone: document.getElementById('my-zone'),
  playerControls: document.getElementById('player-controls'),
  confirmButton: document.getElementById('confirmBtn'),
  surrenderButton: document.getElementById('surrenderBtn'),
  restartButton: document.getElementById('restartBtn'),
  nextRandomButton: document.getElementById('nextRandomBtn'),
  switchSpectatorButton: document.getElementById('switchSpectatorBtn'),
  spectatorSeatPanel: document.getElementById('spectator-seat-panel'),
  spectatorAutoJoinToggle: document.getElementById('spectator-auto-join-toggle'),
  spectatorSeatQueue: document.getElementById('spectator-seat-queue'),
  roomRulesPanel: document.getElementById('room-rules-panel'),
  roomRulesMode: document.getElementById('room-rules-mode'),
  roomRulesState: document.getElementById('room-rules-state'),
  roomRulesSummary: document.getElementById('room-rules-summary'),
  roomRulesEnd: document.getElementById('room-rules-end'),
  roomRulesTimeout: document.getElementById('room-rules-timeout'),
  privateSettingsControls: document.getElementById('private-settings-controls'),
  privateTurnTimeSelect: document.getElementById('private-turn-time-select'),
  privateSettingsFeedback: document.getElementById('private-settings-feedback'),
  history: document.getElementById('history-list'),
  spectatorCount: document.getElementById('spectator-count'),
  chatList: document.getElementById('chat-list'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSendButton: document.getElementById('chat-send-btn'),
  chatSoundToggle: document.getElementById('chat-sound-toggle'),
  chatCount: document.getElementById('chat-count'),
  chatFeedback: document.getElementById('chat-feedback'),
  creditButton: document.getElementById('credit-btn'),
  creditModal: document.getElementById('credit-modal'),
  closeCreditButton: document.getElementById('close-credit-btn')
};

// The legacy board can remain on GitHub Pages, while account-bearing Ranked
// always crosses to the same-origin backend that owns the secure session.
const rankedModeLink = document.getElementById('ranked-mode-link');
if (rankedModeLink) rankedModeLink.href = RANKED_APP_URL;

const clientId = getOrCreateClientId();

function getOrCreateClientId() {
  const storageKey = 'overthinking-client-id';
  try {
    // タブ単位で保持するため、別タブの観戦・テストが既存プレイヤーを乗っ取らない。
    const existingId = window.sessionStorage.getItem(storageKey);
    if (existingId) return existingId;
    const newId = window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(storageKey, newId);
    return newId;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function getSavedSession() {
  try {
    const roomId = window.sessionStorage.getItem('overthinking-room-id');
    const playerName = window.sessionStorage.getItem('overthinking-player-name');
    return roomId
      ? {
        roomId,
        playerName: playerName || 'プレイヤー',
        joinAsSpectator: window.sessionStorage.getItem('overthinking-join-as-spectator') === 'true',
        autoJoinWhenSeatAvailable: window.sessionStorage.getItem('overthinking-auto-join-seat') === 'true'
      }
      : null;
  } catch {
    return null;
  }
}

function saveSession() {
  try {
    window.sessionStorage.setItem('overthinking-room-id', currentRoomId);
    window.sessionStorage.setItem('overthinking-player-name', myPlayerName);
    window.sessionStorage.setItem('overthinking-join-as-spectator', String(joinAsSpectator));
    window.sessionStorage.setItem('overthinking-auto-join-seat', String(autoJoinWhenSeatAvailable));
  } catch {
    // ストレージが使えない環境でも、同一接続中の対戦は継続する。
  }
}

function clearSavedSession() {
  try {
    window.sessionStorage.removeItem('overthinking-room-id');
    window.sessionStorage.removeItem('overthinking-player-name');
    window.sessionStorage.removeItem('overthinking-join-as-spectator');
    window.sessionStorage.removeItem('overthinking-auto-join-seat');
  } catch {
    // ストレージが使えない環境では何もしない。
  }
}

function setText(element, value) {
  element.textContent = String(value);
}

function createRandomSearchRequestId() {
  return window.crypto?.randomUUID?.()
    || `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clearNextRandomMatchPending() {
  if (nextRandomMatchTimeout) window.clearTimeout(nextRandomMatchTimeout);
  nextRandomMatchTimeout = null;
  nextRandomMatchPending = false;
}

function emitRandomSearchRequest() {
  if (!socket?.connected || !randomSearchWanted || !randomSearchRequestId) return;
  socket.emit('join_random_match', {
    playerName: myPlayerName,
    clientId,
    requestId: randomSearchRequestId
  }, (result) => {
    if (result?.ok || randomSearchRequestId !== result?.requestId) return;
    randomSearchWanted = false;
    randomSearchRequestId = '';
    randomSearchSourceRoomId = '';
    randomSearchActive = false;
    renderEntryMode();
    setLoginMessage(result?.message || 'ランダムマッチの検索を開始できませんでした。もう一度お試しください。');
  });
}

function isStaleRandomRoomUpdate(room) {
  return Boolean(
    randomSearchWanted
    && randomSearchSourceRoomId
    && room?.id === randomSearchSourceRoomId
  );
}

function scheduleNextRandomMatchRetry(sourceRoomId, requestId) {
  if (nextRandomMatchTimeout) window.clearTimeout(nextRandomMatchTimeout);
  nextRandomMatchTimeout = window.setTimeout(() => {
    if (!nextRandomMatchPending
      || randomSearchRequestId !== requestId
      || randomSearchSourceRoomId !== sourceRoomId) return;
    setText(elements.status, socket?.connected
      ? '検索開始を再確認しています…'
      : '接続を回復後、検索開始を再確認します…');
    requestNextRandomMatch(sourceRoomId, requestId);
  }, 5_500);
}

function requestNextRandomMatch(sourceRoomId, requestId) {
  if (!nextRandomMatchPending
    || randomSearchRequestId !== requestId
    || randomSearchSourceRoomId !== sourceRoomId) return;
  scheduleNextRandomMatchRetry(sourceRoomId, requestId);
  if (!socket?.connected) return;

  socket.emit('find_next_random_match', { roomId: sourceRoomId, requestId }, (result) => {
    if (randomSearchRequestId !== requestId || !nextRandomMatchPending) return;
    if (!result?.ok) {
      clearNextRandomMatchPending();
      randomSearchWanted = false;
      randomSearchRequestId = '';
      randomSearchSourceRoomId = '';
      if (currentRoom?.id === sourceRoomId) {
        renderRoom(currentRoom);
        setText(elements.status, result?.message || '別の相手を検索できませんでした。もう一度お試しください。');
      }
      return;
    }
    clearNextRandomMatchPending();
    // A match can be found synchronously, in which case room_updated has
    // already rendered the new room and cleared the request state. Otherwise
    // move to the search screen only after the server acknowledged the
    // transfer; stale updates from the source room remain ignored.
    if (currentRoom?.id === sourceRoomId) {
      resetLocalRoomForRandomSearch('別の対戦相手を探しています…');
    }
  });
}

function resetLocalRoomForRandomSearch(message) {
  clearPrivateSettingsPending();
  privateSettingsFeedback = '';
  joinedRoom = false;
  currentRoomId = '';
  currentRoom = null;
  mySelectedCardId = null;
  committedCardId = null;
  lastRoundId = null;
  lastFinaleId = null;
  previousScores.clear();
  resetChat();
  clearSavedSession();
  resetTimer();
  randomSearchActive = true;
  setEntryMode('random');
  showLoginScreen();
  setLoginMessage(message);
}

function handleRandomMatchInterrupted(payload = {}) {
  if (payload?.roomId && currentRoomId && payload.roomId !== currentRoomId) return;
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
  const isSearching = payload?.state === 'searching' && Boolean(requestId);

  resetLocalRoomForRandomSearch(
    payload?.message || '対戦相手が退出したため、別の相手を探しています。'
  );
  randomSearchActive = isSearching;
  randomSearchWanted = isSearching;
  randomSearchRequestId = isSearching ? requestId : '';
  randomSearchSourceRoomId = '';
  renderEntryMode();
}

// Guest names are deliberately not unique.  Outcome UI must therefore use
// the server-authoritative p1/p2 seat, never a display-name comparison.  The
// small unique-name fallback keeps a rolling deployment readable when an old
// server is briefly paired with a newer static client, without guessing when
// two names are identical.
function getPlayerForSeat(room, seat) {
  if (!room?.players || (seat !== 'p1' && seat !== 'p2')) return null;
  return room.players[seat === 'p1' ? 0 : 1] || null;
}

function getSeatForPlayer(room, player) {
  if (!room?.players || !player) return null;
  const index = room.players.findIndex((candidate) => candidate.id === player.id);
  return index === 0 ? 'p1' : index === 1 ? 'p2' : null;
}

function getViewerSeat(room) {
  if (!socket?.id) return null;
  const index = room?.players?.findIndex((player) => player.id === socket.id) ?? -1;
  return index === 0 ? 'p1' : index === 1 ? 'p2' : null;
}

function getUniqueNameSeat(room, name) {
  if (!name || name === 'Draw' || name === '引き分け') return null;
  const matches = (room?.players || [])
    .map((player, index) => ({ player, seat: index === 0 ? 'p1' : 'p2' }))
    .filter(({ player }) => player.name === name);
  return matches.length === 1 ? matches[0].seat : null;
}

function getWinnerSeat(room) {
  if (room?.winnerSeat === 'p1' || room?.winnerSeat === 'p2') return room.winnerSeat;
  return getUniqueNameSeat(room, room?.winner);
}

function getRoundWinnerSeat(room, round) {
  if (round?.winnerSeat === 'p1' || round?.winnerSeat === 'p2') return round.winnerSeat;
  return getUniqueNameSeat(room, round?.winner);
}

function getSeatDisplayName(room, seat, fallback = '対戦相手') {
  return getPlayerForSeat(room, seat)?.name || fallback;
}

function getSeatOwnerLabel(room, seat, fallback = '対戦者') {
  const suit = seat === 'p1' ? '♠' : seat === 'p2' ? '♥' : '';
  const name = getSeatDisplayName(room, seat, fallback);
  return suit ? `${suit} ${name}` : name;
}

function setLoginMessage(message = '') {
  setText(elements.loginMessage, message);
}

function setConnectionState(connected, message = connected ? '接続中' : '再接続中') {
  elements.connectionState.classList.toggle('offline', !connected);
  const label = elements.connectionState.querySelector('span');
  if (label) setText(label, message);
}

function setConnectionNotice(message = '') {
  const visible = typeof message === 'string' && message.length > 0;
  elements.connectionNotice.classList.toggle('hidden', !visible);
  if (visible) setText(elements.connectionNotice, message);
}

function showGameScreen() {
  elements.loginScreen.classList.add('hidden');
  elements.gameScreen.classList.remove('hidden');
}

function showLoginScreen() {
  elements.gameScreen.classList.add('hidden');
  elements.loginScreen.classList.remove('hidden');
}

function updateFullscreenButton() {
  const isActive = document.fullscreenElement === elements.gameScreen;
  const canUseFullscreen = Boolean(document.fullscreenEnabled && elements.gameScreen.requestFullscreen);
  elements.fullscreenButton.classList.toggle('hidden', !canUseFullscreen);
  elements.fullscreenButton.setAttribute('aria-pressed', String(isActive));
  elements.fullscreenButton.title = isActive ? '全画面表示を終了' : 'ゲーム画面を全画面で表示';
  setText(elements.fullscreenButton.querySelector('span:last-child'), isActive ? '終了' : '全画面');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement === elements.gameScreen) {
      await document.exitFullscreen();
    } else {
      await elements.gameScreen.requestFullscreen();
    }
  } catch {
    setText(elements.status, '全画面表示を開始できませんでした。');
  }
}

function emitJoinRequest() {
  if (!socket || !socket.connected || !joinedRoom || !currentRoomId) return;
  socket.emit('join_room', {
    roomId: currentRoomId,
    playerName: myPlayerName,
    clientId,
    joinAsSpectator,
    autoJoinWhenSeatAvailable
  });
}

function syncSpectatorJoinOptions() {
  const isSpectatorOption = elements.spectateModeInput.checked;
  elements.autoJoinSeatInput.disabled = !isSpectatorOption;
  if (!isSpectatorOption) elements.autoJoinSeatInput.checked = false;
}

function updatePresenceView(payload = {}) {
  onlineCount = Number.isSafeInteger(payload.onlineCount) && payload.onlineCount >= 0
    ? payload.onlineCount
    : onlineCount;
  randomQueueCount = Number.isSafeInteger(payload.queueCount) && payload.queueCount >= 0
    ? payload.queueCount
    : randomQueueCount;
  setText(elements.randomOnlineCount, onlineCount ?? '—');
  setText(
    elements.randomQueueCount,
    Number.isSafeInteger(randomQueueCount)
      ? `対戦相手を探し中 ${randomQueueCount} 接続`
      : '対戦相手を探し中 — 接続'
  );
}

function renderEntryMode() {
  const isRandomMode = entryMode === 'random';
  elements.privateModeButton.classList.toggle('mode-option-active', !isRandomMode);
  elements.randomModeButton.classList.toggle('mode-option-active', isRandomMode);
  elements.privateModeButton.setAttribute('aria-pressed', String(!isRandomMode));
  elements.randomModeButton.setAttribute('aria-pressed', String(isRandomMode));
  elements.privateJoinFields.classList.toggle('hidden', isRandomMode);
  elements.joinOptions.classList.toggle('hidden', isRandomMode);
  elements.randomMatchPanel.classList.toggle('hidden', !isRandomMode);
  elements.roomIdInput.required = !isRandomMode;
  setText(elements.joinButtonLabel, isRandomMode ? '対戦相手を探す' : '入室する');
  elements.cancelRandomSearchButton.classList.toggle('hidden', !isRandomMode || !randomSearchActive);
  elements.joinButton.disabled = randomSearchActive;
}

function setEntryMode(mode) {
  entryMode = mode === 'random' ? 'random' : 'private';
  renderEntryMode();
}

function stopRandomSearch({ message = '' } = {}) {
  const requestId = randomSearchRequestId;
  randomSearchWanted = false;
  randomSearchRequestId = '';
  randomSearchSourceRoomId = '';
  clearNextRandomMatchPending();
  if ((randomSearchActive || requestId) && socket?.connected) {
    socket.emit('leave_random_queue', { requestId });
  }
  randomSearchActive = false;
  renderEntryMode();
  if (message) setLoginMessage(message);
}

function beginRandomSearch() {
  if (!socket) {
    setLoginMessage('通信の準備に失敗しました。ページを再読み込みしてください。');
    return;
  }
  myPlayerName = elements.playerNameInput.value.trim() || 'プレイヤー';
  joinAsSpectator = false;
  autoJoinWhenSeatAvailable = false;
  currentRoomId = '';
  joinedRoom = false;
  randomSearchWanted = true;
  randomSearchRequestId = createRandomSearchRequestId();
  randomSearchSourceRoomId = '';
  clearNextRandomMatchPending();
  randomSearchActive = true;
  setEntryMode('random');
  setLoginMessage(socket.connected ? '対戦相手を探しています…' : 'サーバーへ接続しています…');
  emitRandomSearchRequest();
}

function resetTimer() {
  if (timerInterval) window.clearInterval(timerInterval);
  timerInterval = null;
  setText(elements.timer, '--');
  elements.timerProgress.style.width = '0%';
}

function getRoomRules(room) {
  const source = room?.rules && typeof room.rules === 'object' ? room.rules : {};
  const configuredTurnTime = Number(source.turnTimeLimitMs);
  const configuredRoundLimit = Number(source.roundLimit);
  const configuredScoreTarget = Number(source.scoreTarget ?? source.scoreLimit);
  const configuredRevision = Number(source.configRevision ?? room?.configRevision);
  return {
    ruleset: typeof source.ruleset === 'string' && source.ruleset ? source.ruleset : 'classic-v1',
    turnTimeLimitMs: Number.isSafeInteger(configuredTurnTime)
      && configuredTurnTime >= 15_000
      && configuredTurnTime <= 120_000
      ? configuredTurnTime
      : TURN_TIME_LIMIT_MS,
    roundLimit: Number.isSafeInteger(configuredRoundLimit)
      && configuredRoundLimit >= 1
      && configuredRoundLimit <= 99
      ? configuredRoundLimit
      : 7,
    scoreTarget: Number.isSafeInteger(configuredScoreTarget)
      && configuredScoreTarget >= 1
      && configuredScoreTarget <= 99
      ? configuredScoreTarget
      : 9,
    // The server deliberately keeps the classic timeout policy fixed.  Do
    // not let a future/malformed room view make the client describe a rule
    // that the canonical game never applied.
    timeoutPolicy: 'random-legal',
    configRevision: Number.isSafeInteger(configuredRevision) && configuredRevision >= 0 ? configuredRevision : 0,
    locked: source.locked === true || ['playing', 'reconnecting'].includes(room?.gameState)
  };
}

function formatTurnTime(turnTimeLimitMs) {
  return `${Math.round(turnTimeLimitMs / 1_000)}秒`;
}

function isRoomHost(room) {
  return (room?.viewer?.isRoomHost ?? room?.viewer?.isHost) === true;
}

function clearPrivateSettingsPending() {
  if (privateSettingsTimeout) window.clearTimeout(privateSettingsTimeout);
  privateSettingsTimeout = null;
  privateSettingsPending = null;
}

function applyPrivateSettingsAcknowledgement(result, roomId, { clearStartAgreement = false } = {}) {
  if (!result?.settings || typeof result.settings !== 'object' || currentRoom?.id !== roomId) return false;
  const revision = Number.isSafeInteger(result.configRevision)
    ? result.configRevision
    : currentRoom.configRevision;
  currentRoom = {
    ...currentRoom,
    configRevision: revision,
    rules: {
      ...(currentRoom.rules || {}),
      ...result.settings,
      configRevision: Number.isSafeInteger(result.configRevision)
        ? result.configRevision
        : result.settings.configRevision ?? currentRoom.rules?.configRevision
    },
    viewer: clearStartAgreement
      ? { ...(currentRoom.viewer || {}), hasAgreedToStart: false }
      : currentRoom.viewer
  };
  return true;
}

function renderRoomRules(room) {
  if (!elements.roomRulesPanel) return;
  const rules = getRoomRules(room);
  const isPrivateRoom = room?.matchType !== 'random';
  const canEdit = Boolean(
    isPrivateRoom
    && isRoomHost(room)
    && ['waiting', 'finished'].includes(room?.gameState)
  );
  let isPending = privateSettingsPending?.roomId === room?.id;

  // A room update is authoritative. Only now do we mark an asynchronous
  // settings request as saved, preventing a stale select value from looking
  // like a successful change after a reconnect or a competing host update.
  if (isPending && rules.turnTimeLimitMs === privateSettingsPending.turnTimeLimitMs) {
    clearPrivateSettingsPending();
    privateSettingsFeedback = '設定を反映しました。両者の開始同意はリセットされています。';
    isPending = false;
  }

  setText(elements.roomRulesMode, isPrivateRoom ? 'プライベート対戦・クラシック' : 'ランダムマッチ・固定ルール');
  setText(
    elements.roomRulesState,
    !isPrivateRoom
      ? '設定は固定です'
      : rules.locked
        ? '対局中 — 設定は固定'
        : canEdit
          ? '現在の設定担当者 — 変更できます'
          : '現在の設定担当者が変更できます'
  );
  setText(
    elements.roomRulesSummary,
    `共通の7枚で最大${rules.roundLimit}ラウンド。1ラウンド ${formatTurnTime(rules.turnTimeLimitMs)}、${rules.scoreTarget}枚獲得で即時決着です。`
  );
  setText(
    elements.roomRulesEnd,
    `${rules.scoreTarget}枚獲得、または第${rules.roundLimit}ラウンド終了時に獲得枚数が多い側の勝ちです。`
  );
  setText(
    elements.roomRulesTimeout,
    '時間切れ時は、残った手札からサーバーが1枚をランダムに選びます。'
  );

  elements.privateSettingsControls.classList.toggle('hidden', !canEdit);
  if (!canEdit) return;

  const selectableTurnTime = PRIVATE_TURN_TIME_OPTIONS_MS.has(rules.turnTimeLimitMs)
    ? rules.turnTimeLimitMs
    : TURN_TIME_LIMIT_MS;
  const displayTurnTime = isPending ? privateSettingsPending.turnTimeLimitMs : selectableTurnTime;
  elements.privateTurnTimeSelect.value = String(displayTurnTime);
  elements.privateTurnTimeSelect.disabled = !socket?.connected || isPending;
  setText(
    elements.privateSettingsFeedback,
    isPending
      ? '設定をサーバーへ反映しています…'
      : privateSettingsFeedback || '変更すると、両者の「対戦開始に同意する」はリセットされます。'
  );
}

function requestPrivateTurnTimeChange(turnTimeLimitMs) {
  if (!socket?.connected || !currentRoom || !currentRoomId || currentRoom.matchType === 'random') return;
  if (!isRoomHost(currentRoom) || !['waiting', 'finished'].includes(currentRoom.gameState)) return;
  if (!PRIVATE_TURN_TIME_OPTIONS_MS.has(turnTimeLimitMs)) {
    privateSettingsFeedback = '選べる制限時間は60秒・90秒・120秒です。';
    renderRoomRules(currentRoom);
    return;
  }

  const rules = getRoomRules(currentRoom);
  if (rules.turnTimeLimitMs === turnTimeLimitMs) {
    privateSettingsFeedback = 'この部屋はすでにその制限時間です。';
    renderRoomRules(currentRoom);
    return;
  }

  clearPrivateSettingsPending();
  const pendingRequest = {
    roomId: currentRoomId,
    configRevision: rules.configRevision,
    turnTimeLimitMs
  };
  privateSettingsPending = pendingRequest;
  privateSettingsFeedback = '';
  renderRoomRules(currentRoom);
  privateSettingsTimeout = window.setTimeout(() => {
    if (privateSettingsPending !== pendingRequest) return;
    clearPrivateSettingsPending();
    privateSettingsFeedback = '設定の確認ができませんでした。通信状態を確認して、もう一度お試しください。';
    if (currentRoom?.id === pendingRequest.roomId) renderRoomRules(currentRoom);
  }, 5_000);

  socket.emit('update_private_settings', pendingRequest, (result) => {
    if (privateSettingsPending !== pendingRequest) return;
    if (!result?.ok) {
      clearPrivateSettingsPending();
      privateSettingsFeedback = result?.message || '設定を変更できませんでした。';
      // A rejected request may carry only a newer configuration revision.
      // It is not proof that this viewer's own start consent changed, so do
      // not erase that local state while resynchronising the selector.
      if (applyPrivateSettingsAcknowledgement(result, pendingRequest.roomId)) {
        renderRoom(currentRoom);
      } else if (currentRoom?.id === pendingRequest.roomId) {
        renderRoomRules(currentRoom);
      }
      return;
    }

    // Prefer the following room_updated event for the full new view. If the
    // server returns settings in its acknowledgement, it is also
    // authoritative and lets a slow broadcast keep this host informed.
    if (applyPrivateSettingsAcknowledgement(result, pendingRequest.roomId, { clearStartAgreement: true })) {
      clearPrivateSettingsPending();
      privateSettingsFeedback = '設定を反映しました。両者の開始同意はリセットされています。';
      renderRoom(currentRoom);
    } else {
      privateSettingsFeedback = '設定を確認しています…';
    }
  });
}

function renderTimer(room) {
  resetTimer();
  if (room.gameState !== 'playing' || !room.deadline) return;
  const turnTimeLimitMs = getRoomRules(room).turnTimeLimitMs;

  const updateTimer = () => {
    const remainingMs = Math.max(0, room.deadline - Date.now());
    setText(elements.timer, Math.ceil(remainingMs / 1000));
    elements.timerProgress.style.width = `${Math.min(100, (remainingMs / turnTimeLimitMs) * 100)}%`;
  };
  updateTimer();
  timerInterval = window.setInterval(updateTimer, 300);
}

function createCard(card, suitType, isInteractive) {
  const cardElement = document.createElement('div');
  // 両プレイヤーは同じIDのカードを持つため、選択状態は操作できる自分の手札だけに適用する。
  const isSelected = isInteractive && card.id === mySelectedCardId;
  const isCommitting = isInteractive && card.id === committedCardId;
  cardElement.className = `card card-${suitType}${isInteractive ? ' card-action' : ''}${isSelected ? ' selected' : ''}${isCommitting ? ' committing' : ''}`;
  cardElement.dataset.cardId = card.id;
  cardElement.setAttribute('aria-label', `${card.name}、${card.desc}${isSelected ? '、選択中' : ''}`);

  if (isInteractive) {
    cardElement.setAttribute('role', 'button');
    cardElement.tabIndex = 0;
    const selectCard = () => {
      mySelectedCardId = mySelectedCardId === card.id ? null : card.id;
      committedCardId = null;
      renderHand(
        elements.myHand,
        currentRoom?.players.find((player) => player.id === socket?.id)?.hand || [],
        'spade',
        true,
        { focusCardId: card.id }
      );
      updateConfirmButton();
    };
    cardElement.addEventListener('click', selectCard);
    cardElement.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectCard();
      }
    });
  }

  const top = document.createElement('div');
  top.className = 'card-top';
  const name = document.createElement('span');
  name.textContent = card.name;
  const suit = document.createElement('span');
  suit.textContent = suitType === 'spade' ? '♠' : '♥';
  if (isSelected) {
    const selectedMark = document.createElement('span');
    selectedMark.className = 'card-selected-mark';
    selectedMark.textContent = '✓';
    selectedMark.setAttribute('aria-hidden', 'true');
    top.append(name, selectedMark, suit);
  } else {
    top.append(name, suit);
  }

  const center = document.createElement('div');
  center.className = 'card-center-suit';
  const rankMark = document.createElement('span');
  rankMark.className = 'card-rank-mark';
  rankMark.textContent = CARD_MARKS[card.id] || '?';
  rankMark.setAttribute('aria-hidden', 'true');
  const suitMark = document.createElement('span');
  suitMark.className = 'card-suit-mark';
  suitMark.textContent = suit.textContent;
  suitMark.setAttribute('aria-hidden', 'true');
  center.append(rankMark, suitMark);

  // 下隅にも小さなランクとスートを置き、一覧性を保ちつつトランプの
  // カードフェイスらしい見た目にする。ゲーム上のスートは従来どおり
  // プレイヤー側を表すだけで、カード性能には影響しない。
  const cornerPip = document.createElement('div');
  cornerPip.className = 'card-corner-pip';
  cornerPip.setAttribute('aria-hidden', 'true');
  const cornerRank = document.createElement('span');
  cornerRank.textContent = CARD_MARKS[card.id] || '?';
  const cornerSuit = document.createElement('span');
  cornerSuit.textContent = suit.textContent;
  cornerPip.append(cornerRank, cornerSuit);

  const description = document.createElement('div');
  description.className = 'card-desc';
  description.textContent = card.desc;

  cardElement.append(top, center, description, cornerPip);
  return cardElement;
}

function renderHand(container, hand, suitType, isInteractive, { focusCardId = null } = {}) {
  container.replaceChildren();
  let focusTarget = null;
  (hand || []).forEach((card) => {
    const cardElement = createCard(card, suitType, isInteractive);
    container.append(cardElement);
    if (isInteractive && card.id === focusCardId) focusTarget = cardElement;
  });
  // Card choice redraws the hand to update the selection mark. Preserve the
  // keyboard user's position across that harmless redraw rather than losing
  // focus from the card they just toggled.
  focusTarget?.focus();
}

function updateScore(element, player) {
  const previousScore = previousScores.get(player.id);
  const nextScore = String(player.score);
  setText(element, nextScore);
  if (previousScore !== undefined && previousScore !== player.score) {
    element.classList.remove('score-pop');
    window.requestAnimationFrame(() => element.classList.add('score-pop'));
    const gainedCards = player.score - previousScore;
    if (gainedCards > 0) showScoreAward(element, gainedCards);
  }
  previousScores.set(player.id, player.score);
}

function showScoreAward(scoreElement, gainedCards) {
  const scoreBox = scoreElement.closest('.score-box');
  if (!scoreBox) return;
  const award = document.createElement('span');
  award.className = 'score-award';
  award.textContent = `+${gainedCards}枚`;
  scoreBox.append(award);
  window.setTimeout(() => award.remove(), 1_150);
}

function renderReveal(lastRound, finishReason = null, winnerName = null) {
  if (finishReason?.type === 'forfeit') {
    const resultId = `forfeit:${finishReason.id || `${finishReason.forfeitedBy}:${winnerName}`}`;
    const isNewResult = resultId !== lastRoundId;
    lastRoundId = resultId;
    const isSpectator = Boolean(currentRoom?.viewer?.isSpectator);
    const viewerSeat = getViewerSeat(currentRoom);
    const forfeitedSeat = finishReason.forfeitedBySeat === 'p1' || finishReason.forfeitedBySeat === 'p2'
      ? finishReason.forfeitedBySeat
      : getUniqueNameSeat(currentRoom, finishReason.forfeitedBy);
    const winnerSeat = getWinnerSeat(currentRoom);
    const outcomeClass = isSpectator
      ? winnerSeat === 'p1' ? 'spade' : winnerSeat === 'p2' ? 'heart' : 'draw'
      : forfeitedSeat && forfeitedSeat === viewerSeat ? 'loss'
        : winnerSeat && winnerSeat === viewerSeat ? 'win' : 'draw';
    elements.revealArea.className = `reveal-area outcome-${outcomeClass} reveal-forfeit${isNewResult ? ' reveal-new' : ''}`;

    const result = document.createElement('div');
    result.className = 'forfeit-result';
    const label = document.createElement('span');
    label.textContent = 'ゲーム終了';
    const title = document.createElement('strong');
    title.textContent = '降参により決着';
    const detail = document.createElement('p');
    const forfeitedName = getSeatDisplayName(currentRoom, forfeitedSeat, finishReason.forfeitedBy || '対戦者');
    const finalWinnerName = getSeatDisplayName(currentRoom, winnerSeat, winnerName || '対戦相手');
    detail.textContent = `${forfeitedName} が降参しました。${finalWinnerName} の勝ちです。`;
    result.append(label, title, detail);
    elements.revealArea.replaceChildren(result);
    if (isNewResult) {
      playResultEffects(outcomeClass);
      window.setTimeout(() => elements.revealArea.classList.remove('reveal-new'), 600);
    }
    return;
  }

  if (!lastRound) {
    elements.revealArea.className = 'reveal-area empty';
    const placeholder = document.createElement('span');
    placeholder.className = 'reveal-placeholder';
    placeholder.textContent = '両者が一枚を伏せると、ここで勝負が明かされます';
    elements.revealArea.replaceChildren(placeholder);
    return;
  }

  const isNewRound = lastRound.id !== lastRoundId;
  lastRoundId = lastRound.id;
  const roundWinnerSeat = getRoundWinnerSeat(currentRoom, lastRound);
  const isDraw = !roundWinnerSeat;
  const me = currentRoom?.players.find((player) => player.id === socket?.id);
  const firstPlayer = currentRoom?.players[0];
  const viewerSeat = getViewerSeat(currentRoom);
  const roundWinnerName = getSeatDisplayName(currentRoom, roundWinnerSeat, lastRound.winner || '対戦者');
  const isMyWin = Boolean(me && !isDraw && viewerSeat === roundWinnerSeat);
  const outcomeClass = isDraw
    ? 'draw'
    : currentRoom?.viewer?.isSpectator
      ? roundWinnerSeat === 'p1' ? 'spade' : 'heart'
      : isMyWin ? 'win' : me ? 'loss' : 'win';
  elements.revealArea.className = `reveal-area outcome-${outcomeClass}${isNewRound ? ' reveal-new' : ''}`;

  const result = document.createElement('div');
  result.className = 'reveal-result';
  const outcome = document.createElement('div');
  outcome.className = 'round-outcome';
  const outcomeLabel = document.createElement('span');
  outcomeLabel.textContent = `第${lastRound.round}ラウンドの結果`;
  const outcomeTitle = document.createElement('strong');
  outcomeTitle.textContent = isDraw
    ? '引き分け'
    : me ? (isMyWin ? 'あなたの勝ち' : '相手の勝ち') : `${roundWinnerName} の勝ち`;
  const outcomeDetail = document.createElement('p');
  if (isDraw) {
    outcomeDetail.textContent = '引き分け — この2枚は次の勝負へ持ち越し';
  } else {
    const awardText = Number.isFinite(lastRound.awardedCards) ? `${lastRound.awardedCards}枚` : '場のカード';
    outcomeDetail.textContent = `${roundWinnerName} が ${awardText} を獲得`;
  }
  outcome.append(outcomeLabel, outcomeTitle, outcomeDetail);

  const firstOwner = currentRoom?.viewer?.isSpectator
    ? getSeatOwnerLabel(currentRoom, 'p1', '♠側')
    : firstPlayer?.id === socket?.id ? 'あなた' : '相手';
  const secondOwner = currentRoom?.viewer?.isSpectator
    ? getSeatOwnerLabel(currentRoom, 'p2', '♥側')
    : firstOwner === 'あなた' ? '相手' : 'あなた';
  const first = createRevealCard(lastRound.p1Card, firstOwner, 'p1');
  first.classList.add('left');
  const versus = document.createElement('div');
  versus.className = 'reveal-versus';
  const versusMark = document.createElement('b');
  versusMark.textContent = '対';
  const winner = document.createElement('span');
  const awardText = Number.isFinite(lastRound.awardedCards) ? `+${lastRound.awardedCards}枚` : '場のカード';
  winner.textContent = isDraw
    ? '引き分け · 持ち越し +2'
    : `獲得 ${awardText}`;
  versus.append(versusMark, winner);
  const second = createRevealCard(lastRound.p2Card, secondOwner, 'p2');
  second.classList.add('right');
  result.append(outcome, first, versus, second);
  elements.revealArea.replaceChildren(result);

  if (isNewRound) {
    playResultEffects(outcomeClass);
    window.setTimeout(() => elements.revealArea.classList.remove('reveal-new'), 600);
  }
}

function renderFinalResult(room, bottomPlayer, topPlayer, isSpectator) {
  const panel = elements.finalResultPanel;
  // A stale cached HTML document must not be able to take the legacy PvP
  // renderer down while a newer main.js is rolling out.
  if (!panel) return;
  const finished = room?.gameState === 'finished';
  panel.classList.toggle('hidden', !finished);
  elements.myHand.classList.toggle('hidden', finished);
  if (!finished) {
    if (finalResultAnimationTimer) window.clearTimeout(finalResultAnimationTimer);
    finalResultAnimationTimer = null;
    panel.replaceChildren();
    lastFinaleId = null;
    return;
  }

  const winnerSeat = getWinnerSeat(room);
  const bottomSeat = getSeatForPlayer(room, bottomPlayer);
  const isDraw = !winnerSeat;
  const won = !isDraw && !isSpectator && winnerSeat === bottomSeat;
  const outcome = isDraw
    ? 'draw'
    : isSpectator ? winnerSeat === 'p1' ? 'spade' : winnerSeat === 'p2' ? 'heart' : 'spectate'
      : won ? 'win' : 'loss';
  const finaleId = room.finishReason?.id
    || `completed:${room.round}:${room.winner}:${bottomPlayer?.score ?? ''}:${topPlayer?.score ?? ''}:${room.lastRound?.id ?? ''}`;
  const isNewFinale = finaleId !== lastFinaleId;
  lastFinaleId = finaleId;
  panel.className = `final-result-panel final-${outcome}${isNewFinale ? ' final-result-new' : ''}`;

  // Room updates continue after a game (reconnects, start consent, chat
  // state). Do not recreate an aria-live result for every one of those
  // updates: announce it once, then retain the stable final result panel.
  if (!isNewFinale) return;

  const kicker = document.createElement('span');
  kicker.className = 'final-result-kicker';
  kicker.textContent = '対局の最終結果';
  const title = document.createElement('strong');
  title.className = 'final-result-title';
  const winnerName = getSeatDisplayName(room, winnerSeat, room.winner || '対戦者');
  title.textContent = isDraw
    ? '引き分け'
    : isSpectator ? `${winnerName} の勝利`
      : won ? 'あなたの勝利' : 'あなたの敗北';
  const score = document.createElement('div');
  score.className = 'final-scoreline';
  const bottomScore = document.createElement('strong');
  bottomScore.className = 'final-score-spade';
  bottomScore.textContent = String(bottomPlayer?.score ?? '—');
  const divider = document.createElement('span');
  divider.textContent = '—';
  const topScore = document.createElement('strong');
  topScore.className = 'final-score-heart';
  topScore.textContent = String(topPlayer?.score ?? '—');
  score.append(bottomScore, divider, topScore);
  const scoreCaption = document.createElement('p');
  scoreCaption.className = 'final-score-caption';
  scoreCaption.textContent = isSpectator
    ? `${getSeatOwnerLabel(room, 'p1', '♠側')} ${bottomPlayer?.score ?? '—'}枚  —  ${getSeatOwnerLabel(room, 'p2', '♥側')} ${topPlayer?.score ?? '—'}枚`
    : `${bottomPlayer?.name || 'あなた'} ${bottomPlayer?.score ?? '—'}枚  —  ${topPlayer?.name || '相手'} ${topPlayer?.score ?? '—'}枚`;
  const detail = document.createElement('p');
  detail.className = 'final-result-detail';
  if (room.finishReason?.type === 'forfeit') {
    const forfeitedSeat = room.finishReason.forfeitedBySeat === 'p1' || room.finishReason.forfeitedBySeat === 'p2'
      ? room.finishReason.forfeitedBySeat
      : getUniqueNameSeat(room, room.finishReason.forfeitedBy);
    const forfeitedName = getSeatDisplayName(room, forfeitedSeat, room.finishReason.forfeitedBy || '対戦者');
    detail.textContent = `${forfeitedName} の降参により決着しました。`;
  } else if (room.finishReason?.type === 'score-limit') {
    detail.textContent = '9枚以上を先取して決着しました。';
  } else if (isDraw) {
    detail.textContent = '7ラウンド終了。獲得枚数は同じです。';
  } else {
    detail.textContent = `第7ラウンド終了。${winnerName} が最終勝者です。`;
  }
  panel.replaceChildren(kicker, title, score, scoreCaption, detail);

  if (finalResultAnimationTimer) window.clearTimeout(finalResultAnimationTimer);
  finalResultAnimationTimer = window.setTimeout(() => {
    if (lastFinaleId === finaleId) panel.classList.remove('final-result-new');
    finalResultAnimationTimer = null;
  }, 1_350);
}

function playResultEffects(outcomeClass) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const particleCount = reducedMotion ? 0 : window.innerWidth <= 660 ? 6 : 18;

  for (let index = 0; index < particleCount; index += 1) {
    const particle = document.createElement('i');
    const angle = (Math.PI * 2 * index) / particleCount + (Math.random() - .5) * .28;
    const distance = 42 + Math.random() * (window.innerWidth <= 660 ? 64 : 142);
    particle.className = `result-particle particle-${outcomeClass}`;
    particle.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
    particle.style.setProperty('--size', `${3 + Math.random() * 5}px`);
    particle.style.setProperty('--delay', `${Math.random() * 110}ms`);
    elements.revealArea.append(particle);
    window.setTimeout(() => particle.remove(), 1_050);
  }

  elements.gameScreen.classList.remove('impact-win', 'impact-loss', 'impact-draw');
  window.requestAnimationFrame(() => elements.gameScreen.classList.add(`impact-${outcomeClass}`));
  window.setTimeout(() => elements.gameScreen.classList.remove(`impact-${outcomeClass}`), 720);
}

function createRevealCard(card, owner, seat = '') {
  const node = document.createElement('div');
  node.className = `reveal-card${seat === 'p1' ? ' reveal-spade' : seat === 'p2' ? ' reveal-heart' : ''}`;
  const cardName = document.createElement('strong');
  cardName.textContent = card.name;
  const label = document.createElement('span');
  label.textContent = owner;
  node.append(cardName, label);
  return node;
}

function renderHistory(history) {
  elements.history.replaceChildren();
  if (!history?.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = '最初の勝負を待っています。';
    elements.history.append(empty);
    return;
  }

  [...history].reverse().forEach((round) => {
    const winnerSeat = getRoundWinnerSeat(currentRoom, round);
    const isDraw = !winnerSeat;
    const winnerName = getSeatDisplayName(currentRoom, winnerSeat, round.winner || '対戦者');
    const item = document.createElement('article');
    item.className = `history-item${isDraw ? ' draw' : ''}${winnerSeat ? ` winner-${winnerSeat}` : ''}`;
    const number = document.createElement('span');
    number.className = 'history-round';
    number.textContent = `第${round.round}`;
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    const winner = document.createElement('strong');
    winner.textContent = isDraw
      ? '引き分け · 持ち越し'
      : `${getSeatOwnerLabel(currentRoom, winnerSeat, winnerName)} が獲得`;
    const cards = document.createElement('span');
    cards.textContent = `${round.p1Card.name}  対  ${round.p2Card.name}`;
    detail.append(winner, cards);
    item.append(number, detail);
    elements.history.append(item);
  });
}

function countChatCharacters(value) {
  return Array.from(value).length;
}

function normalizeChatInput(value) {
  const oneLine = String(value || '').replace(/[\r\n\u0000-\u001F\u007F-\u009F]+/g, ' ');
  return Array.from(oneLine).slice(0, CHAT_MESSAGE_LIMIT).join('');
}

function setChatFeedback(message = '') {
  setText(elements.chatFeedback, message);
}

function updateChatControls() {
  const message = elements.chatInput.value.trim();
  const canUseChat = Boolean(socket?.connected && currentRoom && chatReady && chatSentCount < chatLimit);
  const canSend = canUseChat && !chatSending && Boolean(message) && countChatCharacters(message) <= CHAT_MESSAGE_LIMIT;
  elements.chatInput.disabled = !canUseChat;
  elements.chatSendButton.disabled = !canSend;
  setText(elements.chatCount, `${Math.min(chatSentCount, chatLimit)} / ${chatLimit}`);
}

function normalizeIncomingChatMessage(value) {
  if (!value || typeof value.id !== 'string' || typeof value.author !== 'string' || typeof value.text !== 'string') return null;
  const author = Array.from(value.author.replace(/[\r\n\u0000-\u001F\u007F-\u009F]+/g, ' ').trim()).slice(0, 20).join('');
  const text = Array.from(value.text.replace(/[\r\n\u0000-\u001F\u007F-\u009F]+/g, ' ').trim()).slice(0, CHAT_MESSAGE_LIMIT).join('');
  if (!author || !text) return null;
  return {
    id: value.id.slice(0, 80),
    author,
    text,
    sentAt: Number.isFinite(value.sentAt) ? value.sentAt : 0,
    isOwn: value.isOwn === true
  };
}

function readChatSoundPreference() {
  try {
    return window.sessionStorage.getItem('overthinking-chat-sound') !== 'off';
  } catch {
    return true;
  }
}

function updateChatSoundToggle() {
  elements.chatSoundToggle.setAttribute('aria-pressed', String(chatSoundEnabled));
  setText(elements.chatSoundToggle, chatSoundEnabled ? '通知音 オン' : '通知音 オフ');
}

function primeChatSound() {
  if (!chatSoundEnabled || chatAudioContext) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    chatAudioContext = new AudioContextClass();
    chatAudioContext.resume?.().catch(() => {});
  } catch {
    chatAudioContext = null;
  }
}

function playIncomingChatSound() {
  if (!chatSoundEnabled || !chatAudioContext) return;
  const now = Date.now();
  // Keep a busy chat pleasant: one quiet cue at most every 1.2 seconds.
  if (now - lastChatSoundAt < 1_200) return;
  lastChatSoundAt = now;
  try {
    const start = chatAudioContext.currentTime;
    const oscillator = chatAudioContext.createOscillator();
    const gain = chatAudioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(660, start);
    oscillator.frequency.exponentialRampToValueAtTime(820, start + 0.075);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.025, start + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    oscillator.connect(gain).connect(chatAudioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  } catch {
    // Browsers may suspend audio in the background. The chat itself remains
    // fully usable without sound.
  }
}

function formatChatTime(sentAt) {
  if (!sentAt) return '';
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function renderChatMessages() {
  const shouldStickToBottom = elements.chatList.scrollHeight - elements.chatList.scrollTop - elements.chatList.clientHeight < 34;
  elements.chatList.replaceChildren();
  if (!chatMessages.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = 'ルームの参加者にメッセージを送れます。';
    elements.chatList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  chatMessages.forEach((message) => {
    const item = document.createElement('article');
    item.className = 'chat-message';
    const meta = document.createElement('div');
    meta.className = 'chat-message-meta';
    const author = document.createElement('strong');
    author.textContent = message.author;
    const time = document.createElement('time');
    const formattedTime = formatChatTime(message.sentAt);
    time.textContent = formattedTime;
    if (formattedTime) time.dateTime = new Date(message.sentAt).toISOString();
    meta.append(author, time);
    const text = document.createElement('p');
    text.textContent = message.text;
    item.append(meta, text);
    fragment.append(item);
  });
  elements.chatList.append(fragment);
  if (shouldStickToBottom) elements.chatList.scrollTop = elements.chatList.scrollHeight;
}

function setChatMessages(messages) {
  const seenIds = new Set();
  chatMessages = (Array.isArray(messages) ? messages : [])
    .map(normalizeIncomingChatMessage)
    .filter((message) => message && !seenIds.has(message.id) && seenIds.add(message.id))
    .slice(-MAX_RENDERED_CHAT_MESSAGES);
  renderChatMessages();
}

function appendChatMessage(message) {
  const safeMessage = normalizeIncomingChatMessage(message);
  if (!safeMessage || chatMessages.some((item) => item.id === safeMessage.id)) return;
  chatMessages = [...chatMessages, safeMessage].slice(-MAX_RENDERED_CHAT_MESSAGES);
  renderChatMessages();
  if (!safeMessage.isOwn) playIncomingChatSound();
}

function resetChat() {
  if (chatSendTimeout) window.clearTimeout(chatSendTimeout);
  chatSendTimeout = null;
  chatMessages = [];
  chatSentCount = 0;
  chatLimit = CHAT_MESSAGE_LIMIT;
  chatSending = false;
  pendingChatText = '';
  chatRequestId += 1;
  chatReady = false;
  elements.chatInput.value = '';
  setChatFeedback('送信は1参加セッションにつき50回までです。');
  renderChatMessages();
  updateChatControls();
}

function renderStatus(room, me, opponent) {
  if (!socket?.connected) {
    setText(elements.status, '接続が切れました。自動的に再接続しています…');
    return;
  }
  if (room.viewer.isSpectator) {
    const position = Number.isSafeInteger(room.viewer.seatQueuePosition) ? room.viewer.seatQueuePosition : 0;
    const length = Number.isSafeInteger(room.viewer.seatQueueLength) ? room.viewer.seatQueueLength : 0;
    setText(
      elements.status,
      room.viewer.autoJoinWhenSeatAvailable
        ? `観戦中です。空席ができた場合は対戦者として参加します（参加予約 ${position || 1}番目 / ${Math.max(length, 1)}人）。`
        : '観戦中です。両者の手札と勝負の行方を見守れます。'
    );
    return;
  }
  if (room.gameState === 'waiting') {
    const bothPlayersReady = room.players.length === 2 && room.players.every((player) => player.connected);
    if (!bothPlayersReady) {
      setText(
        elements.status,
        room.matchType === 'random'
          ? '対戦相手を待っています。別の相手を探すこともできます。'
          : '対戦相手の入室を待っています…'
      );
    } else if (room.viewer.hasAgreedToStart) {
      setText(elements.status, '対戦開始に同意しました。相手の同意を待っています…');
    } else {
      setText(elements.status, '両者が「対戦開始に同意する」を押すと、対局が始まります。');
    }
  } else if (room.gameState === 'reconnecting') {
    setText(elements.status, '対戦相手の再接続を待っています。制限時間は停止中です。');
  } else if (room.gameState === 'playing') {
    setText(elements.status, room.viewer.hasConfirmedSelection
      ? 'カードを伏せました。相手の選択を待っています…'
      : '一枚を選び、相手の思考を読んでください。');
  } else if (room.gameState === 'finished') {
    const opponentDisconnected = opponent?.connected === false;
    const winnerSeat = getWinnerSeat(room);
    const mySeat = getSeatForPlayer(room, me);
    // `winner` is a display name retained for old room payloads.  Use the
    // stable seat whenever it is available so duplicate guest names (and a
    // guest literally named "Draw") cannot make the status lie.
    const finalOutcome = winnerSeat
      ? winnerSeat === mySeat ? 'あなたの勝利' : 'あなたの敗北'
      : ['引き分け', 'Draw'].includes(room.winner) ? '引き分け' : `${room.winner || '対戦者'} の勝利`;
    if (opponentDisconnected) {
      setText(elements.status, '対戦相手の再接続を待っています。');
    } else if (room.finishReason?.type === 'forfeit') {
      const forfeitedSeat = room.finishReason.forfeitedBySeat === 'p1' || room.finishReason.forfeitedBySeat === 'p2'
        ? room.finishReason.forfeitedBySeat
        : getUniqueNameSeat(room, room.finishReason.forfeitedBy);
      const forfeitedName = getSeatDisplayName(room, forfeitedSeat, room.finishReason.forfeitedBy || '対戦者');
      setText(elements.status, `ゲーム終了 — ${finalOutcome}。${forfeitedName} が降参しました。`);
    } else if (room.players.length === 2 && room.players.every((player) => player.connected) && room.viewer.hasAgreedToStart) {
      setText(elements.status, room.matchType === 'random'
        ? 'この相手との再戦を希望しました。相手の同意を待っています…'
        : '再戦に同意しました。相手の同意を待っています…');
    } else {
      setText(elements.status, room.matchType === 'random'
        ? `ゲーム終了 — ${finalOutcome}。この相手と続けるか、別の相手を探せます。`
        : `ゲーム終了 — ${finalOutcome}。再戦する場合は「再戦に同意する」を押してください。`);
    }
  }
}

function renderSpectatorSeatPanel(room) {
  const canManageSeat = Boolean(room?.viewer?.isSpectator && room.matchType === 'private');
  elements.spectatorSeatPanel.classList.toggle('hidden', !canManageSeat);
  if (!canManageSeat) return;

  const enabled = room.viewer.autoJoinWhenSeatAvailable === true;
  const position = Number.isSafeInteger(room.viewer.seatQueuePosition) ? room.viewer.seatQueuePosition : 0;
  const length = Number.isSafeInteger(room.viewer.seatQueueLength) ? room.viewer.seatQueueLength : 0;
  elements.spectatorAutoJoinToggle.checked = enabled;
  elements.spectatorAutoJoinToggle.disabled = !socket?.connected;
  setText(
    elements.spectatorSeatQueue,
    enabled
      ? `参加予約中：${position || 1}番目 / ${Math.max(length, 1)}人。空席が出ると順番に参加します。`
      : length > 0
        ? `参加予約はオフです。現在 ${length}人が空席参加を予約しています。`
        : '参加予約はオフです。空席ができても観戦を続けます。'
  );
}

function updateConfirmButton() {
  const canConfirm = Boolean(
    currentRoom
    && socket?.connected
    && !currentRoom.viewer.isSpectator
    && currentRoom.gameState === 'playing'
    && !currentRoom.viewer.hasConfirmedSelection
    && mySelectedCardId
  );
  elements.confirmButton.disabled = !canConfirm;
}

function renderRoom(room) {
  // 新旧どちらのサーバーでも表示できるよう、段階的な公開時は旧形式も受け入れる。
  const roomView = {
    ...room,
    matchType: room.matchType === 'random' ? 'random' : 'private',
    spectatorCount: room.spectatorCount ?? room.spectators?.length ?? 0,
    viewer: room.viewer || {
      isSpectator: !room.players.some((player) => player.id === socket?.id),
      hasConfirmedSelection: Boolean(room.selections?.[socket?.id]),
      hasAgreedToStart: false,
      autoJoinWhenSeatAvailable: false,
      seatQueuePosition: null,
      seatQueueLength: 0
    }
  };
  randomSearchActive = false;
  randomSearchWanted = false;
  randomSearchRequestId = '';
  randomSearchSourceRoomId = '';
  clearNextRandomMatchPending();
  renderEntryMode();
  // A random-match id is server-generated. Persist it as soon as the room
  // view arrives so start consent, card submission, and reconnect all target
  // the same authoritative room just like Private PvP does.
  if (currentRoom?.id && currentRoom.id !== roomView.id) {
    clearPrivateSettingsPending();
    privateSettingsFeedback = '';
  }
  currentRoomId = roomView.id;
  joinedRoom = true;
  joinAsSpectator = roomView.viewer.isSpectator;
  autoJoinWhenSeatAvailable = Boolean(roomView.viewer.autoJoinWhenSeatAvailable);
  saveSession();
  currentRoom = roomView;
  showGameScreen();
  const isRandomMatch = roomView.matchType === 'random';
  setText(elements.roomChipLabel, isRandomMatch ? 'マッチ' : 'ルーム');
  setText(elements.roomId, isRandomMatch ? 'ランダム' : roomView.id);
  setText(elements.round, roomView.round);
  setText(elements.roundLimit, `/ ${getRoomRules(roomView).roundLimit}`);
  setText(elements.stack, roomView.stack.length);

  const isSpectator = roomView.viewer.isSpectator;
  const me = isSpectator ? null : roomView.players.find((player) => player.id === socket?.id);
  const opponent = isSpectator ? null : roomView.players.find((player) => player.id !== socket?.id);
  const spadePlayer = roomView.players.find((player) => player.suit === '♠');
  const heartPlayer = roomView.players.find((player) => player.suit === '♥');
  const displayedBottomPlayer = isSpectator ? spadePlayer : me;
  const displayedTopPlayer = isSpectator ? heartPlayer : opponent;
  const isInteractive = Boolean(me && !roomView.viewer.isSpectator && roomView.gameState === 'playing' && !roomView.viewer.hasConfirmedSelection);
  if (isSpectator) {
    mySelectedCardId = null;
    committedCardId = null;
  }

  if (displayedBottomPlayer) {
    if (!isSpectator && !displayedBottomPlayer.hand.some((card) => card.id === mySelectedCardId)) mySelectedCardId = null;
    if (!isSpectator && !displayedBottomPlayer.hand.some((card) => card.id === committedCardId)) committedCardId = null;
    setText(elements.myName, displayedBottomPlayer.name);
    updateScore(elements.myScore, displayedBottomPlayer);
    renderHand(elements.myHand, displayedBottomPlayer.hand, 'spade', isInteractive);
  } else {
    mySelectedCardId = null;
    setText(elements.myName, isSpectator ? '♠側を待機中' : 'あなた');
    setText(elements.myScore, isSpectator ? '—' : '0');
    elements.myHand.replaceChildren();
  }

  if (displayedTopPlayer) {
    setText(elements.opponentName, displayedTopPlayer.connected === false ? `${displayedTopPlayer.name}（再接続中）` : displayedTopPlayer.name);
    updateScore(elements.opponentScore, displayedTopPlayer);
    renderHand(elements.opponentHand, displayedTopPlayer.hand, 'heart', false);
  } else {
    setText(elements.opponentName, isSpectator ? '♥側を待機中' : '対戦相手を待機中');
    setText(elements.opponentScore, '0');
    elements.opponentHand.replaceChildren();
  }

  renderFinalResult(roomView, displayedBottomPlayer, displayedTopPlayer, isSpectator);

  setText(elements.mySideLabel, isSpectator ? '観戦中・♠側' : 'あなた');
  setText(elements.opponentSideLabel, isSpectator ? '観戦中・♥側' : '対戦相手');
  elements.myZone.setAttribute('aria-label', isSpectator ? '♠側プレイヤーの手札' : 'あなたの手札');
  elements.opponentZone.setAttribute('aria-label', isSpectator ? '♥側プレイヤーの手札' : '対戦相手の手札');

  const spectatorLabel = `観戦者 ${roomView.spectatorCount}人`;
  setText(elements.spectatorCount, spectatorLabel);
  elements.spectatorCount.classList.remove('hidden');
  const playerCanAct = !isSpectator && Boolean(me);
  const canSurrender = playerCanAct && ['playing', 'reconnecting'].includes(roomView.gameState);
  const bothPlayersReady = roomView.players.length === 2 && roomView.players.every((player) => player.connected);
  const canAgreeToStart = playerCanAct
    && ['waiting', 'finished'].includes(roomView.gameState)
    && bothPlayersReady;
  const canFindNextRandom = playerCanAct
    && isRandomMatch
    && ['waiting', 'finished'].includes(roomView.gameState);
  elements.confirmButton.classList.toggle('hidden', !playerCanAct || roomView.gameState !== 'playing');
  elements.surrenderButton.classList.toggle('hidden', !canSurrender);
  elements.restartButton.classList.toggle('hidden', !canAgreeToStart);
  elements.nextRandomButton.classList.toggle('hidden', !canFindNextRandom);
  elements.switchSpectatorButton.classList.toggle('hidden', !playerCanAct || isRandomMatch);
  elements.playerControls.classList.toggle('hidden', !playerCanAct);
  setText(
    elements.restartButton,
    roomView.gameState === 'finished'
      ? (isRandomMatch ? 'この相手と続ける' : '再戦に同意する')
      : '対戦開始に同意する'
  );
  elements.restartButton.disabled = !socket?.connected || roomView.viewer.hasAgreedToStart;
  elements.nextRandomButton.disabled = !socket?.connected || nextRandomMatchPending;
  elements.surrenderButton.disabled = !socket?.connected;
  elements.switchSpectatorButton.disabled = !socket?.connected;
  elements.spectatorModeBadge.classList.toggle('hidden', !isSpectator);
  elements.randomMatchBadge.classList.toggle('hidden', !isRandomMatch);
  elements.homeButton.classList.toggle('hidden', !isSpectator && !['waiting', 'finished'].includes(roomView.gameState));
  elements.homeButton.disabled = nextRandomMatchPending;
  setText(elements.homeButtonLabel, isSpectator ? '観戦をやめる' : 'ホームへ戻る');

  renderSpectatorSeatPanel(roomView);
  renderRoomRules(roomView);
  renderTimer(roomView);
  renderReveal(roomView.lastRound || roomView.history?.[roomView.history.length - 1], roomView.finishReason, roomView.winner);
  renderHistory(roomView.history);
  renderStatus(roomView, me, opponent);
  updateConfirmButton();
  if (!chatReady) setChatFeedback('チャットを準備しています…');
  updateChatControls();
}

function openCreditModal() {
  elements.creditModal.classList.add('active');
  elements.creditModal.setAttribute('aria-hidden', 'false');
  elements.closeCreditButton.focus();
}

function closeCreditModal() {
  elements.creditModal.classList.remove('active');
  elements.creditModal.setAttribute('aria-hidden', 'true');
  elements.creditButton.focus();
}

elements.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  myPlayerName = elements.playerNameInput.value.trim() || 'プレイヤー';
  if (entryMode === 'random') {
    beginRandomSearch();
    return;
  }

  currentRoomId = elements.roomIdInput.value.trim();
  joinAsSpectator = elements.spectateModeInput.checked;
  autoJoinWhenSeatAvailable = joinAsSpectator && elements.autoJoinSeatInput.checked;
  mySelectedCardId = null;

  if (!currentRoomId) {
    setLoginMessage('部屋キーを入力してください。');
    elements.roomIdInput.focus();
    return;
  }
  if (!socket) {
    setLoginMessage('通信の準備に失敗しました。ページを再読み込みしてください。');
    return;
  }

  joinedRoom = true;
  saveSession();
  elements.joinButton.disabled = true;
  setLoginMessage(socket.connected ? '入室しています…' : 'サーバーへ接続しています…');
  emitJoinRequest();
});

elements.confirmButton.addEventListener('click', () => {
  if (!socket || !currentRoomId || !mySelectedCardId || !currentRoom) return;
  committedCardId = mySelectedCardId;
  elements.myHand.querySelector('.selected')?.classList.add('committing');
  socket.emit('confirm_card', { roomId: currentRoomId, cardId: mySelectedCardId });
  elements.confirmButton.disabled = true;
  window.setTimeout(() => {
    if (committedCardId !== mySelectedCardId) return;
    committedCardId = null;
    const me = currentRoom?.players.find((player) => player.id === socket?.id);
    const canChoose = Boolean(me && currentRoom?.gameState === 'playing' && !currentRoom.viewer.hasConfirmedSelection);
    if (me) renderHand(elements.myHand, me.hand, 'spade', canChoose);
  }, 620);
});

elements.restartButton.addEventListener('click', () => {
  if (nextRandomMatchPending) {
    setText(elements.status, '別の相手の検索開始を確認しています。しばらくお待ちください。');
    return;
  }
  if (socket && currentRoomId) socket.emit('agree_to_start', { roomId: currentRoomId });
});

elements.nextRandomButton.addEventListener('click', () => {
  if (!socket?.connected || !currentRoom || currentRoom.matchType !== 'random' || !currentRoomId) return;
  if (!['waiting', 'finished'].includes(currentRoom.gameState)) return;
  if (nextRandomMatchPending) return;
  const previousRoomId = currentRoomId;
  const requestId = createRandomSearchRequestId();
  randomSearchWanted = true;
  randomSearchRequestId = requestId;
  randomSearchSourceRoomId = previousRoomId;
  nextRandomMatchPending = true;
  elements.nextRandomButton.disabled = true;
  elements.restartButton.disabled = true;
  elements.switchSpectatorButton.disabled = true;
  elements.homeButton.disabled = true;
  setText(elements.status, '別の対戦相手を探しています…');
  // Preserve the existing room/session until the server has atomically
  // accepted the transfer. The same request id is retried safely if its
  // acknowledgement is delayed, so a transient network loss cannot strand
  // the player in the old room or create a duplicate search.
  requestNextRandomMatch(previousRoomId, requestId);
});

elements.surrenderButton.addEventListener('click', () => {
  if (!socket?.connected || !currentRoomId || !currentRoom || currentRoom.viewer.isSpectator) return;
  if (!window.confirm('降参するとこのゲームは終了し、相手の勝ちになります。降参しますか？')) return;
  socket.emit('forfeit_game', { roomId: currentRoomId });
});

elements.switchSpectatorButton.addEventListener('click', () => {
  if (nextRandomMatchPending) {
    setText(elements.status, '別の相手の検索開始を確認しています。しばらくお待ちください。');
    return;
  }
  if (!socket?.connected || !currentRoomId || !currentRoom
    || currentRoom.viewer.isSpectator || currentRoom.matchType === 'random') return;
  const activeGame = ['playing', 'reconnecting'].includes(currentRoom.gameState);
  const message = activeGame
    ? '観戦者に切り替えると、現在の対局は中断されます。観戦者に切り替えますか？'
    : '観戦者に切り替えますか？';
  if (!window.confirm(message)) return;
  socket.emit('switch_to_spectator', { roomId: currentRoomId });
});

elements.privateModeButton.addEventListener('click', () => {
  if (randomSearchActive || randomSearchWanted) stopRandomSearch();
  setEntryMode('private');
  setLoginMessage('');
  elements.roomIdInput.focus();
});

elements.randomModeButton.addEventListener('click', () => {
  setEntryMode('random');
  setLoginMessage('');
  elements.playerNameInput.focus();
});

elements.cancelRandomSearchButton.addEventListener('click', () => {
  stopRandomSearch({ message: 'ランダムマッチの検索をやめました。' });
});

elements.spectateModeInput.addEventListener('change', syncSpectatorJoinOptions);
elements.autoJoinSeatInput.addEventListener('change', () => {
  if (elements.autoJoinSeatInput.disabled) elements.autoJoinSeatInput.checked = false;
});
elements.spectatorAutoJoinToggle.addEventListener('change', () => {
  if (!socket?.connected || !currentRoomId || !currentRoom?.viewer?.isSpectator || currentRoom.matchType !== 'private') {
    renderSpectatorSeatPanel(currentRoom);
    return;
  }
  const enabled = elements.spectatorAutoJoinToggle.checked === true;
  const requestedRoomId = currentRoomId;
  elements.spectatorAutoJoinToggle.disabled = true;
  socket.emit('set_spectator_auto_join', { roomId: currentRoomId, enabled });
  window.setTimeout(() => {
    if (currentRoomId === requestedRoomId && currentRoom?.viewer?.isSpectator) {
      renderSpectatorSeatPanel(currentRoom);
    }
  }, 3_500);
});

elements.privateTurnTimeSelect.addEventListener('change', () => {
  const turnTimeLimitMs = Number(elements.privateTurnTimeSelect.value);
  requestPrivateTurnTimeChange(turnTimeLimitMs);
});

elements.chatInput.addEventListener('input', () => {
  const normalized = normalizeChatInput(elements.chatInput.value);
  if (elements.chatInput.value !== normalized) elements.chatInput.value = normalized;
  updateChatControls();
});

elements.chatSoundToggle.addEventListener('click', () => {
  chatSoundEnabled = !chatSoundEnabled;
  try {
    window.sessionStorage.setItem('overthinking-chat-sound', chatSoundEnabled ? 'on' : 'off');
  } catch {
    // Sound preference is a convenience only; private-mode storage must not
    // affect gameplay or chat availability.
  }
  if (chatSoundEnabled) primeChatSound();
  updateChatSoundToggle();
});

elements.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = elements.chatInput.value.trim();
  if (!message) {
    setChatFeedback('メッセージを入力してください。');
    updateChatControls();
    return;
  }
  if (countChatCharacters(message) > CHAT_MESSAGE_LIMIT) {
    setChatFeedback(`メッセージは${CHAT_MESSAGE_LIMIT}文字以内です。`);
    updateChatControls();
    return;
  }
  if (!socket?.connected || !currentRoom || chatSentCount >= chatLimit || chatSending) {
    updateChatControls();
    return;
  }

  chatSending = true;
  pendingChatText = message;
  const requestId = ++chatRequestId;
  setChatFeedback('送信しています…');
  updateChatControls();
  if (chatSendTimeout) window.clearTimeout(chatSendTimeout);
  chatSendTimeout = window.setTimeout(() => {
    if (!chatSending || requestId !== chatRequestId) return;
    chatSending = false;
    setChatFeedback('送信を確認できませんでした。接続を確認して再試行してください。');
    updateChatControls();
  }, 5_000);

  socket.emit('send_chat', { message }, (result) => {
    if (requestId !== chatRequestId) return;
    if (chatSendTimeout) window.clearTimeout(chatSendTimeout);
    chatSendTimeout = null;
    chatSending = false;
    if (!result?.ok) {
      setChatFeedback(result?.message || 'メッセージを送信できませんでした。');
      updateChatControls();
      return;
    }

    chatLimit = Number.isSafeInteger(result.limit) && result.limit > 0 ? Math.min(result.limit, CHAT_MESSAGE_LIMIT) : CHAT_MESSAGE_LIMIT;
    chatSentCount = Number.isSafeInteger(result.sent)
      ? Math.min(Math.max(0, result.sent), chatLimit)
      : chatSentCount;
    if (elements.chatInput.value.trim() === pendingChatText) elements.chatInput.value = '';
    pendingChatText = '';
    setChatFeedback(`送信しました。残り ${Math.max(0, chatLimit - chatSentCount)} 回です。`);
    updateChatControls();
  });
});

elements.fullscreenButton.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenButton);
updateFullscreenButton();
elements.spectateModeInput.checked = joinAsSpectator;
elements.autoJoinSeatInput.checked = autoJoinWhenSeatAvailable;
syncSpectatorJoinOptions();
updatePresenceView();
renderEntryMode();
updateChatSoundToggle();
window.addEventListener('pointerdown', primeChatSound, { once: true, passive: true });
window.addEventListener('keydown', primeChatSound, { once: true });

elements.homeButton.addEventListener('click', () => {
  if (nextRandomMatchPending) {
    setText(elements.status, '別の相手の検索開始を確認しています。しばらくお待ちください。');
    return;
  }
  const roomIdToLeave = currentRoomId;
  const returnToRandomEntry = currentRoom?.matchType === 'random';
  if (socket?.connected && roomIdToLeave) socket.emit('leave_room', { roomId: roomIdToLeave });

  clearPrivateSettingsPending();
  privateSettingsFeedback = '';
  joinedRoom = false;
  currentRoomId = '';
  mySelectedCardId = null;
  committedCardId = null;
  currentRoom = null;
  randomSearchActive = false;
  randomSearchWanted = false;
  randomSearchRequestId = '';
  randomSearchSourceRoomId = '';
  clearNextRandomMatchPending();
  lastRoundId = null;
  lastFinaleId = null;
  previousScores.clear();
  resetChat();
  clearSavedSession();
  resetTimer();
  if (document.fullscreenElement === elements.gameScreen) document.exitFullscreen().catch(() => {});
  elements.homeButton.classList.add('hidden');
  setEntryMode(returnToRandomEntry ? 'random' : 'private');
  setLoginMessage('');
  showLoginScreen();
  (returnToRandomEntry ? elements.playerNameInput : elements.roomIdInput).focus();
});

elements.creditButton.addEventListener('click', openCreditModal);
elements.closeCreditButton.addEventListener('click', closeCreditModal);
elements.creditModal.addEventListener('click', (event) => {
  if (event.target === elements.creditModal) closeCreditModal();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.creditModal.classList.contains('active')) closeCreditModal();
});

if (socket) {
  socket.on('connect', () => {
    setConnectionState(true);
    setConnectionNotice('');
    chatReady = false;
    updateChatControls();
    socket.emit('get_presence');
    if (joinedRoom) emitJoinRequest();
    else if (randomSearchWanted) emitRandomSearchRequest();
  });

  socket.on('disconnect', () => {
    setConnectionState(false);
    setConnectionNotice('サーバーとの接続が一時的に切れました。自動で再接続しています。長引く場合は、サーバーの起動に最大約1分かかることがあります。');
    if (chatSendTimeout) window.clearTimeout(chatSendTimeout);
    chatSendTimeout = null;
    chatSending = false;
    chatRequestId += 1;
    chatReady = false;
    updateChatControls();
    if (currentRoom) renderStatus(currentRoom, null, null);
  });

  socket.on('connect_error', () => {
    setConnectionState(false, '接続を試行中');
    setConnectionNotice('サーバーへ接続しています。しばらく利用がなかった場合、起動に最大約1分かかることがあります。画面を閉じずにお待ちください。');
    if (!currentRoom) setLoginMessage('サーバーへ接続しています…');
  });

  socket.on('room_updated', (room) => {
    // An update emitted just before a successful "find next" transfer can
    // arrive after the click. It describes the old room, not a cancellation.
    // Ignore it until the server sends a different random room (or rejects
    // the request explicitly through its acknowledgement).
    if (isStaleRandomRoomUpdate(room)) {
      if (nextRandomMatchPending) requestNextRandomMatch(randomSearchSourceRoomId, randomSearchRequestId);
      return;
    }
    randomSearchActive = false;
    randomSearchWanted = false;
    randomSearchRequestId = '';
    randomSearchSourceRoomId = '';
    clearNextRandomMatchPending();
    entryMode = room.matchType === 'random' ? 'random' : 'private';
    elements.joinButton.disabled = false;
    setLoginMessage('');
    renderRoom(room);
  });

  socket.on('random_match_interrupted', (payload) => {
    handleRandomMatchInterrupted(payload);
  });

  socket.on('room_expired', ({ message } = {}) => {
    // The server already removed this room and detached the socket. Do not
    // attempt a second leave; simply clear the reconnect data so a refresh
    // cannot re-create a room that expired for resource protection.
    clearPrivateSettingsPending();
    privateSettingsFeedback = '';
    joinedRoom = false;
    currentRoomId = '';
    currentRoom = null;
    mySelectedCardId = null;
    committedCardId = null;
    randomSearchActive = false;
    randomSearchWanted = false;
    randomSearchRequestId = '';
    randomSearchSourceRoomId = '';
    clearNextRandomMatchPending();
    lastRoundId = null;
    lastFinaleId = null;
    previousScores.clear();
    resetChat();
    clearSavedSession();
    resetTimer();
    if (document.fullscreenElement === elements.gameScreen) document.exitFullscreen().catch(() => {});
    setEntryMode('private');
    setLoginMessage(message || 'ルームの有効時間が切れました。もう一度入室してください。');
    showLoginScreen();
    elements.roomIdInput.focus();
  });

  socket.on('presence_updated', (presence) => {
    updatePresenceView(presence);
  });

  socket.on('random_match_status', (status) => {
    updatePresenceView(status);
    const statusRequestId = typeof status?.requestId === 'string' ? status.requestId : '';
    if (!randomSearchWanted || !randomSearchRequestId || statusRequestId !== randomSearchRequestId) return;
    if (status?.state === 'searching') {
      randomSearchActive = true;
      setEntryMode('random');
      if (!currentRoom) setLoginMessage('対戦相手を探しています…');
    } else if (status?.state === 'idle') {
      randomSearchActive = false;
      renderEntryMode();
    } else if (status?.state === 'expired') {
      randomSearchActive = false;
      randomSearchWanted = false;
      randomSearchRequestId = '';
      randomSearchSourceRoomId = '';
      clearNextRandomMatchPending();
      renderEntryMode();
      if (!currentRoom) setLoginMessage('検索の有効時間（10分）が切れました。もう一度「対戦相手を探す」を押してください。');
    }
  });

  socket.on('chat_state', ({ messages, sent, limit }) => {
    chatReady = true;
    chatLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, CHAT_MESSAGE_LIMIT) : CHAT_MESSAGE_LIMIT;
    chatSentCount = Number.isSafeInteger(sent) ? Math.min(Math.max(sent, 0), chatLimit) : 0;
    setChatMessages(messages);
    setChatFeedback(`送信は1参加セッションにつき${chatLimit}回までです。`);
    updateChatControls();
  });

  socket.on('chat_message', (message) => {
    appendChatMessage(message);
  });

  socket.on('room_error', ({ message }) => {
    elements.joinButton.disabled = false;
    if (!currentRoom) {
      // A rejected Private-room attempt must not erase a still-valid random
      // queue entry. New servers acknowledge an actual queue failure, which
      // clears this intent in emitRandomSearchRequest instead.
      if (randomSearchWanted && randomSearchRequestId) {
        setLoginMessage(message || '操作を完了できませんでした。');
        return;
      }
      joinedRoom = false;
      randomSearchActive = false;
      randomSearchWanted = false;
      randomSearchRequestId = '';
      randomSearchSourceRoomId = '';
      clearNextRandomMatchPending();
      renderEntryMode();
      clearSavedSession();
      setLoginMessage(message || '入室できませんでした。');
    } else {
      setText(elements.status, message || '操作を完了できませんでした。');
    }
  });
} else {
  setConnectionState(false, '通信を開始できません');
}
