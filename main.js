const GAME_SERVER_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? window.location.origin
  : 'https://overthinking-ebs.onrender.com';
const RANKED_APP_URL = new URL('/ranked', GAME_SERVER_URL).toString();
const TURN_TIME_LIMIT_MS = 90_000;
const CHAT_MESSAGE_LIMIT = 50;
const MAX_RENDERED_CHAT_MESSAGES = 100;

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
let onlineCount = null;
let randomQueueCount = null;
let mySelectedCardId = null;
let committedCardId = null;
let joinedRoom = Boolean(savedSession);
let currentRoom = null;
let timerInterval = null;
let lastRoundId = null;
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
  round: document.getElementById('current-round'),
  timer: document.getElementById('timer-count'),
  timerProgress: document.getElementById('timer-progress'),
  stack: document.getElementById('stack-count'),
  status: document.getElementById('status-message'),
  revealArea: document.getElementById('reveal-area'),
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

function setLoginMessage(message = '') {
  setText(elements.loginMessage, message);
}

function setConnectionState(connected, message = connected ? '接続中' : '再接続中') {
  elements.connectionState.classList.toggle('offline', !connected);
  const label = elements.connectionState.querySelector('span');
  if (label) setText(label, message);
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
      ? `対戦相手を探し中 ${randomQueueCount} 人`
      : '対戦相手を探し中 — 人'
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
  if (randomSearchActive && socket?.connected) socket.emit('leave_random_queue');
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
  randomSearchActive = true;
  setEntryMode('random');
  setLoginMessage(socket.connected ? '対戦相手を探しています…' : 'サーバーへ接続しています…');
  if (socket.connected) socket.emit('join_random_match', { playerName: myPlayerName, clientId });
}

function resetTimer() {
  if (timerInterval) window.clearInterval(timerInterval);
  timerInterval = null;
  setText(elements.timer, '--');
  elements.timerProgress.style.width = '0%';
}

