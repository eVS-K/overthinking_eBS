'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialHand } = require('./game-rules');
const {
  CLASSIC_ROUND_LIMIT,
  CLASSIC_SCORE_TARGET,
  MAX_CHAT_IPS_PER_ROOM,
  PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS,
  PRIVATE_ROOM_IDLE_TTL_MS,
  areRandomMatchEntriesCompatible,
  app,
  buildPrivateSettingsUpdate,
  buildDefaultAllowedOrigins,
  consumeChatIpQuota,
  createRoom,
  createRoomView,
  ensurePrivateRoomHost,
  finishGameByForfeit,
  getSelectableCardIds,
  getRoomTurnTimeLimitMs,
  isPrivateRoomIdleExpired,
  normalizeJoinPreferences,
  processTurn,
  promoteVolunteerSpectators,
  setSpectatorAutoJoin,
  startWhenBothPlayersAgree,
  updatePrivateRoomSettings
} = require('./server');

test('直前の対戦相手を避けるランダム待機同士は、即時に再マッチしない', () => {
  assert.equal(areRandomMatchEntriesCompatible(
    { clientId: 'first', avoidClientId: 'second' },
    { clientId: 'second', avoidClientId: 'first' }
  ), false);
  assert.equal(areRandomMatchEntriesCompatible(
    { clientId: 'first', avoidClientId: 'second' },
    { clientId: 'third', avoidClientId: '' }
  ), true);
});

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

test('Private設定イベントは拡張ルールの全フィールドを権威的な更新関数へ渡す', () => {
  const payload = {
    roomId: 'ignored-at-this-boundary',
    configRevision: 4,
    ruleset: 'private-expanded-v1',
    turnTimeLimitMs: 120_000,
    roundLimit: 8,
    scoreTarget: null,
    blankEnabled: true,
    deck: [{ definitionId: 'ace', copies: 2 }]
  };
  assert.deepEqual(buildPrivateSettingsUpdate(payload, 'server-player'), {
    clientId: 'server-player',
    configRevision: 4,
    ruleset: 'private-expanded-v1',
    turnTimeLimitMs: 120_000,
    roundLimit: 8,
    scoreTarget: null,
    blankEnabled: true,
    deck: [{ definitionId: 'ace', copies: 2 }]
  });
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

test('Private PvPだけが60/90/120秒の設定を持ち、開始同意は設定変更で必ず取り消される', () => {
  const room = createRoom('private-settings');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '作成者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');

  assert.deepEqual(PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS, [60_000, 90_000, 120_000]);
  assert.equal(getRoomTurnTimeLimitMs(room), 90_000);
  const changed = updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: 1,
    turnTimeLimitMs: 120_000
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.changed, true);
  assert.equal(room.configRevision, 2);
  assert.equal(getRoomTurnTimeLimitMs(room), 120_000);
  assert.equal(room.startAgreements.size, 0);
  assert.equal(changed.settings.roundLimit, CLASSIC_ROUND_LIMIT);
  assert.equal(changed.settings.scoreTarget, CLASSIC_SCORE_TARGET);
  assert.equal(changed.settings.timeoutPolicy, 'random-legal');

  const stale = updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: 1,
    turnTimeLimitMs: 60_000
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(getRoomTurnTimeLimitMs(room), 120_000);
});

test('Private設定はホスト・待機/終了状態だけに限定され、開始済みの設定スナップショットは凍結される', () => {
  const room = createRoom('private-settings-guard');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '作成者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';

  const nonHost = updatePrivateRoomSettings(room, {
    clientId: 'guest-client',
    configRevision: room.configRevision,
    turnTimeLimitMs: 60_000
  });
  assert.equal(nonHost.ok, false);
  assert.equal(getRoomTurnTimeLimitMs(room), 90_000);

  const invalidValue = updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    turnTimeLimitMs: 61_000
  });
  assert.equal(invalidValue.ok, false);

  room.privateConfig = { ...room.privateConfig, turnTimeLimitMs: 120_000 };
  room.activePrivateConfig = { ...room.privateConfig, turnTimeLimitMs: 60_000 };
  room.gameState = 'playing';
  assert.equal(getRoomTurnTimeLimitMs(room), 60_000);
  const duringGame = updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    turnTimeLimitMs: 90_000
  });
  assert.equal(duringGame.ok, false);
  assert.equal(getRoomTurnTimeLimitMs(room), 60_000);

  const randomRoom = createRoom('random-settings-guard', { matchType: 'random' });
  assert.equal(getRoomTurnTimeLimitMs(randomRoom), 90_000);
  assert.equal(updatePrivateRoomSettings(randomRoom, {
    clientId: 'host-client',
    configRevision: 0,
    turnTimeLimitMs: 120_000
  }).ok, false);
});

