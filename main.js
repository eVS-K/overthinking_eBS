const socket = io('https://overthinking-demo.onrender.com');

let currentRoomId = '';
let mySelectedCardId = null;
let myPlayerName = '';
let timerInterval = null;

window.addEventListener('DOMContentLoaded', () => {
  const loginScreen = document.getElementById('login-screen');
  const gameScreen = document.getElementById('game-screen');
  const joinBtn = document.getElementById('joinBtn');
  const confirmBtn = document.getElementById('confirmBtn');
  const restartBtn = document.getElementById('restartBtn');

  joinBtn.addEventListener('click', () => {
    const roomId = document.getElementById('roomIdInput').value.trim();
    myPlayerName = document.getElementById('playerNameInput').value.trim() || 'Player';
    
    if (!roomId) return alert('部屋キーを入力してください');
    currentRoomId = roomId;

    document.getElementById('display-room-id').textContent = roomId;

    socket.emit('join_room', { roomId, playerName: myPlayerName });

    loginScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
  });

  confirmBtn.addEventListener('click', () => {
    if (!mySelectedCardId) return;
    socket.emit('confirm_card', { roomId: currentRoomId, cardId: mySelectedCardId });
    mySelectedCardId = null;
    confirmBtn.disabled = true;
  });

  restartBtn.addEventListener('click', () => {
    socket.emit('restart_game', { roomId: currentRoomId });
  });
});

socket.on('room_updated', (room) => {
  document.getElementById('current-round').textContent = room.round;
  document.getElementById('stack-count').textContent = room.stack.length;

  // 1. 自分の情報取得（Socket ID または 名前で判定）
  const me = room.players.find(p => p.id === socket.id) || 
             room.players.find(p => p.name === myPlayerName);

  // 2. 相手の情報取得（自分以外のプレイヤー）
  const opp = room.players.find(p => p !== me);

  // 自分の手札描画
  if (me) {
    document.getElementById('my-name').textContent = me.name;
    document.getElementById('my-score').textContent = me.score;
    renderHand('my-hand', me.hand, 'spade', true);
  }

  // 相手エリアの描画
  if (opp) {
    document.getElementById('opp-name').textContent = opp.name;
    document.getElementById('opp-score').textContent = opp.score;
    // 相手が入室したら手札を表示
    renderHand('opp-hand', opp.hand, 'heart', false);
  } else {
    // 相手がまだいない（待機中）とき
    document.getElementById('opp-name').textContent = '待機中...';
    document.getElementById('opp-score').textContent = '0';
    // カード描画領域を空にして枠だけ保つ
    document.getElementById('opp-hand').innerHTML = '';
  }

  const statusEl = document.getElementById('status-message');
  const confirmBtn = document.getElementById('confirmBtn');
  const restartBtn = document.getElementById('restartBtn');

  // カウントダウン処理
  if (timerInterval) clearInterval(timerInterval);

  if (room.gameState === 'playing' && room.deadline) {
    const updateTimer = () => {
      const remain = Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000));
      document.getElementById('timer-count').textContent = remain;
    };
    updateTimer();
    timerInterval = setInterval(updateTimer, 500);
  } else {
    document.getElementById('timer-count').textContent = '--';
  }

  // 状態ごとのUI切替
  if (room.gameState === 'waiting') {
    statusEl.textContent = '対戦相手の入室を待っています...';
    confirmBtn.classList.remove('hidden');
    confirmBtn.disabled = true;
    restartBtn.classList.add('hidden');
  } else if (room.gameState === 'playing') {
    statusEl.textContent = room.selections[socket.id] ? '相手の選択待ち...' : 'カードを選択してください';
    confirmBtn.classList.remove('hidden');
    restartBtn.classList.add('hidden');
  } else if (room.gameState === 'finished') {
    statusEl.textContent = `ゲーム終了！ 勝者: ${room.winner}`;
    confirmBtn.classList.add('hidden');
    restartBtn.classList.remove('hidden');
  }

  renderHistory(room.history);
});

function renderHand(containerId, hand, suitType, isInteractive) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!hand) return;

  const suitIcon = suitType === 'spade' ? '♠' : '♥';
  const cardClass = suitType === 'spade' ? 'card-spade' : 'card-heart';

  hand.forEach(card => {
    const el = document.createElement('div');
    el.className = `card ${cardClass}` + (card.id === mySelectedCardId ? ' selected' : '');
    
    el.innerHTML = `
      <div class="card-top">
        <span>${card.name}</span>
        <span>${suitIcon}</span>
      </div>
      <div class="card-center-suit">${suitIcon}</div>
      <div class="card-desc">${card.desc}</div>
    `;

    if (isInteractive) {
      el.addEventListener('click', () => {
        mySelectedCardId = (mySelectedCardId === card.id) ? null : card.id;
        document.getElementById('confirmBtn').disabled = !mySelectedCardId;
        renderHand(containerId, hand, suitType, true);
      });
    }
    container.appendChild(el);
  });
}

function renderHistory(history) {
  const container = document.getElementById('history-list');
  container.innerHTML = '';
  history.forEach(h => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `<strong>R${h.round}:</strong> 勝者: ${h.winner}<br><small>${h.p1Card.name} vs ${h.p2Card.name}</small>`;
    container.appendChild(item);
  });
}