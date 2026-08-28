'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AVAILABLE_CONDITIONAL_TAROT_IDS,
  getClassicPrivateCardDefinition,
  getPrivateCardDefinition
} = require('./private-card-definitions');

test('追加通常札はPrivate拡張の公開済みカードとして定義され、クラシック定義には混ざらない', () => {
  const ten = getPrivateCardDefinition('ten');
  assert.equal(ten.name, 'Ten');
  assert.equal(ten.strength, 10);
  assert.equal(ten.status, 'available');
  assert.equal(ten.category, 'normal-extra');
  assert.throws(() => getClassicPrivateCardDefinition('ten'), /unknown/);
});

test('Blankは仮想札としてengine-ready、Tarotは仕様済みでもデッキへ入れられない状態を保つ', () => {
  const blank = getPrivateCardDefinition('blank');
  const world = getPrivateCardDefinition('the-world');
  assert.equal(blank.status, 'engine-ready');
  assert.equal(blank.requiresFeatures.includes('blank-semantics-v1'), true);
  assert.equal(world.status, 'specified');
  assert.equal(world.desc, '相手の獲得札を奪い、そのコピーを手札へ加える');
});

test('初期導入の4枚の条件型TarotだけはPrivate拡張デッキへ入れられる状態である', () => {
  assert.deepEqual([...AVAILABLE_CONDITIONAL_TAROT_IDS], ['death', 'temperance', 'the-devil', 'the-tower']);
  for (const definitionId of AVAILABLE_CONDITIONAL_TAROT_IDS) {
    const card = getPrivateCardDefinition(definitionId);
    assert.equal(card.status, 'available');
    assert.equal(card.category, 'tarot');
    assert.equal(card.maxCopiesPerDeck, 1);
    assert.equal(card.requiresFeatures.includes('conditional-strength-v1'), true);
  }
});