test('選択したPrivateの制限時間は開始時に凍結され、対局タイマーへ引き継がれる', () => {
  const room = createRoom('private-timer-snapshot');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '設定担当者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    turnTimeLimitMs: 120_000
  }).ok, true);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');

  assert.equal(startWhenBothPlayersAgree(room), true);
  assert.equal(room.gameState, 'playing');
  assert.equal(room.activePrivateConfig.turnTimeLimitMs, 120_000);
  assert.equal(room.pausedRemainingMs, 120_000);
  assert.equal(getRoomTurnTimeLimitMs(room), 120_000);
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('Private拡張ではBlankを手札外の選択肢として公開し、処理後も手札を消費しない', () => {
  const room = createRoom('expanded-blank-room');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  const configured = updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    ruleset: 'private-expanded-v1',
    turnTimeLimitMs: 90_000,
    roundLimit: 3,
    scoreTarget: null,
    blankEnabled: true,
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'ten', copies: 1 }
    ]
  });
  assert.equal(configured.ok, true);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(room), true);
  assert.equal(room.activePrivateConfig.ruleset, 'private-expanded-v1');
  assert.equal(getSelectableCardIds(room, room.players[0]).includes('virtual-blank'), true);
  assert.equal(room.players[0].hand.length, 5);

  room.selections = { p1: 'virtual-blank', p2: room.players[1].hand.find((card) => card.definitionId === 'ace').id };
  processTurn(room);
  assert.equal(room.players[0].hand.length, 5);
  assert.equal(room.players[1].hand.length, 4);
  assert.equal(room.players[1].score, 1);
  assert.equal(room.lastRound.p1Card.id, 'virtual-blank');
  assert.equal(room.lastRound.awardedCards, 1);
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('BlankなしのPrivate拡張は、Blankを選択肢やタイムアウト候補として公開しない', () => {
  const room = createRoom('expanded-no-blank-room');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    ruleset: 'private-expanded-v1',
    roundLimit: 3,
    scoreTarget: null,
    blankEnabled: false,
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'ten', copies: 1 }
    ]
  }).ok, true);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(room), true);
  assert.equal(getSelectableCardIds(room, room.players[0]).includes('virtual-blank'), false);
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('条件型TarotはPrivate拡張の手札へ現在の強さを公開し、結果履歴へ確定値を保存する', () => {
  const room = createRoom('expanded-conditional-tarot-room');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    ruleset: 'private-expanded-v1',
    roundLimit: 3,
    scoreTarget: null,
    blankEnabled: false,
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'death', copies: 1 }
    ]
  }).ok, true);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(room), true);

  const death = room.players[0].hand.find((card) => card.definitionId === 'death');
  const ace = room.players[1].hand.find((card) => card.definitionId === 'ace');
  assert.deepEqual(death.roundInfo, {
    strength: 13,
    detail: '現在の獲得札は 0枚 ≤ 相手 0枚のため、強さ13です。',
    conditional: true
  });
  room.selections = { p1: death.id, p2: ace.id };
  processTurn(room);
  assert.equal(room.lastRound.p1Strength, 13);
  assert.equal(room.lastRound.p2Strength, 14);
  assert.equal(room.lastRound.winnerSeat, 'p2');
  const view = createRoomView(room, 'p1');
  assert.equal(view.history[0].p1Strength, 13);
  assert.equal(view.lastRound.p2Strength, 14);
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('room viewは設定の公開情報だけを返し、ホスト退室後に残った対戦者へ管理権限を移せる', () => {
  const room = createRoom('private-host-view');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '作成者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  const hostView = createRoomView(room, 'p1');
  const guestView = createRoomView(room, 'p2');
  assert.equal(hostView.viewer.isRoomHost, true);
  assert.equal(hostView.viewer.isHost, true);
  assert.equal(guestView.viewer.isRoomHost, false);
  assert.equal(hostView.rules.turnTimeLimitMs, 90_000);
  assert.equal(hostView.rules.locked, false);
  assert.equal(JSON.stringify(hostView).includes('hostClientId'), false);

  room.players.shift();
  assert.equal(ensurePrivateRoomHost(room), 'guest-client');
  assert.equal(createRoomView(room, 'p2').viewer.isRoomHost, true);
});

test('観戦者には常に両者の手札を渡し、空席参加予約を順番どおりに扱う', () => {
  const room = createRoom('spectator-view');
  room.players = [
    { id: 'p1', clientId: 'p1-client', name: '♠側', suit: '♠', hand: [{ id: 'ace' }], score: 2, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '♥側', suit: '♥', hand: [{ id: 'king' }], score: 3, connected: true }
  ];
  room.spectators = [
    { id: 'viewer', clientId: 'viewer-client', name: '観戦者', autoJoinWhenSeatAvailable: false },
    { id: 'first-volunteer', clientId: 'first-volunteer-client', name: '先着希望者', autoJoinWhenSeatAvailable: true },
    { id: 'second-volunteer', clientId: 'second-volunteer-client', name: '次の希望者', autoJoinWhenSeatAvailable: true }
  ];
  const view = createRoomView(room, 'viewer');
  assert.equal(view.viewer.isSpectator, true);
  assert.equal(view.viewer.autoJoinWhenSeatAvailable, false);
  assert.equal(view.viewer.seatQueuePosition, null);
  assert.equal(view.viewer.seatQueueLength, 2);
  assert.deepEqual(view.players.map((player) => player.hand[0].id), ['ace', 'king']);

  const secondVolunteerView = createRoomView(room, 'second-volunteer');
  assert.equal(secondVolunteerView.viewer.seatQueuePosition, 2);
  assert.equal(secondVolunteerView.viewer.seatQueueLength, 2);

  room.players.pop();
  const promoted = promoteVolunteerSpectators(room, (socketId) => socketId === 'first-volunteer' ? {} : null);
  assert.equal(promoted, 1);
  assert.equal(room.players[1].id, 'first-volunteer');
  assert.deepEqual(room.spectators.map((spectator) => spectator.id), ['viewer', 'second-volunteer']);
});