function renderTimer(room) {
  resetTimer();
  if (room.gameState !== 'playing' || !room.deadline) return;

  const updateTimer = () => {
    const remainingMs = Math.max(0, room.deadline - Date.now());
    setText(elements.timer, Math.ceil(remainingMs / 1000));
    elements.timerProgress.style.width = `${Math.min(100, (remainingMs / TURN_TIME_LIMIT_MS) * 100)}%`;
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
  center.textContent = suit.textContent;

  const description = document.createElement('div');
  description.className = 'card-desc';
  description.textContent = card.desc;

  cardElement.append(top, center, description);
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
    const me = currentRoom?.players.find((player) => player.id === socket?.id);
    const isSpectator = Boolean(currentRoom?.viewer?.isSpectator);
    const outcomeClass = isSpectator
      ? 'draw'
      : finishReason.forfeitedBy === me?.name ? 'loss' : 'win';
    elements.revealArea.className = `reveal-area outcome-${outcomeClass} reveal-forfeit${isNewResult ? ' reveal-new' : ''}`;

    const result = document.createElement('div');
    result.className = 'forfeit-result';
    const label = document.createElement('span');
    label.textContent = 'ゲーム終了';
    const title = document.createElement('strong');
    title.textContent = '降参により決着';
    const detail = document.createElement('p');
    detail.textContent = `${finishReason.forfeitedBy} が降参しました。${winnerName || '対戦相手'} の勝ちです。`;
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
  const isDraw = lastRound.winner === 'Draw';
  const me = currentRoom?.players.find((player) => player.id === socket?.id);
  const firstPlayer = currentRoom?.players[0];
  const isMyWin = Boolean(me && !isDraw && lastRound.winner === me.name);
  const outcomeClass = isDraw ? 'draw' : isMyWin ? 'win' : me ? 'loss' : 'win';
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
    : me ? (isMyWin ? 'あなたの勝ち' : '相手の勝ち') : `${lastRound.winner} の勝ち`;
  const outcomeDetail = document.createElement('p');
  if (isDraw) {
    outcomeDetail.textContent = '引き分け — この2枚は次の勝負へ持ち越し';
  } else {
    const awardText = Number.isFinite(lastRound.awardedCards) ? `${lastRound.awardedCards}枚` : '場のカード';
    outcomeDetail.textContent = `${lastRound.winner} が ${awardText} を獲得`;
  }
  outcome.append(outcomeLabel, outcomeTitle, outcomeDetail);

  const firstOwner = currentRoom?.viewer?.isSpectator
    ? 'プレイヤー1'
    : firstPlayer?.id === socket?.id ? 'あなた' : '相手';
  const secondOwner = currentRoom?.viewer?.isSpectator
    ? 'プレイヤー2'
    : firstOwner === 'あなた' ? '相手' : 'あなた';
  const first = createRevealCard(lastRound.p1Card, firstOwner);
  first.classList.add('left');
  const versus = document.createElement('div');
  versus.className = 'reveal-versus';
  const versusMark = document.createElement('b');
  versusMark.textContent = '対';
  const winner = document.createElement('span');
  const awardText = Number.isFinite(lastRound.awardedCards) ? `+${lastRound.awardedCards}枚` : '場のカード';
  winner.textContent = lastRound.winner === 'Draw'
    ? '引き分け · 持ち越し +2'
    : `獲得 ${awardText}`;
  versus.append(versusMark, winner);
  const second = createRevealCard(lastRound.p2Card, secondOwner);
  second.classList.add('right');
  result.append(outcome, first, versus, second);
  elements.revealArea.replaceChildren(result);

  if (isNewRound) {
    playResultEffects(outcomeClass);
    window.setTimeout(() => elements.revealArea.classList.remove('reveal-new'), 600);
  }
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

function createRevealCard(card, owner) {
  const node = document.createElement('div');
  node.className = 'reveal-card';
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
    const item = document.createElement('article');
    item.className = `history-item${round.winner === 'Draw' ? ' draw' : ''}`;
    const number = document.createElement('span');
    number.className = 'history-round';
    number.textContent = `第${round.round}`;
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    const winner = document.createElement('strong');
    winner.textContent = round.winner === 'Draw' ? '引き分け · 持ち越し' : `${round.winner} が獲得`;
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
    setText(
      elements.status,
      room.viewer.autoJoinWhenSeatAvailable
        ? '観戦中です。空席ができた場合は対戦者として参加します。'
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
    if (opponentDisconnected) {
      setText(elements.status, '対戦相手の再接続を待っています。');
    } else if (room.finishReason?.type === 'forfeit') {
      setText(elements.status, `ゲーム終了 — ${room.finishReason.forfeitedBy} の降参により ${room.winner} の勝ちです。`);
    } else if (room.players.length === 2 && room.players.every((player) => player.connected) && room.viewer.hasAgreedToStart) {
      setText(elements.status, room.matchType === 'random'
        ? 'この相手との再戦を希望しました。相手の同意を待っています…'
        : '再戦に同意しました。相手の同意を待っています…');
    } else {
      setText(elements.status, room.matchType === 'random'
        ? `ゲーム終了 — ${room.winner}。この相手と続けるか、別の相手を探せます。`
        : `ゲーム終了 — ${room.winner}。再戦する場合は「再戦に同意する」を押してください。`);
    }
  }
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
      hasAgreedToStart: false
    }
  };
  randomSearchActive = false;
  renderEntryMode();
  // A random-match id is server-generated. Persist it as soon as the room
  // view arrives so start consent, card submission, and reconnect all target
  // the same authoritative room just like Private PvP does.
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

  setText(elements.mySideLabel, isSpectator ? '観戦中・♠側' : 'あなた');
  setText(elements.opponentSideLabel, isSpectator ? '観戦中・♥側' : '対戦相手');
  elements.myZone.setAttribute('aria-label', isSpectator ? '♠側プレイヤーの手札' : 'あなたの手札');
  elements.opponentZone.setAttribute('aria-label', isSpectator ? '♥側プレイヤーの手札' : '対戦相手の手札');

  const spectatorLabel = roomView.spectatorCount ? `観戦 ${roomView.spectatorCount}` : '';
  setText(elements.spectatorCount, spectatorLabel);
  elements.spectatorCount.classList.toggle('hidden', !spectatorLabel);
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
  elements.switchSpectatorButton.classList.toggle('hidden', !playerCanAct);
  elements.playerControls.classList.toggle('hidden', !playerCanAct);
  setText(
    elements.restartButton,
    roomView.gameState === 'finished'
      ? (isRandomMatch ? 'この相手と続ける' : '再戦に同意する')
      : '対戦開始に同意する'
  );
  elements.restartButton.disabled = !socket?.connected || roomView.viewer.hasAgreedToStart;
  elements.nextRandomButton.disabled = !socket?.connected;
  elements.surrenderButton.disabled = !socket?.connected;
  elements.switchSpectatorButton.disabled = !socket?.connected;
  elements.spectatorModeBadge.classList.toggle('hidden', !isSpectator);
  elements.randomMatchBadge.classList.toggle('hidden', !isRandomMatch);
  elements.homeButton.classList.toggle('hidden', !isSpectator && !['waiting', 'finished'].includes(roomView.gameState));
  setText(elements.homeButtonLabel, isSpectator ? '観戦をやめる' : 'ホームへ戻る');

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
  if (socket && currentRoomId) socket.emit('agree_to_start', { roomId: currentRoomId });
});

