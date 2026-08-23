const GAME_SERVER_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? window.location.origin
  : 'https://overthinking-ebs.onrender.com';
const TURN_TIME_LIMIT_MS = 90_000;

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
let mySelectedCardId = null;
let committedCardId = null;
let joinedRoom = Boolean(savedSession);
let currentRoom = null;
let timerInterval = null;
let lastRoundId = null;
const previousScores = new Map();

const elements = {
  loginScreen: document.getElementById('login-screen'),
  gameScreen: document.getElementById('game-screen'),
  joinForm: document.getElementById('join-form'),
  roomIdInput: document.getElementById('roomIdInput'),
  playerNameInput: document.getElementById('playerNameInput'),
  joinButton: document.getElementById('joinBtn'),
  loginMessage: document.getElementById('login-message'),
  roomId: document.getElementById('display-room-id'),
  homeButton: document.getElementById('homeBtn'),
  connectionState: document.getElementById('connection-state'),
  round: document.getElementById('current-round'),
  timer: document.getElementById('timer-count'),
  timerProgress: document.getElementById('timer-progress'),
  stack: document.getElementById('stack-count'),
  status: document.getElementById('status-message'),
  revealArea: document.getElementById('reveal-area'),
  myName: document.getElementById('my-name'),
  myScore: document.getElementById('my-score'),
  myHand: document.getElementById('my-hand'),
  opponentName: document.getElementById('opp-name'),
  opponentScore: document.getElementById('opp-score'),
  opponentHand: document.getElementById('opp-hand'),
  confirmButton: document.getElementById('confirmBtn'),
  restartButton: document.getElementById('restartBtn'),
  history: document.getElementById('history-list'),
  spectatorCount: document.getElementById('spectator-count'),
  creditButton: document.getElementById('credit-btn'),
  creditModal: document.getElementById('credit-modal'),
  closeCreditButton: document.getElementById('close-credit-btn')
};

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
    return roomId ? { roomId, playerName: playerName || 'Player' } : null;
  } catch {
    return null;
  }
}

function saveSession() {
  try {
    window.sessionStorage.setItem('overthinking-room-id', currentRoomId);
    window.sessionStorage.setItem('overthinking-player-name', myPlayerName);
  } catch {
    // ストレージが使えない環境でも、同一接続中の対戦は継続する。
  }
}

