'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialHand } = require('./game-rules');
const { createExpandedPrivateRoomConfig } = require('./private-room-config');
const { createExpandedPrivateGameState } = require('./private-game-engine');
const { PRIVATE_ACTION_TIMEOUT_MS, createPrivatePendingAction } = require('./private-action-queue');
const {
  CLASSIC_ROUND_LIMIT,
  CLASSIC_SCORE_TARGET,
  FIRST_ROUND_TIME_BONUS_MS,
  MAX_CHAT_IPS_PER_ROOM,
  PRIVATE_TURN_TIME_LIMIT_OPTIONS_MS,
  PRIVATE_ROOM_IDLE_TTL_MS,
  RECONNECT_GRACE_MS,
  areRandomMatchEntriesCompatible,
  app,
  beginPrivateRoomSettingsEdit,
  beginSunPreCommitAction,
  beginReconnectGrace,
  buildPrivateSettingsUpdate,
  buildDefaultAllowedOrigins,
  cancelReconnectGrace,
  completePrivatePendingAction,
  consumeChatIpQuota,
  createRoom,
  createRoomView,
  ensurePrivateRoomHost,
  expireDisconnectedPlayer,
  finishGameByForfeit,
  finishPrivateRoomSettingsEdit,
  getPublicRoomRules,
  getSelectableCardIds,
  getRoomTurnTimeLimitMs,
  getRoomRoundTimeLimitMs,
  isPrivateRoomIdleExpired,
  normalizeJoinPreferences,
  processTurn,
  publicExpandedRoundEffect,
  pauseForReconnect,
  promoteVolunteerSpectators,
  restoreReturningPlayer,
  resumeAfterReconnect,
  setSpectatorAutoJoin,
  startWhenBothPlayersAgree,
  transferPrivateRoomSettingsOwner,
  updatePrivateRoomSettings,
  server,
  SOCKET_EVENTS_WITH_OBJECT_PAYLOAD,
  normalizeSocketEventPayload,
  getRoomSpectatorLimit
} = require('./server');

function beginSettingsEdit(room, clientId = 'host-client') {
  const result = beginPrivateRoomSettingsEdit(room, clientId);
  assert.equal(result.ok, true, 'the settings owner must explicitly enter edit mode');
  return result;
}

function finishSettingsEdit(room, clientId = 'host-client') {
  const result = finishPrivateRoomSettingsEdit(room, clientId);
  assert.equal(result.ok, true, 'the settings owner must explicitly complete edit mode');
  return result;
}

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

