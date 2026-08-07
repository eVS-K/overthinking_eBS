const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const TURN_TIME_LIMIT = 90; // 制限時間（s）

const INITIAL_HAND = [
  { id: 'ace', name: 'Ace', strength: 14, desc: '能力なし' },
  { id: 'king', name: 'King', strength: 13, desc: '能力なし' },
  { id: 'queen', name: 'Queen', strength: 12, desc: '能力なし' },
  { id: 'jack', name: 'Jack', strength: 11, desc: '能力なし' },
  { id: 'joker', name: 'Joker', strength: 0, desc: '相手の強さをコピー' },
  { id: 'three', name: 'Three', strength: 3, desc: 'Jokerに勝利' },
  { id: 'two', name: 'Two', strength: 2, desc: 'Aceに勝利' }
];

const rooms = {};
const roomTimers = {};

function resolveRound(c1, c2) {
  if (c1.id === 'two' && c2.id === 'ace') return 'p1';
  if (c2.id === 'two' && c1.id === 'ace') return 'p2';
  if (c1.id === 'three' && c2.id === 'joker') return 'p1';
  if (c2.id === 'three' && c1.id === 'joker') return 'p2';

  let s1 = c1.id === 'joker' ? (c2.id === 'joker' ? 0 : c2.strength) : c1.strength;
  let s2 = c2.id === 'joker' ? (c1.id === 'joker' ? 0 : c1.strength) : c2.strength;

  if (s1 > s2) return 'p1';
  if (s2 > s1) return 'p2';
  return 'draw';
}

// タイマーの開始
function startTurnTimer(roomId) {
  if (roomTimers[roomId]) clearTimeout(roomTimers[roomId]);

  const room = rooms[roomId];
  if (!room || room.gameState !== 'playing') return;

  room.deadline = Date.now() + TURN_TIME_LIMIT * 1000;

  roomTimers[roomId] = setTimeout(() => {
    // 時間切れ時：未選択のプレイヤーのカードをランダムに選択
    room.players.forEach(p => {
      if (!room.selections[p.id] && p.hand.length > 0) {
        const randomIdx = Math.floor(Math.random() * p.hand.length);
        room.selections[p.id] = p.hand[randomIdx].id;
      }
    });
    processTurn(roomId);
  }, TURN_TIME_LIMIT * 1000);
}

// ターンの判定処理
function processTurn(roomId) {
  if (roomTimers[roomId]) clearTimeout(roomTimers[roomId]);

  const room = rooms[roomId];
  if (!room) return;

  const p1 = room.players[0];
  const p2 = room.players[1];

  const c1Id = room.selections[p1.id];
  const c2Id = room.selections[p2.id];

  const c1Index = p1.hand.findIndex(c => c.id === c1Id);
  const c2Index = p2.hand.findIndex(c => c.id === c2Id);

  const [c1] = p1.hand.splice(c1Index, 1);
  const [c2] = p2.hand.splice(c2Index, 1);

  const result = resolveRound(c1, c2);
  const totalCards = 2 + room.stack.length;

  let roundWinner = null;
  if (result === 'p1') {
    p1.score += totalCards;
    roundWinner = p1.name;
    room.stack = [];
  } else if (result === 'p2') {
    p2.score += totalCards;
    roundWinner = p2.name;
    room.stack = [];
  } else {
    room.stack.push(c1, c2);
    roundWinner = 'Draw';
  }

  room.history.push({
    round: room.round,
    p1Card: c1,
    p2Card: c2,
    winner: roundWinner
  });

  room.selections = {};

  if (p1.score > 8 || p2.score > 8 || room.round >= 7) {
    room.gameState = 'finished';
    let winnerName = '引き分け';
    if (p1.score > p2.score) winnerName = p1.name;
    else if (p2.score > p1.score) winnerName = p2.name;
    room.winner = winnerName;
  } else {
    room.round += 1;
    startTurnTimer(roomId);
  }

  io.to(roomId).emit('room_updated', room);
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, playerName }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [],
        spectators: [],
        round: 1,
        stack: [],
        history: [],
        gameState: 'waiting',
        selections: {},
        deadline: 0
      };
    }

    const room = rooms[roomId];
    const existingPlayer = room.players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      if (room.players.length < 2) {
        const suit = room.players.length === 0 ? '♠' : '♥';
        room.players.push({
          id: socket.id,
          name: playerName,
          suit: suit,
          hand: JSON.parse(JSON.stringify(INITIAL_HAND)),
          score: 0
        });

        if (room.players.length === 2) {
          room.gameState = 'playing';
          startTurnTimer(roomId);
        }
      } else {
        room.spectators.push({ id: socket.id, name: playerName });
      }
    }

    io.to(roomId).emit('room_updated', room);
  });

  socket.on('confirm_card', ({ roomId, cardId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'playing') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];
    if (!cardId && player.hand.length > 0) {
      const randomIdx = Math.floor(Math.random() * player.hand.length);
      cardId = player.hand[randomIdx].id;
    }

    room.selections[socket.id] = cardId;

    if (Object.keys(room.selections).length === 2) {
      processTurn(roomId);
    } else {
      io.to(roomId).emit('room_updated', room);
    }
  });

  socket.on('restart_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.round = 1;
    room.stack = [];
    room.history = [];
    room.selections = {};
    delete room.winner;

    room.players.forEach(p => {
      p.hand = JSON.parse(JSON.stringify(INITIAL_HAND));
      p.score = 0;
    });

    if (room.players.length === 2) {
      room.gameState = 'playing';
      startTurnTimer(roomId);
    } else {
      room.gameState = 'waiting';
    }

    io.to(roomId).emit('room_updated', room);
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const pIndex = room.players.findIndex(p => p.id === socket.id);
      if (pIndex !== -1) {
        room.players.splice(pIndex, 1);
        room.gameState = 'waiting';
        if (roomTimers[roomId]) clearTimeout(roomTimers[roomId]);
        io.to(roomId).emit('room_updated', room);
        break;
      }
    }
  });
});

server.listen(3000, () => console.log('Server 起動中: http://localhost:3000'));