function clearSavedSession() {
  try {
    window.sessionStorage.removeItem('overthinking-room-id');
    window.sessionStorage.removeItem('overthinking-player-name');
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

function emitJoinRequest() {
  if (!socket || !socket.connected || !joinedRoom || !currentRoomId) return;
  socket.emit('join_room', {
    roomId: currentRoomId,
    playerName: myPlayerName,
    clientId
  });
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
  const isSelected = card.id === mySelectedCardId;
  const isCommitting = card.id === committedCardId;
  cardElement.className = `card card-${suitType}${isInteractive ? ' card-action' : ''}${isSelected ? ' selected' : ''}${isCommitting ? ' committing' : ''}`;
  cardElement.setAttribute('aria-label', `${card.name}、${card.desc}${isSelected ? '、選択中' : ''}`);

  if (isInteractive) {
    cardElement.setAttribute('role', 'button');
    cardElement.tabIndex = 0;
    const selectCard = () => {
      mySelectedCardId = mySelectedCardId === card.id ? null : card.id;
      committedCardId = null;
      renderHand(elements.myHand, currentRoom?.players.find((player) => player.id === socket?.id)?.hand || [], 'spade', true);
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
  top.append(name, suit);

  const center = document.createElement('div');
  center.className = 'card-center-suit';
  center.textContent = suit.textContent;

  const description = document.createElement('div');
  description.className = 'card-desc';
  description.textContent = card.desc;

  cardElement.append(top, center, description);
  return cardElement;
}

function renderHand(container, hand, suitType, isInteractive) {
  container.replaceChildren();
  (hand || []).forEach((card) => container.append(createCard(card, suitType, isInteractive)));
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
  award.textContent = `+${gainedCards} CARDS`;
  scoreBox.append(award);
  window.setTimeout(() => award.remove(), 1_150);
}

function renderReveal(lastRound) {
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
  outcomeLabel.textContent = `ROUND ${lastRound.round} RESULT`;
  const outcomeTitle = document.createElement('strong');
  outcomeTitle.textContent = isDraw
    ? 'DRAW'
    : me ? (isMyWin ? 'YOU WIN' : 'OPPONENT WINS') : `${lastRound.winner} WINS`;
  const outcomeDetail = document.createElement('p');
  if (isDraw) {
    outcomeDetail.textContent = '引き分け — この2枚は次の勝負へ持ち越し';
  } else {
    const awardText = Number.isFinite(lastRound.awardedCards) ? `${lastRound.awardedCards}枚` : '場のカード';
    outcomeDetail.textContent = `${lastRound.winner} が ${awardText} を獲得`;
  }
  outcome.append(outcomeLabel, outcomeTitle, outcomeDetail);

  const firstOwner = currentRoom?.viewer?.isSpectator
    ? 'PLAYER 1'
    : firstPlayer?.id === socket?.id ? 'YOU' : 'OPPONENT';
  const secondOwner = currentRoom?.viewer?.isSpectator
    ? 'PLAYER 2'
    : firstOwner === 'YOU' ? 'OPPONENT' : 'YOU';
  const first = createRevealCard(lastRound.p1Card, firstOwner);
  first.classList.add('left');
  const versus = document.createElement('div');
  versus.className = 'reveal-versus';
  const versusMark = document.createElement('b');
  versusMark.textContent = 'VS';
  const winner = document.createElement('span');
  const awardText = Number.isFinite(lastRound.awardedCards) ? ` · +${lastRound.awardedCards}` : '';
  winner.textContent = lastRound.winner === 'Draw'
    ? 'DRAW · STACK +2'
    : `AWARD${awardText}`;
  versus.append(versusMark, winner);
  const second = createRevealCard(lastRound.p2Card, secondOwner);
  second.classList.add('right');
  result.append(outcome, first, versus, second);
  elements.revealArea.replaceChildren(result);

  if (isNewRound) {
    window.setTimeout(() => elements.revealArea.classList.remove('reveal-new'), 600);
  }
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
    number.textContent = `R${round.round}`;
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    const winner = document.createElement('strong');
    winner.textContent = round.winner === 'Draw' ? '引き分け · スタック' : `${round.winner} が獲得`;
    const cards = document.createElement('span');
    cards.textContent = `${round.p1Card.name}  vs  ${round.p2Card.name}`;
    detail.append(winner, cards);
    item.append(number, detail);
    elements.history.append(item);
  });
}

function renderStatus(room, me, opponent) {
  if (!socket?.connected) {
    setText(elements.status, '接続が切れました。自動的に再接続しています…');
    return;
  }
  if (room.viewer.isSpectator) {
    setText(elements.status, '観戦中です。手札と勝負の行方を見守れます。');
    return;
  }
  if (room.gameState === 'waiting') {
    setText(elements.status, '対戦相手の入室を待っています…');
  } else if (room.gameState === 'reconnecting') {
    setText(elements.status, '対戦相手の再接続を待っています。制限時間は停止中です。');
  } else if (room.gameState === 'playing') {
    setText(elements.status, room.viewer.hasConfirmedSelection
      ? 'カードを伏せました。相手の選択を待っています…'
      : '一枚を選び、相手の思考を読んでください。');
  } else if (room.gameState === 'finished') {
    const opponentDisconnected = opponent?.connected === false;
    setText(elements.status, opponentDisconnected
      ? '対戦相手の再接続を待っています。'
      : `ゲーム終了 — ${room.winner}`);
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
    spectatorCount: room.spectatorCount ?? room.spectators?.length ?? 0,
    viewer: room.viewer || {
      isSpectator: !room.players.some((player) => player.id === socket?.id),
      hasConfirmedSelection: Boolean(room.selections?.[socket?.id])
    }
  };
  currentRoom = roomView;
  showGameScreen();
  setText(elements.roomId, roomView.id);
  setText(elements.round, roomView.round);
  setText(elements.stack, roomView.stack.length);

  const me = roomView.players.find((player) => player.id === socket?.id);
  const opponent = roomView.players.find((player) => player.id !== socket?.id);
  const isInteractive = Boolean(me && !roomView.viewer.isSpectator && roomView.gameState === 'playing' && !roomView.viewer.hasConfirmedSelection);

  if (me) {
    if (!me.hand.some((card) => card.id === mySelectedCardId)) mySelectedCardId = null;
    if (!me.hand.some((card) => card.id === committedCardId)) committedCardId = null;
    setText(elements.myName, me.name);
    updateScore(elements.myScore, me);
    renderHand(elements.myHand, me.hand, 'spade', isInteractive);
  } else {
    mySelectedCardId = null;
    setText(elements.myName, '観戦者');
    setText(elements.myScore, '—');
    elements.myHand.replaceChildren();
  }

  if (opponent) {
    setText(elements.opponentName, opponent.connected === false ? `${opponent.name}（再接続中）` : opponent.name);
    updateScore(elements.opponentScore, opponent);
    renderHand(elements.opponentHand, opponent.hand, 'heart', false);
  } else {
    setText(elements.opponentName, '対戦相手を待機中');
    setText(elements.opponentScore, '0');
    elements.opponentHand.replaceChildren();
  }

  const spectatorLabel = roomView.spectatorCount ? `観戦 ${roomView.spectatorCount}` : '';
  setText(elements.spectatorCount, spectatorLabel);
  elements.spectatorCount.classList.toggle('hidden', !spectatorLabel);
  elements.confirmButton.classList.toggle('hidden', roomView.gameState === 'finished' || roomView.viewer.isSpectator);
  elements.restartButton.classList.toggle('hidden', roomView.gameState !== 'finished' || roomView.viewer.isSpectator);
  elements.restartButton.disabled = Boolean(opponent && opponent.connected === false);
  elements.homeButton.classList.toggle('hidden', !['waiting', 'finished'].includes(roomView.gameState));

  renderTimer(roomView);
  renderReveal(roomView.lastRound || roomView.history?.[roomView.history.length - 1]);
  renderHistory(roomView.history);
  renderStatus(roomView, me, opponent);
  updateConfirmButton();
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
  currentRoomId = elements.roomIdInput.value.trim();
  myPlayerName = elements.playerNameInput.value.trim() || 'Player';
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
  if (socket && currentRoomId) socket.emit('restart_game', { roomId: currentRoomId });
});

elements.homeButton.addEventListener('click', () => {
  const roomIdToLeave = currentRoomId;
  if (socket?.connected && roomIdToLeave) socket.emit('leave_room', { roomId: roomIdToLeave });

  joinedRoom = false;
  currentRoomId = '';
  mySelectedCardId = null;
  committedCardId = null;
  currentRoom = null;
  lastRoundId = null;
  previousScores.clear();
  clearSavedSession();
  resetTimer();
  elements.homeButton.classList.add('hidden');
  elements.joinButton.disabled = false;
  setLoginMessage('');
  showLoginScreen();
  elements.roomIdInput.focus();
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
    if (joinedRoom) emitJoinRequest();
  });

  socket.on('disconnect', () => {
    setConnectionState(false);
    if (currentRoom) renderStatus(currentRoom, null, null);
  });

  socket.on('connect_error', () => {
    setConnectionState(false, '接続を試行中');
    if (!currentRoom) setLoginMessage('サーバーへ接続しています…');
  });

  socket.on('room_updated', (room) => {
    elements.joinButton.disabled = false;
    setLoginMessage('');
    renderRoom(room);
  });

  socket.on('room_error', ({ message }) => {
    elements.joinButton.disabled = false;
    if (!currentRoom) {
      joinedRoom = false;
      clearSavedSession();
      setLoginMessage(message || '入室できませんでした。');
    } else {
      setText(elements.status, message || '操作を完了できませんでした。');
    }
  });
} else {
  setConnectionState(false, '通信を開始できません');
}