async function openRawPollingSocket(port) {
  const origin = 'https://evs-k.github.io';
  const handshake = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: origin }
  });
  assert.equal(handshake.status, 200);
  const openPacket = await handshake.text();
  const sid = JSON.parse(openPacket.slice(1)).sid;
  assert.equal(typeof sid, 'string');
  const url = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`;
  const headers = { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8' };
  const connected = await fetch(url, { method: 'POST', headers, body: '40' });
  assert.equal(connected.status, 200);
  return { url, headers };
}

test('不正なSocket payloadは接続内で拒否され、Node processを停止させない', async (t) => {
  const port = await start(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const polling = await openRawPollingSocket(port);
  const malformed = await fetch(polling.url, {
    method: 'POST',
    headers: polling.headers,
    body: '42["join_room",null]'
  });
  assert.equal(malformed.status, 200);

  // Socket event delivery is asynchronous.  The regression is the process
  // survival after a raw `null` payload that previously threw in join_room.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);

  await fetch(polling.url, { method: 'POST', headers: polling.headers, body: '41' });
});

test('object payloadを要求するSocket eventは不正なJSON値を安全な空objectへ正規化する', () => {
  for (const eventName of SOCKET_EVENTS_WITH_OBJECT_PAYLOAD) {
    for (const invalidPayload of [null, false, 0, 'text', []]) {
      const event = [eventName, invalidPayload];
      normalizeSocketEventPayload(event);
      assert.deepEqual(event, [eventName, {}], `${eventName} must reject ${typeof invalidPayload}`);
    }
  }
});

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

test('公開する部屋ルールは凍結済み拡張デッキから能力用語集と安全な表示メタデータを生成する', () => {
  const room = createRoom('public-expanded-concepts');
  room.privateConfig = createExpandedPrivateRoomConfig({
    ruleset: 'private-expanded-v1',
    deck: [
      { definitionId: 'the-emperor', copies: 1 },
      { definitionId: 'the-star', copies: 1 },
      { definitionId: 'ace', copies: 3 }
    ],
    roundLimit: 5,
    blankEnabled: true
  });
  const rules = getPublicRoomRules(room);
  assert.deepEqual(rules.activeConcepts.map((concept) => concept.id), [
    'card-addition', 'noise', 'tarot-negation', 'target-selection', 'blank'
  ]);
  const emperor = rules.deckCatalog.find((card) => card.id === 'the-emperor');
  assert.deepEqual(emperor, {
    id: 'the-emperor',
    name: 'The Emperor',
    desc: 'Tarot効果を無効化して勝利',
    baseStrength: 0,
    category: 'tarot',
    displayMark: 'ν',
    faceLabel: 'Emperor',
    visualRole: 'emperor',
    maxCopiesPerDeck: 1
  });

  const classicRules = getPublicRoomRules({ matchType: 'random' });
  assert.deepEqual(classicRules.activeConcepts, []);
  assert.deepEqual(classicRules.deckCatalog, []);
});

test('公開効果は両者向けの対象側を保ち、終局で省略された対象選択だけを安全に説明する', () => {
  assert.deepEqual(publicExpandedRoundEffect({
    type: 'discard-won-cards', sourceSeat: 'p2', sourceDefinitionId: 'the-moon',
    targetSeat: 'p2', discardedCount: 4, privateCardId: 'must-not-leak'
  }), {
    type: 'discard-won-cards', sourceSeat: 'p2', sourceDefinitionId: 'the-moon', targetSeat: 'p2', discardedCount: 4
  });
  assert.deepEqual(publicExpandedRoundEffect({
    type: 'skipped-target-action', sourceSeat: 'p1', sourceDefinitionId: 'justice',
    reason: 'game-ended-before-target-selection', privateReason: 'must-not-leak'
  }), {
    type: 'skipped-target-action', sourceSeat: 'p1', sourceDefinitionId: 'justice',
    reason: 'game-ended-before-target-selection'
  });
  assert.deepEqual(publicExpandedRoundEffect({
    type: 'skipped-target-action', sourceSeat: 'p1', sourceDefinitionId: 'justice', reason: 'arbitrary-engine-detail'
  }), {
    type: 'skipped-target-action', sourceSeat: 'p1', sourceDefinitionId: 'justice'
  });
  assert.equal(publicExpandedRoundEffect({
    type: 'discard-won-cards', sourceSeat: 'p2', sourceDefinitionId: 'the-moon', discardedCount: 4
  }), null, 'missing target seat must fail closed instead of emitting an ambiguous event');
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

test('同じclientIdで10秒以内に戻ると、伏せ札と残りターン時間を維持して対局を再開する', () => {
  const now = 1_000_000;
  const room = createRoom('reconnect-resume');
  const firstHand = createInitialHand();
  room.gameState = 'playing';
  room.deadline = now + 44_000;
  room.players = [
    { id: 'p1-old', clientId: 'first-client', name: '先手', suit: '♠', hand: firstHand, score: 2, connected: false },
    { id: 'p2', clientId: 'second-client', name: '後手', suit: '♥', hand: [], score: 3, connected: true }
  ];
  room.selections = { 'p1-old': 'ace' };

  assert.equal(RECONNECT_GRACE_MS, 10_000);
  assert.equal(pauseForReconnect(room, now), true);
  assert.equal(room.gameState, 'reconnecting');
  assert.equal(room.pausedRemainingMs, 44_000);
  assert.equal(room.deadline, 0);
  assert.equal(room.reconnectDeadline, now + RECONNECT_GRACE_MS);

  const grace = beginReconnectGrace(room, room.players[0], now);
  assert.deepEqual(grace, { generation: 1, deadline: now + RECONNECT_GRACE_MS });
  const pausedView = createRoomView(room, 'p2');
  assert.equal(pausedView.reconnectDeadline, now + RECONNECT_GRACE_MS);
  assert.equal(JSON.stringify(pausedView).includes('disconnectGeneration'), false);
  assert.equal(pausedView.players[0].reconnectDeadline, undefined);

  assert.equal(restoreReturningPlayer(room, room.players[0], 'p1-new', '戻った先手'), 'p1-old');
  assert.equal(room.players[0].connected, true);
  assert.equal(room.players[0].name, '戻った先手');
  assert.deepEqual(room.players[0].hand, firstHand);
  assert.deepEqual(room.selections, { 'p1-new': 'ace' });
  assert.equal(room.players[0].reconnectDeadline, 0);
  assert.equal(resumeAfterReconnect(room), true);
  assert.equal(room.gameState, 'playing');
  assert.equal(room.reconnectDeadline, 0);
  assert.equal(room.pausedRemainingMs, 44_000);
  assert.ok(room.deadline > Date.now());
  assert.equal(createRoomView(room, 'p1-new').reconnectDeadline, 0);

  // resumeAfterReconnect starts the preserved turn timer; end this isolated
  // fixture so it cannot outlive the test.
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('再接続期限は切断世代と同じroom objectにだけ適用され、古いcallbackは状態を壊せない', () => {
  const now = 2_000_000;
  const room = createRoom('reconnect-generation');
  room.gameState = 'reconnecting';
  room.players = [
    { id: 'p1', clientId: 'first-client', name: '切断中', suit: '♠', hand: [], score: 1, connected: false },
    { id: 'p2', clientId: 'second-client', name: '接続中', suit: '♥', hand: [], score: 2, connected: true }
  ];
  const firstGrace = beginReconnectGrace(room, room.players[0], now);
  assert.equal(room.reconnectDeadline, firstGrace.deadline);

  // Reconnecting cancels/invalidates the first callback. A later disconnect
  // obtains a different generation and its own 10-second grace window.
  cancelReconnectGrace(room, room.players[0]);
  room.players[0].connected = false;
  const secondGrace = beginReconnectGrace(room, room.players[0], now + 250);
  assert.ok(secondGrace.generation > firstGrace.generation);
  assert.equal(room.reconnectDeadline, secondGrace.deadline);

  assert.equal(expireDisconnectedPlayer(room, 'first-client', firstGrace.generation, room), false);
  assert.equal(room.players.length, 2);
  assert.equal(expireDisconnectedPlayer(room, 'first-client', secondGrace.generation, createRoom('same-id-different-object')), false);
  assert.equal(room.players.length, 2);

  assert.equal(expireDisconnectedPlayer(room, 'first-client', secondGrace.generation, room), true);
  assert.equal(room.gameState, 'waiting');
  assert.equal(room.reconnectDeadline, 0);
  assert.deepEqual(room.players.map((player) => player.clientId), ['second-client']);
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
  beginSettingsEdit(room);
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

test('Private設定は明示的な編集モードでだけ変更でき、編集中は開始同意を受け付けない', () => {
  const room = createRoom('private-settings-edit-mode');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '設定担当', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');

  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client', configRevision: room.configRevision, turnTimeLimitMs: 60_000
  }).ok, false, 'a direct/stale settings update must not bypass edit mode');

  beginSettingsEdit(room);
  assert.equal(room.startAgreements.size, 0);
  const hostView = createRoomView(room, 'p1');
  const guestView = createRoomView(room, 'p2');
  assert.equal(hostView.settingsEditing, true);
  assert.equal(hostView.viewer.isEditingSettings, true);
  assert.equal(guestView.viewer.isEditingSettings, false);
  assert.equal(hostView.settingsEditorName, '設定担当');

  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(room), false, 'editing must block a stale agree_to_start event');
  assert.equal(finishPrivateRoomSettingsEdit(room, 'guest-client').ok, false);
  finishSettingsEdit(room);
  assert.equal(room.privateSettingsEditingClientId, '');
  assert.equal(startWhenBothPlayersAgree(room), true);
  assert.equal(room.gameState, 'playing');
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
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

  beginSettingsEdit(room);
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

test('Private拡張の観戦者上限は通常Privateより低く、超過した設定変更を拒否する', () => {
  const room = createRoom('expanded-spectator-cap');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '作成者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  const classicLimit = getRoomSpectatorLimit(room);

  beginSettingsEdit(room);
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    ruleset: 'private-expanded-v1'
  }).ok, true);

  const expandedLimit = getRoomSpectatorLimit(room);
  assert.ok(expandedLimit < classicLimit);
  assert.ok(expandedLimit <= 16);
  room.spectators = Array.from({ length: expandedLimit + 1 }, (_item, index) => ({
    id: `spectator-${index}`,
    clientId: `spectator-client-${index}`,
    name: `観戦者${index}`
  }));
  const rejected = updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    turnTimeLimitMs: 60_000
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /観戦者を/);
  assert.equal(getRoomSpectatorLimit(room), expandedLimit, 'rejected update must preserve the active cap');
});

test('Privateの設定担当は接続中の対戦相手へだけ譲れ、旧担当の編集権限は直ちに失効する', () => {
  const room = createRoom('private-settings-owner-transfer');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '作成者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  const revision = room.configRevision;

  const transfer = transferPrivateRoomSettingsOwner(room, 'host-client');
  assert.deepEqual(transfer, {
    ok: true,
    previousOwnerName: '作成者',
    settingsOwnerName: '参加者'
  });
  assert.equal(room.hostClientId, 'guest-client');
  assert.equal(room.configRevision, revision, '設定内容を変えない移譲ではrevisionを消費しない');
  assert.equal(createRoomView(room, 'p1').viewer.isRoomHost, false);
  assert.equal(createRoomView(room, 'p2').viewer.isRoomHost, true);
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: revision,
    turnTimeLimitMs: 60_000
  }).ok, false);
  beginSettingsEdit(room, 'guest-client');
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'guest-client',
    configRevision: revision,
    turnTimeLimitMs: 60_000
  }).ok, true);

  room.gameState = 'playing';
  assert.equal(transferPrivateRoomSettingsOwner(room, 'guest-client').ok, false);
  room.gameState = 'waiting';
  room.players[0].connected = false;
  assert.equal(transferPrivateRoomSettingsOwner(room, 'guest-client').ok, false);
});

test('選択したPrivateの制限時間は開始時に凍結され、対局タイマーへ引き継がれる', () => {
  const room = createRoom('private-timer-snapshot');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '設定担当者', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '参加者', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  beginSettingsEdit(room);
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    turnTimeLimitMs: 120_000
  }).ok, true);
  finishSettingsEdit(room);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');

  assert.equal(startWhenBothPlayersAgree(room), true);
  assert.equal(room.gameState, 'playing');
  assert.equal(room.activePrivateConfig.turnTimeLimitMs, 120_000);
  assert.equal(FIRST_ROUND_TIME_BONUS_MS, 30_000);
  assert.equal(room.pausedRemainingMs, 150_000);
  assert.equal(getRoomTurnTimeLimitMs(room), 120_000);
  assert.equal(getRoomRoundTimeLimitMs(room), 150_000);
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('Private拡張ではBlankを手札外の選択肢として公開し、処理後も手札を消費しない', () => {
  const room = createRoom('expanded-blank-room');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  beginSettingsEdit(room);
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
  finishSettingsEdit(room);
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

test('開始前のPrivate拡張ロビーは、古いクラシック手札でなく設定済みデッキをプレビューする', () => {
  const room = createRoom('expanded-lobby-preview');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: createInitialHand(), score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: createInitialHand(), score: 0, connected: true }
  ];
  room.privateConfig = createExpandedPrivateRoomConfig({
    roundLimit: 5,
    scoreTarget: null,
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'the-sun', copies: 1 }
    ]
  });
  const view = createRoomView(room, 'p1');
  assert.deepEqual(
    view.players[0].hand.map((card) => card.definitionId),
    ['ace', 'king', 'queen', 'jack', 'the-sun']
  );
  assert.equal(view.players[1].hand.every((card) => card.preview === true), true);
  assert.equal(view.players[0].hand.some((card) => card.definitionId === 'joker'), false);
});

test('BlankなしのPrivate拡張は、Blankを選択肢やタイムアウト候補として公開しない', () => {
  const room = createRoom('expanded-no-blank-room');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  beginSettingsEdit(room);
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
  finishSettingsEdit(room);
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
  beginSettingsEdit(room);
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
  finishSettingsEdit(room);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(room), true);

  const death = room.players[0].hand.find((card) => card.definitionId === 'death');
  const ace = room.players[1].hand.find((card) => card.definitionId === 'ace');
  assert.deepEqual(death.roundInfo, {
    strength: 13,
    detail: '現在の獲得札は 0枚 ≤ 相手 0枚のため、強さ13です。',
    conditional: true,
    behaviorDefinitionId: 'death'
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

test('Strengthの半分単位の強さは対局画面と履歴へ安全に公開される', () => {
  const room = createRoom('expanded-strength-public-view');
  room.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'host-client';
  beginSettingsEdit(room);
  assert.equal(updatePrivateRoomSettings(room, {
    clientId: 'host-client',
    configRevision: room.configRevision,
    ruleset: 'private-expanded-v1',
    roundLimit: 4,
    scoreTarget: null,
    blankEnabled: true,
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'strength', copies: 1 }
    ]
  }).ok, true);
  finishSettingsEdit(room);
  room.startAgreements.add('host-client');
  room.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(room), true);

  const ace = room.players[1].hand.find((card) => card.definitionId === 'ace');
  room.selections = { p1: 'virtual-blank', p2: ace.id };
  processTurn(room);
  const strength = room.players[1].hand.find((card) => card.definitionId === 'strength');
  assert.equal(strength.roundInfo.strength, '1.5');

  const jack = room.players[0].hand.find((card) => card.definitionId === 'jack');
  room.selections = { p1: jack.id, p2: strength.id };
  processTurn(room);
  assert.equal(room.lastRound.p2Strength, '1.5');
  const view = createRoomView(room, 'p1');
  assert.equal(view.history.at(-1).p2Strength, '1.5');
  assert.equal(finishGameByForfeit(room, room.players[0]), true);
});

test('生成・総ラウンドTarotはPrivate拡張だけで解決し、公開履歴は内部instanceIdを漏らさない', () => {
  const magicianRoom = createRoom('expanded-magician-public-view');
  magicianRoom.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  magicianRoom.hostClientId = 'host-client';
  beginSettingsEdit(magicianRoom);
  assert.equal(updatePrivateRoomSettings(magicianRoom, {
    clientId: 'host-client',
    configRevision: magicianRoom.configRevision,
    ruleset: 'private-expanded-v1',
    roundLimit: 5,
    scoreTarget: null,
    blankEnabled: false,
    deck: [
      { definitionId: 'the-magician', copies: 1 },
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'four', copies: 1 }
    ]
  }).ok, true);
  finishSettingsEdit(magicianRoom);
  magicianRoom.startAgreements.add('host-client');
  magicianRoom.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(magicianRoom), true);
  magicianRoom.selections = {
    p1: magicianRoom.players[0].hand.find((card) => card.definitionId === 'the-magician').id,
    p2: magicianRoom.players[1].hand.find((card) => card.definitionId === 'ace').id
  };
  processTurn(magicianRoom);
  assert.equal(magicianRoom.players[0].hand.filter((card) => card.definitionId === 'ace').length, 3);
  const magicianView = createRoomView(magicianRoom, 'p1');
  assert.equal(magicianView.rules.effectiveRoundLimit, 5);
  assert.deepEqual(magicianView.history[0].effects, [{
    type: 'add-cards',
    sourceSeat: 'p1',
    sourceDefinitionId: 'the-magician',
    recipientSeat: 'p1',
    definitionId: 'ace',
    createdCopies: 2
  }]);
  assert.equal('cardInstanceIds' in magicianView.history[0].effects[0], false);
  assert.equal(finishGameByForfeit(magicianRoom, magicianRoom.players[0]), true);

  const wheelRoom = createRoom('expanded-wheel-public-view');
  wheelRoom.players = [
    { id: 'p1', clientId: 'host-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'guest-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  wheelRoom.hostClientId = 'host-client';
  beginSettingsEdit(wheelRoom);
  assert.equal(updatePrivateRoomSettings(wheelRoom, {
    clientId: 'host-client',
    configRevision: wheelRoom.configRevision,
    ruleset: 'private-expanded-v1',
    roundLimit: 2,
    scoreTarget: null,
    blankEnabled: false,
    deck: [
      { definitionId: 'wheel-of-fortune', copies: 1 },
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'four', copies: 1 }
    ]
  }).ok, true);
  finishSettingsEdit(wheelRoom);
  wheelRoom.startAgreements.add('host-client');
  wheelRoom.startAgreements.add('guest-client');
  assert.equal(startWhenBothPlayersAgree(wheelRoom), true);
  wheelRoom.selections = {
    p1: wheelRoom.players[0].hand.find((card) => card.definitionId === 'wheel-of-fortune').id,
    p2: wheelRoom.players[1].hand.find((card) => card.definitionId === 'ace').id
  };
  processTurn(wheelRoom);
  const wheelView = createRoomView(wheelRoom, 'p1');
  assert.equal(wheelRoom.gameState, 'finished');
  assert.equal(wheelView.rules.roundLimit, 2, '次戦用の凍結前設定は変更しない');
  assert.equal(wheelView.rules.effectiveRoundLimit, 1);
  assert.deepEqual(wheelView.history[0].effects, [{
    type: 'round-limit-adjustment',
    sourceSeat: 'p1',
    sourceDefinitionId: 'wheel-of-fortune',
    previousRoundLimit: 2,
    nextRoundLimit: 1,
    appliedDelta: -1
  }]);
  beginSettingsEdit(wheelRoom);
  const nextMatchConfig = updatePrivateRoomSettings(wheelRoom, {
    clientId: 'host-client',
    configRevision: wheelRoom.configRevision,
    roundLimit: 3
  });
  assert.equal(nextMatchConfig.ok, true);
  assert.equal(nextMatchConfig.settings.effectiveRoundLimit, 3, '終了済み対局の派生値を次戦ロビーへ持ち込まない');
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

function createAdvancedPrivateRoomForActionTest(id, deck, { roundLimit = 2 } = {}) {
  const room = createRoom(id);
  room.players = [
    { id: 'p1', clientId: 'p1-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.hostClientId = 'p1-client';
  assert.equal(beginSettingsEdit(room, 'p1-client').ok, true);
  const updated = updatePrivateRoomSettings(room, {
    clientId: 'p1-client',
    configRevision: room.configRevision,
    ruleset: 'private-expanded-v1',
    turnTimeLimitMs: 90_000,
    roundLimit,
    scoreTarget: null,
    blankEnabled: true,
    deck: deck.map((definitionId) => ({ definitionId, copies: 1 }))
  });
  assert.equal(updated.ok, true);
  assert.equal(finishSettingsEdit(room, 'p1-client').ok, true);
  room.startAgreements.add('p1-client');
  room.startAgreements.add('p2-client');
  assert.equal(startWhenBothPlayersAgree(room), true);
  return room;
}

function handInstanceId(room, seat, definitionId) {
  const card = room.privateGameState[seat].hand.find((candidate) => candidate.definitionId === definitionId);
  assert.ok(card, `${seat} must hold ${definitionId}`);
  return card.instanceId;
}

test('高度なPrivate対象操作は行為者だけに候補を公開し、一度だけラウンドへ反映する', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('advanced-justice-action', [
    'justice', 'ace', 'king', 'queen', 'jack'
  ]);
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  room.selections = {
    p1: handInstanceId(room, 'p1', 'justice'),
    p2: 'virtual-blank'
  };
  processTurn(room);
  const pending = room.privatePendingAction;
  assert.equal(pending?.phase, 'post-result');
  assert.equal(pending?.action.type, 'lock-one');

  const actorView = createRoomView(room, 'p1');
  const otherView = createRoomView(room, 'p2');
  assert.equal(actorView.viewer.pendingAction.target.candidateIds.length, 5);
  assert.equal(typeof actorView.viewer.pendingAction.nonce, 'string');
  assert.equal(otherView.viewer.pendingAction.target, undefined);
  assert.equal(otherView.viewer.pendingAction.nonce, undefined);

  const target = pending.action.candidates[0];
  assert.deepEqual(completePrivatePendingAction(room, target), { ok: true, timedOut: false });
  assert.equal(room.gameState, 'playing');
  assert.equal(room.privateGameState.history[0].effects.filter((effect) => effect.type === 'lock-card').length, 1);
  assert.equal(room.privateGameState.p2.hand.find((card) => card.instanceId === target).state.locks.length, 1);
  assert.deepEqual(completePrivatePendingAction(room, target), { ok: false, code: 'missing' });
});

test('The Starは勝敗にかかわらず相手へ候補を提示し、選ばれた札をノイズとして一度だけ追加する', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('advanced-star-action', [
    'the-star', 'ace', 'king', 'queen', 'jack'
  ], { roundLimit: 5 });
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  room.selections = {
    p1: handInstanceId(room, 'p1', 'the-star'),
    p2: handInstanceId(room, 'p2', 'ace')
  };
  processTurn(room);

  const pending = room.privatePendingAction;
  assert.equal(pending?.phase, 'post-result');
  assert.equal(pending?.action.type, 'opponent-choose-noise');
  assert.equal(pending?.action.actorSeat, 'p2');
  assert.equal(pending?.action.targetSeat, 'p2');
  assert.ok(pending?.action.candidates.includes('king'));

  const actorView = createRoomView(room, 'p2');
  const otherView = createRoomView(room, 'p1');
  assert.equal(actorView.viewer.pendingAction.target.surface, 'addition');
  assert.match(actorView.viewer.pendingAction.instruction, /The Starの効果/);
  assert.ok(actorView.viewer.pendingAction.target.cards.some((card) => card.definitionId === 'king'));
  assert.equal(otherView.viewer.pendingAction.target, undefined);

  assert.deepEqual(completePrivatePendingAction(room, 'king'), { ok: true, timedOut: false });
  const noise = room.privateGameState.p2.hand.find((card) => (
    card.definitionId === 'king' && card.state.generated === true && card.state.visibility === 'noise-owner-only'
  ));
  assert.ok(noise);
  const concealed = createRoomView(room, 'p1').players.find((player) => player.id === 'p2').hand
    .find((card) => card.category === 'noise');
  assert.ok(concealed);
  assert.equal(concealed.definitionId, undefined);
  assert.equal(concealed.desc, '正体は、この札が出されたときに公開されます。');
  assert.doesNotMatch(JSON.stringify(concealed), /king|King/);
});

test('The High Priestessの相手手札候補は行為者の盤面と同じ物理札IDで選べる', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('priestess-action', [
    'the-high-priestess', 'ace', 'king', 'queen', 'jack'
  ], { roundLimit: 5 });
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  room.selections = {
    p1: handInstanceId(room, 'p1', 'the-high-priestess'),
    p2: handInstanceId(room, 'p2', 'ace')
  };
  processTurn(room);

  const pending = room.privatePendingAction;
  assert.equal(pending?.action.type, 'copy-opponent-hand');
  assert.equal(pending?.action.actorSeat, 'p1');
  assert.equal(pending?.action.targetSeat, 'p2');
  const actorView = createRoomView(room, 'p1');
  const otherView = createRoomView(room, 'p2');
  const target = actorView.viewer.pendingAction.target;
  assert.equal(target.surface, 'hand');
  assert.equal(target.seat, 'p2');
  assert.ok(target.cards.length > 0);
  assert.deepEqual(target.cards.map((card) => card.id), target.candidateIds);
  assert.deepEqual(
    actorView.players.find((player) => player.id === 'p2').hand.map((card) => card.id),
    target.candidateIds
  );
  assert.equal(otherView.viewer.pendingAction.target, undefined);

  assert.deepEqual(completePrivatePendingAction(room, target.candidateIds[0]), { ok: true, timedOut: false });
  assert.equal(room.privateGameState.p1.hand.length, 5);
  assert.equal(room.privateGameState.p1.hand.filter((card) => card.state.generated === true).length, 1);
});

test('The Sunの破棄対象は確定前には状態を変えず、選択後だけ同時ラウンドへ反映する', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('advanced-sun-action', [
    'the-sun', 'ace', 'king', 'queen', 'jack'
  ]);
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  const sunId = handInstanceId(room, 'p1', 'the-sun');
  const aceId = handInstanceId(room, 'p1', 'ace');
  room.selections = { p2: handInstanceId(room, 'p2', 'king') };
  assert.equal(beginSunPreCommitAction(room, room.players[0], 'p1', sunId), true);
  assert.equal(room.privateGameState.p1.hand.some((card) => card.instanceId === aceId), true);
  const pending = room.privatePendingAction;
  assert.equal(pending?.phase, 'pre-commit');
  const actorView = createRoomView(room, 'p1');
  const otherView = createRoomView(room, 'p2');
  assert.ok(actorView.viewer.pendingAction.target.candidateIds.includes(aceId));
  assert.equal(otherView.viewer.pendingAction, null);
  assert.equal(otherView.deadline, room.privatePreCommitTurnDeadline);

  assert.deepEqual(completePrivatePendingAction(room, aceId), { ok: true, timedOut: false });
  assert.equal(room.gameState, 'playing');
  assert.equal(room.privateGameState.p1.hand.some((card) => card.instanceId === aceId), false);
  assert.equal(room.privateGameState.discardPile.some((entry) => entry.card.instanceId === aceId && entry.reason === 'sun'), true);
  assert.equal(room.privateGameState.history[0].p1Card.definitionId, 'the-sun');
});

test('両者が同じラウンドでThe Sunを選んでも、対象選択を上書きせず順に解決する', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('advanced-double-sun', [
    'the-sun', 'ace', 'king', 'queen', 'jack'
  ], { roundLimit: 5 });
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  const p1Sun = handInstanceId(room, 'p1', 'the-sun');
  const p2Sun = handInstanceId(room, 'p2', 'the-sun');
  const p1Target = handInstanceId(room, 'p1', 'ace');
  const p2Target = handInstanceId(room, 'p2', 'king');

  assert.equal(beginSunPreCommitAction(room, room.players[0], 'p1', p1Sun), true);
  const firstPending = room.privatePendingAction;
  assert.equal(firstPending?.action.actorSeat, 'p1');
  assert.equal(firstPending?.expiresAt - firstPending?.createdAt, PRIVATE_ACTION_TIMEOUT_MS);

  assert.equal(beginSunPreCommitAction(room, room.players[1], 'p2', p2Sun), true);
  assert.equal(room.privatePendingAction?.id, firstPending.id);
  assert.deepEqual(room.privatePreCommitQueue, [{ seat: 'p2', sunInstanceId: p2Sun }]);
  const p1ViewBefore = createRoomView(room, 'p1');
  const p2ViewBefore = createRoomView(room, 'p2');
  assert.equal(p1ViewBefore.viewer.hasQueuedPreCommitAction, false);
  assert.equal(p2ViewBefore.viewer.hasQueuedPreCommitAction, true);
  assert.equal(p2ViewBefore.viewer.pendingAction, null);

  assert.deepEqual(completePrivatePendingAction(room, p1Target), { ok: true, timedOut: false });
  assert.equal(room.privatePendingAction?.phase, 'pre-commit');
  assert.equal(room.privatePendingAction?.action.actorSeat, 'p2');
  assert.equal(room.privatePreCommitQueue.length, 0);
  assert.equal(createRoomView(room, 'p1').viewer.pendingAction, null);
  assert.equal(createRoomView(room, 'p2').viewer.hasQueuedPreCommitAction, false);

  assert.deepEqual(completePrivatePendingAction(room, p2Target), { ok: true, timedOut: false });
  assert.equal(room.privatePendingAction, null);
  assert.equal(room.privateGameState.history.length, 1);
  assert.equal(room.privateGameState.history[0].p1Card.definitionId, 'the-sun');
  assert.equal(room.privateGameState.history[0].p2Card.definitionId, 'the-sun');
  assert.equal(room.privateGameState.history[0].effects.filter((effect) => effect.type === 'destroy-card').length, 2);
  assert.equal(room.privateGameState.p1.hand.some((card) => card.instanceId === p1Target), false);
  assert.equal(room.privateGameState.p2.hand.some((card) => card.instanceId === p2Target), false);
});

test('同一ラウンドで複数のTarot対象操作が出ても、行為者別に一件ずつ処理される', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('advanced-double-target', [
    'the-hanged-man', 'the-star', 'ace', 'king', 'queen', 'jack'
  ], { roundLimit: 6 });
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  room.selections = {
    p1: handInstanceId(room, 'p1', 'the-hanged-man'),
    p2: handInstanceId(room, 'p2', 'the-star')
  };
  processTurn(room);

  assert.equal(room.privatePendingAction?.action.type, 'opponent-choose-copy');
  assert.equal(room.privatePendingAction?.action.actorSeat, 'p2');
  assert.equal(createRoomView(room, 'p1').viewer.pendingAction.target, undefined);
  assert.equal(createRoomView(room, 'p2').viewer.pendingAction.target.surface, 'addition');

  assert.deepEqual(completePrivatePendingAction(room, 'king'), { ok: true, timedOut: false });
  assert.equal(room.privatePendingAction?.action.type, 'opponent-choose-noise');
  assert.equal(room.privatePendingAction?.action.actorSeat, 'p1');
  assert.equal(createRoomView(room, 'p2').viewer.pendingAction.target, undefined);
  assert.equal(createRoomView(room, 'p1').viewer.pendingAction.target.surface, 'addition');

  assert.deepEqual(completePrivatePendingAction(room, 'queen'), { ok: true, timedOut: false });
  assert.equal(room.privatePendingAction, null);
  assert.equal(room.privateGameState.p2.hand.some((card) => (
    card.definitionId === 'king' && card.state.generated === true
  )), true);
  assert.equal(room.privateGameState.p1.hand.some((card) => (
    card.definitionId === 'queen' && card.state.visibility === 'noise-owner-only'
  )), true);
});

test('対象選択中に切断しても、再接続後は同じ一回限りの操作だけを復帰する', (t) => {
  const room = createAdvancedPrivateRoomForActionTest('advanced-reconnect', [
    'justice', 'ace', 'king', 'queen', 'jack'
  ]);
  t.after(() => {
    if (room.gameState !== 'finished') finishGameByForfeit(room, room.players[0]);
  });
  room.selections = {
    p1: handInstanceId(room, 'p1', 'justice'),
    p2: 'virtual-blank'
  };
  processTurn(room);
  const actionId = room.privatePendingAction.id;
  const nonce = room.privatePendingAction.nonce;
  const now = Date.now();
  room.players[1].connected = false;
  assert.equal(pauseForReconnect(room, now), true);
  assert.equal(room.gameState, 'reconnecting');
  assert.equal(room.deadline, 0);
  assert.equal(room.privatePendingAction.id, actionId);
  room.players[1].connected = true;
  assert.equal(resumeAfterReconnect(room), true);
  assert.equal(room.gameState, 'playing');
  assert.equal(room.privatePendingAction.id, actionId);
  assert.equal(room.privatePendingAction.nonce, nonce);
  assert.ok(createRoomView(room, 'p1').viewer.pendingAction.target.candidateIds.length > 0);
  assert.equal(createRoomView(room, 'p2').viewer.pendingAction.target, undefined);
});

test('The Starの秘匿札と公開履歴はrecipientごとに投影され、内部対象IDを漏らさない', () => {
  const config = createExpandedPrivateRoomConfig({
    roundLimit: 5,
    scoreTarget: null,
    blankEnabled: false,
    deck: ['the-star', 'ace', 'king', 'queen', 'jack'].map((definitionId) => ({ definitionId, copies: 1 }))
  });
  const state = createExpandedPrivateGameState({
    instanceNamespace: 'server-view-noise',
    rules: config,
    deck: config.deck
  });
  const noise = state.p2.hand.find((card) => card.definitionId === 'king');
  noise.state.visibility = 'noise-owner-only';
  noise.state.revealOn = 'play';
  const room = createRoom('advanced-noise-room');
  room.players = [
    { id: 'p1', clientId: 'p1-client', name: '先手', suit: '♠', hand: [], score: 0, connected: true },
    { id: 'p2', clientId: 'p2-client', name: '後手', suit: '♥', hand: [], score: 0, connected: true }
  ];
  room.spectators = [{ id: 'viewer', clientId: 'viewer-client', name: '観戦者', autoJoinWhenSeatAvailable: false }];
  room.activePrivateConfig = config;
  room.privateGameState = state;
  room.gameState = 'playing';
  room.privatePendingAction = createPrivatePendingAction({
    roomId: room.id,
    gameRevision: 1,
    now: Date.now(),
    randomBytes: () => Buffer.from('1234567890123456'),
    action: {
      type: 'lock-one', round: 1, sourceSeat: 'p1', sourceDefinitionId: 'justice',
      actorSeat: 'p1', targetSeat: 'p2', actionKey: '1:p1:justice:lock-one:0', candidates: [noise.instanceId]
    }
  });
  const actorView = createRoomView(room, 'p1');
  const ownerView = createRoomView(room, 'p2');
  const spectatorView = createRoomView(room, 'viewer');
  const actorOpponentHand = actorView.players.find((player) => player.id === 'p2').hand;
  const spectatorOpponentHand = spectatorView.players.find((player) => player.id === 'p2').hand;
  const ownerHand = ownerView.players.find((player) => player.id === 'p2').hand;
  assert.equal(JSON.stringify(actorOpponentHand).includes('king'), false);
  assert.equal(JSON.stringify(spectatorOpponentHand).includes('king'), false);
  assert.equal(JSON.stringify(ownerHand).includes('king'), true);
  assert.equal(actorView.viewer.pendingAction.target.cards[0].definitionId, undefined);
  assert.equal(spectatorView.viewer.pendingAction.target, undefined);

  const publicEffect = publicExpandedRoundEffect({
    type: 'destroy-card', sourceSeat: 'p1', sourceDefinitionId: 'the-sun', targetSeat: 'p1',
    targetInstanceId: noise.instanceId, destroyedCount: 1
  });
  assert.deepEqual(publicEffect, {
    type: 'destroy-card', sourceSeat: 'p1', sourceDefinitionId: 'the-sun', targetSeat: 'p1', destroyedCount: 1
  });
  assert.equal(JSON.stringify(publicEffect).includes(noise.instanceId), false);
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