test('観戦者は部屋内で参加予約をいつでも変更でき、再予約は列の最後尾になる', () => {
  const room = createRoom('spectator-queue-order');
  const first = { id: 'first', clientId: 'first-client', name: '先着', autoJoinWhenSeatAvailable: false, seatQueueOrder: 0 };
  const second = { id: 'second', clientId: 'second-client', name: '次点', autoJoinWhenSeatAvailable: false, seatQueueOrder: 0 };
  room.spectators = [first, second];

  setSpectatorAutoJoin(room, second, true);
  setSpectatorAutoJoin(room, first, true);
  assert.equal(createRoomView(room, 'second').viewer.seatQueuePosition, 1);
  assert.equal(createRoomView(room, 'first').viewer.seatQueuePosition, 2);

  setSpectatorAutoJoin(room, second, false);
  assert.equal(createRoomView(room, 'first').viewer.seatQueuePosition, 1);
  assert.equal(createRoomView(room, 'second').viewer.seatQueuePosition, null);

  setSpectatorAutoJoin(room, second, true);
  assert.equal(createRoomView(room, 'first').viewer.seatQueuePosition, 1);
  assert.equal(createRoomView(room, 'second').viewer.seatQueuePosition, 2);
});

test('♠側の退出後に観戦者が昇格しても、両席のスートは必ず♠・♥になる', () => {
  const room = createRoom('spectator-seat-integrity');
  room.players = [
    { id: 'heart-player', clientId: 'heart-client', name: '残った人', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.spectators = [
    { id: 'volunteer', clientId: 'volunteer-client', name: '昇格する人', autoJoinWhenSeatAvailable: true }
  ];

  assert.equal(promoteVolunteerSpectators(room, () => ({})), 1);
  assert.deepEqual(room.players.map((player) => player.name), ['残った人', '昇格する人']);
  assert.deepEqual(room.players.map((player) => player.suit), ['♠', '♥']);
  const observerView = createRoomView(room, 'not-a-member');
  assert.deepEqual(observerView.players.map((player) => player.suit), ['♠', '♥']);
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

  const [health, healthFromPages, ready, ranked, rankedUi, legacyIndex, oauthRecovery, socketLoader, pageRedirect, playGateway, playGatewayScript] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/health`),
    fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://evs-k.github.io' } }),
    fetch(`http://127.0.0.1:${port}/readyz`),
    fetch(`http://127.0.0.1:${port}/ranked`),
    fetch(`http://127.0.0.1:${port}/ranked-ui.js`),
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/oauth-recovery.js`),
    fetch(`http://127.0.0.1:${port}/socket-loader.js`),
    fetch(`http://127.0.0.1:${port}/page-redirect.js`),
    fetch(`http://127.0.0.1:${port}/play.html`),
    fetch(`http://127.0.0.1:${port}/play-gateway.js`)
  ]);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(healthFromPages.headers.get('access-control-allow-origin'), 'https://evs-k.github.io');
  assert.equal(healthFromPages.headers.get('vary'), 'Origin');
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
  assert.match(legacyHtml, /page-redirect\.js\?v=security-v4/);
  assert.match(legacyHtml, /Content-Security-Policy/);
  assert.match(legacyHtml, /socket-loader\.js/);
  assert.equal(socketLoader.status, 200);
  const socketLoaderText = await socketLoader.text();
  assert.match(socketLoaderText, /overthinking-ebs\.onrender\.com\/socket\.io\/socket\.io\.js/);
  assert.match(socketLoaderText, /\/socket\.io\/socket\.io\.js/);
  assert.doesNotMatch(legacyHtml, /cdn\.socket\.io/);
  assert.equal(pageRedirect.status, 200);
  const redirectScript = await pageRedirect.text();
  assert.match(redirectScript, /play\.html/);
  assert.match(redirectScript, /window\.location\.replace/);
  assert.equal(playGateway.status, 200);
  assert.match(await playGateway.text(), /対戦サーバーを起動しています/);
  assert.equal(playGatewayScript.status, 200);
  assert.match(await playGatewayScript.text(), /window\.fetch\(healthUrl/);
  assert.equal(oauthRecovery.status, 200);
  assert.match(await oauthRecovery.text(), /HttpOnly transaction cookie/);
});
