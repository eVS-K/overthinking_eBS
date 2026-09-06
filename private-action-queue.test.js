'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRIVATE_ACTION_TIMEOUT_MS,
  chooseExpiredPrivateActionTarget,
  createPrivatePendingAction,
  publicPrivatePendingAction,
  resolvePrivatePendingAction
} = require('./private-action-queue');

function action(overrides = {}) {
  return {
    type: 'lock-one',
    round: 2,
    sourceSeat: 'p1',
    sourceDefinitionId: 'justice',
    actorSeat: 'p1',
    targetSeat: 'p2',
    actionKey: '2:p1:justice:lock-one:0',
    candidates: ['room:p2:1', 'room:p2:2'],
    ...overrides
  };
}

test('Private対象操作は一回限りトークン・対象者・revisionを結び付ける', () => {
  let calls = 0;
  const randomBytes = () => Buffer.alloc(16, ++calls);
  const pending = createPrivatePendingAction({
    roomId: 'private-room', gameRevision: 7, action: action(), now: 1_000, randomBytes
  });
  assert.equal(pending.expiresAt, 1_000 + PRIVATE_ACTION_TIMEOUT_MS);
  assert.equal(PRIVATE_ACTION_TIMEOUT_MS, 30_000);
  assert.notEqual(pending.id, pending.nonce);
  assert.deepEqual(resolvePrivatePendingAction(pending, {
    actionId: pending.id, nonce: pending.nonce, target: 'room:p2:2', actorSeat: 'p1', gameRevision: 7, now: 1_001
  }), { ok: true, target: 'room:p2:2' });
  for (const payload of [
    { actionId: pending.id, nonce: pending.nonce, target: 'room:p2:99', actorSeat: 'p1', gameRevision: 7 },
    { actionId: pending.id, nonce: pending.nonce, target: 'room:p2:1', actorSeat: 'p2', gameRevision: 7 },
    { actionId: pending.id, nonce: 'other', target: 'room:p2:1', actorSeat: 'p1', gameRevision: 7 },
    { actionId: pending.id, nonce: pending.nonce, target: 'room:p2:1', actorSeat: 'p1', gameRevision: 8 }
  ]) {
    assert.equal(resolvePrivatePendingAction(pending, { ...payload, now: 1_001 }).ok, false);
  }
  assert.deepEqual(resolvePrivatePendingAction(pending, {
    actionId: pending.id, nonce: pending.nonce, target: 'room:p2:1', actorSeat: 'p1', gameRevision: 7, now: pending.expiresAt
  }), { ok: false, code: 'expired' });
});

test('対象候補とnonceは対象者だけに公開され、期限時の選択は候補内に限る', () => {
  const pending = createPrivatePendingAction({
    roomId: 'private-room', gameRevision: 1, action: action(), now: 1_000,
    randomBytes: () => Buffer.from('1234567890123456')
  });
  const actor = publicPrivatePendingAction(pending, 'p1');
  const outsider = publicPrivatePendingAction(pending, null);
  assert.deepEqual(actor.candidates, ['room:p2:1', 'room:p2:2']);
  assert.equal(typeof actor.nonce, 'string');
  assert.equal(outsider.candidates, undefined);
  assert.equal(outsider.nonce, undefined);
  assert.equal(outsider.sourceDefinitionId, undefined);
  assert.equal(actor.sourceDefinitionId, undefined);
  assert.equal(actor.actionKey, undefined);
  assert.equal(chooseExpiredPrivateActionTarget(pending, () => 1), 'room:p2:2');
  assert.throws(() => chooseExpiredPrivateActionTarget(pending, () => 2), /random selector/);
});

test('Private対象操作は候補の重複・不正なseat・過大な期限を受け付けない', () => {
  assert.throws(() => createPrivatePendingAction({
    roomId: 'room', gameRevision: 1, action: action({ candidates: ['same', 'same'] })
  }), /candidates/);
  assert.throws(() => createPrivatePendingAction({
    roomId: 'room', gameRevision: 1, action: action({ actorSeat: 'spectator' })
  }), /actor seat/);
  assert.throws(() => createPrivatePendingAction({
    roomId: 'room', gameRevision: 1, action: action(), timeoutMs: PRIVATE_ACTION_TIMEOUT_MS + 1
  }), /parameters/);
});
