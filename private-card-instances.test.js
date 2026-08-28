'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clonePrivateCardInstance,
  createClassicPrivateCardInstances,
  createPrivateCardInstance,
  getClassicCardDefinition,
  publicClassicCard
} = require('./private-card-instances');

test('同名カードのコピーでも、Privateカード実体は一意なinstanceIdで区別される', () => {
  const hand = createClassicPrivateCardInstances({
    namespace: 'roomSeed',
    seat: 'p1',
    definitionIds: ['ace', 'ace', 'joker']
  });
  assert.deepEqual(hand.map((card) => card.definitionId), ['ace', 'ace', 'joker']);
  assert.equal(new Set(hand.map((card) => card.instanceId)).size, 3);
  assert.deepEqual(hand.map((card) => card.instanceId), ['roomSeed:p1:1', 'roomSeed:p1:2', 'roomSeed:p1:3']);
});

test('Privateカード実体は既知の定義と狭い状態だけを保持し、複製しても独立する', () => {
  const source = createPrivateCardInstance({
    instanceId: 'roomSeed:p2:1',
    definitionId: 'three',
    state: { locked: true, ignored: 'cannot-pass' }
  });
  const clone = clonePrivateCardInstance(source);
  assert.notEqual(clone, source);
  assert.notEqual(clone.state, source.state);
  assert.deepEqual(clone.state, { locked: true, flipped: false });
  const publicCard = publicClassicCard(source);
  assert.equal(publicCard.name, 'Three');
  assert.equal(publicCard.desc, 'Jokerに勝利');
  assert.equal(publicCard.category, 'classic');
  assert.equal(getClassicCardDefinition('three').id, 'three');
  assert.throws(() => createPrivateCardInstance({ instanceId: 'not-an-instance', definitionId: 'ace' }), /instance id/);
  assert.throws(() => createPrivateCardInstance({ instanceId: 'roomSeed:p2:2', definitionId: 'forged' }), /definition/);
});

test('公開用のTarotカードは能力表示に必要な種類とギリシャ記号だけを持つ', () => {
  const tarot = publicClassicCard(createPrivateCardInstance({
    instanceId: 'roomSeed:p2:3',
    definitionId: 'death'
  }));
  assert.equal(tarot.category, 'tarot');
  assert.equal(tarot.displayMark, 'ξ');
  assert.equal(tarot.desc, '獲得札が相手以下なら13、上回ると0');
});
