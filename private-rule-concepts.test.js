'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPANDED_PRIVATE_RULESET_ID, CLASSIC_PRIVATE_RULESET_ID } = require('./private-ruleset');
const {
  PRIVATE_RULE_CONCEPTS,
  getPrivateRuleConceptsForDeck
} = require('./private-rule-concepts');

function conceptIds(settings) {
  return getPrivateRuleConceptsForDeck(settings).map((concept) => concept.id);
}

test('拡張デッキのルール説明は実際に入っているカードの概念だけを順序付きで返す', () => {
  const concepts = getPrivateRuleConceptsForDeck({
    ruleset: EXPANDED_PRIVATE_RULESET_ID,
    deck: [
      { definitionId: 'the-star', copies: 1 },
      { definitionId: 'the-emperor', copies: 1 },
      { definitionId: 'ace', copies: 3 },
      { definitionId: 'the-high-priestess', copies: 0 }
    ]
  });
  assert.deepEqual(concepts.map((concept) => concept.id), [
    'card-addition', 'noise', 'tarot-negation', 'target-selection'
  ]);
  assert.equal(Object.isFrozen(concepts), true);
  for (const concept of concepts) {
    assert.equal(concept, PRIVATE_RULE_CONCEPTS[concept.id]);
    assert.equal(Object.isFrozen(concept), true);
    assert.match(concept.title, /\S/);
    assert.match(concept.description, /\S/);
  }
});

test('Blankは有効化された部屋だけに説明し、クラシック・不正なデッキは概念を出さない', () => {
  const deck = [{ definitionId: 'the-empress', copies: 1 }];
  assert.deepEqual(conceptIds({ ruleset: EXPANDED_PRIVATE_RULESET_ID, deck, blankEnabled: false }), ['lock']);
  assert.deepEqual(conceptIds({ ruleset: EXPANDED_PRIVATE_RULESET_ID, deck, blankEnabled: true }), ['lock', 'blank']);
  assert.deepEqual(conceptIds({ ruleset: CLASSIC_PRIVATE_RULESET_ID, deck, blankEnabled: true }), []);
  assert.deepEqual(conceptIds({
    ruleset: EXPANDED_PRIVATE_RULESET_ID,
    deck: [{ definitionId: 'not-a-card', copies: 99 }, { definitionId: 'the-star', copies: 0 }]
  }), []);
});
