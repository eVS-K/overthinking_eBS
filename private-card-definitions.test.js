'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AVAILABLE_TAROT_DISPLAY_ORDER,
  AVAILABLE_TAROT_IDS,
  PRIVATE_CARD_CATALOG,
  TAROT_GREEK_MARKS_BY_ID,
  getClassicPrivateCardDefinition,
  getPrivateCardDefinition
} = require('./private-card-definitions');

const EXPECTED_TAROT_ORDER = Object.freeze([
  'death', 'temperance', 'the-devil', 'the-tower', 'the-chariot', 'strength',
  'the-magician', 'the-lovers', 'wheel-of-fortune', 'the-fool', 'the-high-priestess',
  'the-empress', 'the-emperor', 'the-hierophant', 'the-hermit', 'justice',
  'the-hanged-man', 'the-star', 'the-moon', 'the-sun', 'judgement', 'the-world'
]);

test('追加通常札はPrivate拡張の公開済みカードとして定義され、クラシック定義には混ざらない', () => {
  const ten = getPrivateCardDefinition('ten');
  assert.equal(ten.name, 'Ten');
  assert.equal(ten.strength, 10);
  assert.equal(ten.status, 'available');
  assert.equal(ten.category, 'normal-extra');
  assert.throws(() => getClassicPrivateCardDefinition('ten'), /unknown/);
});

test('Blankは仮想札としてengine-readyであり、実装済みのThe Worldは拡張デッキへ入れられる', () => {
  const blank = getPrivateCardDefinition('blank');
  const world = getPrivateCardDefinition('the-world');
  assert.equal(blank.status, 'engine-ready');
  assert.equal(blank.requiresFeatures.includes('blank-semantics-v1'), true);
  assert.equal(world.status, 'available');
  assert.equal(world.desc, '相手の獲得札を奪い、そのコピーを手札へ加える');
  assert.equal(world.effectProfileId, 'transfer-won-card-v1');
});

test('全22枚のTarotはPrivate拡張デッキへ一枚ずつ入れられる状態である', () => {
  assert.deepEqual([...AVAILABLE_TAROT_IDS], EXPECTED_TAROT_ORDER);
  for (const definitionId of AVAILABLE_TAROT_IDS) {
    const card = getPrivateCardDefinition(definitionId);
    assert.equal(card.status, 'available');
    assert.equal(card.category, 'tarot');
    assert.equal(card.maxCopiesPerDeck, 1);
    assert.equal(card.requiresFeatures.length > 0, true);
  }
  assert.equal(getPrivateCardDefinition('the-chariot').requiresFeatures.includes('compare-override-v1'), true);
  assert.equal(getPrivateCardDefinition('strength').requiresFeatures.includes('scaled-strength-v1'), true);
  assert.equal(getPrivateCardDefinition('the-magician').requiresFeatures.includes('card-generation-v1'), true);
  assert.equal(getPrivateCardDefinition('the-lovers').requiresFeatures.includes('card-generation-v1'), true);
  assert.equal(getPrivateCardDefinition('wheel-of-fortune').requiresFeatures.includes('round-extension-v1'), true);
  assert.equal(getPrivateCardDefinition('the-fool').effectProfileId, 'echo-own-v1');
  assert.equal(getPrivateCardDefinition('the-high-priestess').effectProfileId, 'copy-opponent-hand-v1');
  assert.equal(getPrivateCardDefinition('the-empress').playabilityRisk, 'temporary-all-hand-lock');
  assert.equal(getPrivateCardDefinition('the-emperor').effectProfileId, 'emperor-override-v1');
  assert.equal(getPrivateCardDefinition('the-hierophant').effectProfileId, 'copy-own-hand-v1');
  assert.equal(getPrivateCardDefinition('the-hermit').effectProfileId, 'echo-opponent-v1');
  assert.equal(getPrivateCardDefinition('justice').effectProfileId, 'lock-one-v1');
  assert.equal(getPrivateCardDefinition('the-hanged-man').effectProfileId, 'opponent-choose-copy-v1');
  assert.equal(getPrivateCardDefinition('the-star').visibilityModel, 'recipient-specific');
  assert.equal(getPrivateCardDefinition('the-moon').effectProfileId, 'discard-own-won-pile-v1');
  assert.equal(getPrivateCardDefinition('the-sun').effectProfileId, 'destroy-own-hand-v1');
  assert.equal(getPrivateCardDefinition('judgement').effectProfileId, 'copy-played-history-v1');
});

test('デッキ編集の表示順は基本札、αからχの使用可能Tarot、追加通常札である', () => {
  assert.deepEqual(AVAILABLE_TAROT_DISPLAY_ORDER, EXPECTED_TAROT_ORDER);
  assert.deepEqual(
    PRIVATE_CARD_CATALOG
      .filter((definition) => definition.status === 'available')
      .map((definition) => definition.id),
    [
      'ace', 'king', 'queen', 'jack', 'joker', 'three', 'two',
      'death', 'temperance', 'the-devil', 'the-tower', 'the-chariot', 'strength',
      'the-magician', 'the-lovers', 'wheel-of-fortune', 'the-fool', 'the-high-priestess',
      'the-empress', 'the-emperor', 'the-hierophant', 'the-hermit', 'justice',
      'the-hanged-man', 'the-star', 'the-moon', 'the-sun', 'judgement', 'the-world',
      'ten', 'nine', 'eight', 'seven', 'six', 'five', 'four'
    ]
  );
});

test('Tarotの表示記号は実装順にαからχまで連続したギリシャ文字である', () => {
  assert.deepEqual(
    EXPECTED_TAROT_ORDER.map((id) => TAROT_GREEK_MARKS_BY_ID[id]),
    ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ']
  );
  assert.equal(getPrivateCardDefinition('death').displayMark, 'α');
  assert.equal(getPrivateCardDefinition('the-world').displayMark, 'χ');
});
