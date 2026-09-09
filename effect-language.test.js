'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicEffectPresentation } = require('./effect-language');

test('公開済みの効果種別だけを短い視覚言語へ分類する', () => {
  const presentation = getPublicEffectPresentation([
    { type: 'add-card-copy', definitionId: 'the-magician', privateTargetId: 'do-not-retain' }
  ]);

  assert.equal(presentation.primary.id, 'generate');
  assert.deepEqual(presentation.categories.map((category) => category.id), ['generate']);
  assert.equal(presentation.primary.symbol, '✦');
  assert.equal(presentation.primary.label, '追加・複製');
  assert.equal(Object.hasOwn(presentation.primary, 'definitionId'), false);
});

test('複数の公開効果は優先度順に一度ずつ表示し、主演出は一つに絞る', () => {
  const presentation = getPublicEffectPresentation([
    { type: 'add-card-copy' },
    { type: 'lock-card' },
    { type: 'lock-cards' },
    { type: 'destroy-card' }
  ]);

  assert.equal(presentation.primary.id, 'destroy');
  assert.deepEqual(presentation.categories.map((category) => category.id), ['destroy', 'lock', 'generate']);
});

test('現在サーバーが公開する各効果は、必ず既知の視覚言語へ対応する', () => {
  const cases = [
    ['destroy-card', 'destroy'],
    ['discard-won-cards', 'destroy'],
    ['transfer-won-card', 'destroy'],
    ['lock-card', 'lock'],
    ['lock-cards', 'lock'],
    ['add-noise-card', 'noise'],
    ['add-card-copy', 'generate'],
    ['add-cards', 'generate'],
    ['copy-played-history', 'generate'],
    ['round-limit-adjustment', 'round'],
    ['skipped-target-action', 'skipped']
  ];

  for (const [type, categoryId] of cases) {
    const presentation = getPublicEffectPresentation([{ type }]);
    assert.equal(presentation.primary?.id, categoryId, type);
  }
});

test('未知または非公開の効果は視覚言語にせず、秘密の補助フィールドを参照しない', () => {
  const presentation = getPublicEffectPresentation([
    { type: 'private-unreleased-effect', targetId: 'secret-target', card: { name: 'hidden' } },
    { type: 'add-noise-card', hiddenDefinitionId: 'the-star' }
  ]);

  assert.equal(presentation.primary.id, 'noise');
  assert.deepEqual(presentation.categories.map((category) => category.id), ['noise']);
  assert.equal(getPublicEffectPresentation(null).primary, null);
  assert.deepEqual(getPublicEffectPresentation([]).categories, []);
});