elements.nextRandomButton.addEventListener('click', () => {
  if (!socket?.connected || !currentRoom || currentRoom.matchType !== 'random' || !currentRoomId) return;
  if (!['waiting', 'finished'].includes(currentRoom.gameState)) return;
  const previousRoomId = currentRoomId;
  joinedRoom = false;
  currentRoomId = '';
  currentRoom = null;
  mySelectedCardId = null;
  committedCardId = null;
  lastRoundId = null;
  previousScores.clear();
  resetChat();
  clearSavedSession();
  resetTimer();
  randomSearchActive = true;
  setEntryMode('random');
  showLoginScreen();
  setLoginMessage('別の対戦相手を探しています…');
  socket.emit('find_next_random_match', { roomId: previousRoomId });
});

elements.surrenderButton.addEventListener('click', () => {
  if (!socket?.connected || !currentRoomId || !currentRoom || currentRoom.viewer.isSpectator) return;
  if (!window.confirm('降参するとこのゲームは終了し、相手の勝ちになります。降参しますか？')) return;
  socket.emit('forfeit_game', { roomId: currentRoomId });
});

elements.switchSpectatorButton.addEventListener('click', () => {
  if (!socket?.connected || !currentRoomId || !currentRoom || currentRoom.viewer.isSpectator) return;
  const activeGame = ['playing', 'reconnecting'].includes(currentRoom.gameState);
  const message = activeGame
    ? '観戦者に切り替えると、現在の対局は中断されます。観戦者に切り替えますか？'
    : '観戦者に切り替えますか？';
  if (!window.confirm(message)) return;
  socket.emit('switch_to_spectator', { roomId: currentRoomId });
});

elements.privateModeButton.addEventListener('click', () => {
  if (randomSearchActive) stopRandomSearch();
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
  stopRandomSearch({ message: 'ランダム対戦の検索をやめました。' });
});

elements.spectateModeInput.addEventListener('change', syncSpectatorJoinOptions);
elements.autoJoinSeatInput.addEventListener('change', () => {
  if (elements.autoJoinSeatInput.disabled) elements.autoJoinSeatInput.checked = false;
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
  const roomIdToLeave = currentRoomId;
  const returnToRandomEntry = currentRoom?.matchType === 'random';
  if (socket?.connected && roomIdToLeave) socket.emit('leave_room', { roomId: roomIdToLeave });

  joinedRoom = false;
  currentRoomId = '';
  mySelectedCardId = null;
  committedCardId = null;
  currentRoom = null;
  randomSearchActive = false;
  lastRoundId = null;
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
    chatReady = false;
    updateChatControls();
    socket.emit('get_presence');
    if (joinedRoom) emitJoinRequest();
    else if (randomSearchActive) socket.emit('join_random_match', { playerName: myPlayerName, clientId });
  });

  socket.on('disconnect', () => {
    setConnectionState(false);
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
    if (!currentRoom) setLoginMessage('サーバーへ接続しています…');
  });

  socket.on('room_updated', (room) => {
    randomSearchActive = false;
    entryMode = room.matchType === 'random' ? 'random' : 'private';
    elements.joinButton.disabled = false;
    setLoginMessage('');
    renderRoom(room);
  });

  socket.on('presence_updated', (presence) => {
    updatePresenceView(presence);
  });

  socket.on('random_match_status', (status) => {
    updatePresenceView(status);
    if (status?.state === 'searching') {
      randomSearchActive = true;
      setEntryMode('random');
      if (!currentRoom) setLoginMessage('対戦相手を探しています…');
    } else if (status?.state === 'idle') {
      randomSearchActive = false;
      renderEntryMode();
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
      joinedRoom = false;
      randomSearchActive = false;
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
