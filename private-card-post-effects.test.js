'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPrivatePostRoundEffectRequests,
  materializePrivatePostRoundEffects
} = require('./private-card-post-effects');

function runtime(overrides = {}) {
  return {
    instanceNamespace: 'post-effect',
    round: 3,
    effectiveRoundLimit: 7,
    handCounts: { p1: 5, p2: 5 },
    totalCardInstances: 14,
    nextInstanceOrdinalBySeat: { p1: 8, p2: 8 },
    ...overrides
  };
}

test('The MagicianとThe Loversは対象選択なしで、勝敗後の生成先を決める', () => {
  const magician = getPrivatePostRoundEffectRequests({
    p1Card: { definitionId: 'the-magician' },
    p2Card: { definitionId: 'ten' },
    winnerSeat: 'p2'
  });
  assert.deepEqual(magician, [{
    type: 'add-cards', sourceSeat: 'p1', sourceDefinitionId: 'the-magician',
    recipientSeat: 'p1', definitionId: 'ten', requestedCopies: 2
  }]);

  const lovers = getPrivatePostRoundEffectRequests({
    p1Card: { definitionId: 'the-lovers' },
    p2Card: { definitionId: 'ace' },
    winnerSeat: 'p2'
  });
  assert.deepEqual(lovers, [{
    type: 'add-cards', sourceSeat: 'p1', sourceDefinitionId: 'the-lovers',
    recipientSeat: 'p2', definitionId: 'queen', requestedCopies: 1
  }]);
});

test('生成効果は手札・全カード上限へ収め、連番のserver-side instanceIdを記録する', () => {
  const result = materializePrivatePostRoundEffects({
    ...runtime(),
    p1Card: { definitionId: 'the-magician' },
    p2Card: { definitionId: 'joker' },
    winnerSeat: 'p1'
  });
  assert.deepEqual(result.additions, [
    { recipientSeat: 'p1', definitionId: 'joker', instanceId: 'post-effect:p1:8' },
    { recipientSeat: 'p1', definitionId: 'joker', instanceId: 'post-effect:p1:9' }
  ]);
  assert.equal(result.effects[0].cardInstanceIds.length, 2);
  assert.equal(result.handCounts.p1, 7);
  assert.equal(result.totalCardInstances, 16);

  const capped = materializePrivatePostRoundEffects({
    ...runtime({ handCounts: { p1: 24, p2: 5 }, totalCardInstances: 64 }),
    p1Card: { definitionId: 'the-magician' },
    p2Card: { definitionId: 'ace' },
    winnerSeat: 'p1'
  });
  assert.deepEqual(capped.additions, []);
  assert.deepEqual(capped.effects[0].cardInstanceIds, []);
});

test('Wheel of Fortuneは勝敗後にだけ総ラウンドを動かし、完了済みラウンドより縮めない', () => {
  const win = materializePrivatePostRoundEffects({
    ...runtime(),
    p1Card: { definitionId: 'wheel-of-fortune' },
    p2Card: { definitionId: 'ace' },
    winnerSeat: 'p1'
  });
  assert.equal(win.effectiveRoundLimit, 8);
  assert.deepEqual(win.effects[0], {
    type: 'round-limit-adjustment', sourceSeat: 'p1', sourceDefinitionId: 'wheel-of-fortune',
    requestedDelta: 1, previousRoundLimit: 7, nextRoundLimit: 8, appliedDelta: 1
  });

  const loss = materializePrivatePostRoundEffects({
    ...runtime({ round: 3, effectiveRoundLimit: 3 }),
    p1Card: { definitionId: 'wheel-of-fortune' },
    p2Card: { definitionId: 'ace' },
    winnerSeat: 'p2'
  });
  assert.equal(loss.effectiveRoundLimit, 3);
  assert.equal(loss.effects[0].appliedDelta, 0);
});
