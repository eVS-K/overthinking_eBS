'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExpandedPrivateRuleset } = require('./private-ruleset');
const { createExpandedPrivateGameState } = require('./private-game-engine');
const { createPrivatePendingAction } = require('./private-action-queue');
const {
  publicExpandedCardForViewer,
  publicPrivatePendingActionForViewer
} = require('./private-room-view');

function createState() {
  const state = createExpandedPrivateGameState({
    instanceNamespace: 'room-view',
    rules: createExpandedPrivateRuleset({ roundLimit: 5, scoreTarget: null }),
    deck: ['the-star', 'ace', 'king', 'queen', 'jack'].map((definitionId) => ({ definitionId, copies: 1 }))
  });
  const noise = state.p2.hand.find((card) => card.definitionId === 'king');
  noise.state.visibility = 'noise-owner-only';
  noise.state.revealOn = 'play';
  return { state, noise };
}

test('The Starのノイズ札は所有者以外のpayloadへ定義・能力・内部状態を送らない', () => {
  const { state, noise } = createState();
  const owner = publicExpandedCardForViewer(noise, { state, ownerSeat: 'p2', viewerSeat: 'p2' });
  const opponent = publicExpandedCardForViewer(noise, { state, ownerSeat: 'p2', viewerSeat: 'p1' });
  const spectator = publicExpandedCardForViewer(noise, { state, ownerSeat: 'p2', viewerSeat: null });
  assert.equal(owner.definitionId, 'king');
  for (const view of [opponent, spectator]) {
    assert.deepEqual(view, {
      id: noise.instanceId,
      name: 'Noise',
      desc: '正体は、この札が出されたときに公開されます。',
      category: 'noise',
      displayMark: '?',
      state: { locked: false }
    });
    assert.doesNotMatch(JSON.stringify(view), /king|能力|revealOn|visibility|locks/);
  }
});

test('対象操作は行為者にだけ候補を見せ、ノイズ対象でも正体を漏らさない', () => {
  const { state, noise } = createState();
  const pending = createPrivatePendingAction({
    roomId: 'view-room', gameRevision: 1, now: 100,
    randomBytes: () => Buffer.from('1234567890123456'),
    action: {
      type: 'lock-one', round: 1, sourceSeat: 'p1', sourceDefinitionId: 'justice',
      actorSeat: 'p1', targetSeat: 'p2', actionKey: '1:p1:justice:lock-one:0', candidates: [noise.instanceId]
    }
  });
  const actor = publicPrivatePendingActionForViewer(pending, state, 'p1');
  const outsider = publicPrivatePendingActionForViewer(pending, state, 'p2');
  assert.equal(actor.candidates[0].label, '? Noise');
  assert.equal(actor.candidates[0].definitionId, undefined);
  assert.doesNotMatch(JSON.stringify(actor), /king/);
  assert.equal(outsider.candidates, undefined);
  assert.equal(outsider.nonce, undefined);
});

test('太陽の確定前対象操作は、行為者以外へ操作中であること自体を公開しない', () => {
  const { state } = createState();
  const target = state.p1.hand[1];
  const pending = createPrivatePendingAction({
    roomId: 'sun-view', gameRevision: 1, phase: 'pre-commit', now: 100,
    randomBytes: () => Buffer.from('1234567890123456'),
    action: {
      type: 'sun-destroy', round: 1, sourceSeat: 'p1', sourceDefinitionId: 'the-sun',
      actorSeat: 'p1', targetSeat: 'p1', actionKey: '1:p1:the-sun:sun-destroy:0', candidates: [target.instanceId]
    }
  });
  assert.equal(publicPrivatePendingActionForViewer(pending, state, 'p2'), null);
  assert.equal(publicPrivatePendingActionForViewer(pending, state, null), null);
  assert.equal(publicPrivatePendingActionForViewer(pending, state, 'p1').type, 'sun-destroy');
});
