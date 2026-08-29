'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AVAILABLE_TAROT_IDS,
  TAROT_GREEK_MARKS_BY_ID,
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

test('安全に解決できる6枚のTarotだけはPrivate拡張デッキへ入れられる状態である', () => {
  assert.deepEqual([...AVAILABLE_TAROT_IDS], [
    'death', 'temperance', 'the-devil', 'the-tower', 'the-chariot', 'strength'
  ]);
  for (const definitionId of AVAILABLE_TAROT_IDS) {
    const card = getPrivateCardDefinition(definitionId);
    assert.equal(card.status, 'available');
    assert.equal(card.category, 'tarot');
    assert.equal(card.maxCopiesPerDeck, 1);
    assert.equal(card.requiresFeatures.length > 0, true);
  }
  assert.equal(getPrivateCardDefinition('the-chariot').requiresFeatures.includes('compare-override-v1'), true);
  assert.equal(getPrivateCardDefinition('strength').requiresFeatures.includes('scaled-strength-v1'), true);
});

test('Tarotの表示記号は実装順にαから始まるギリシャ文字である', () => {
  assert.equal(TAROT_GREEK_MARKS_BY_ID.death, 'α');
  assert.equal(TAROT_GREEK_MARKS_BY_ID.temperance, 'β');
  assert.equal(TAROT_GREEK_MARKS_BY_ID['the-devil'], 'γ');
  assert.equal(TAROT_GREEK_MARKS_BY_ID['the-tower'], 'δ');
  assert.equal(TAROT_GREEK_MARKS_BY_ID['the-chariot'], 'ε');
  assert.equal(TAROT_GREEK_MARKS_BY_ID.strength, 'ζ');
  assert.equal(getPrivateCardDefinition('death').displayMark, 'α');
});
