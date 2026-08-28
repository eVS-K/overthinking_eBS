'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClassicPrivateRuleset, createExpandedPrivateRuleset } = require('./private-ruleset');
const { expandPrivateDeckEntries, normalizePrivateDeckEntries } = require('./private-deck');

function expandedRules(overrides = {}) {
  return createExpandedPrivateRuleset({ roundLimit: 5, scoreTarget: null, ...overrides });
}

test('Private拡張デッキはカード定義IDと枚数だけから正規化し、同名札を安全に集約する', () => {
  const deck = normalizePrivateDeckEntries([
    { definitionId: 'ten', copies: 1 },
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'ten', copies: 1 },
    { definitionId: 'nine', copies: 1 },
    { definitionId: 'eight', copies: 1 },
    { definitionId: 'seven', copies: 1 }
  ], expandedRules());
  assert.deepEqual(deck, [
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'ten', copies: 2 },
    { definitionId: 'nine', copies: 1 },
    { definitionId: 'eight', copies: 1 },
    { definitionId: 'seven', copies: 1 }
  ]);
  assert.deepEqual(expandPrivateDeckEntries(deck), ['ace', 'ten', 'ten', 'nine', 'eight', 'seven']);
});

test('Private拡張デッキは未実装カード、無効な枚数、未到達の終了条件を拒否する', () => {
  assert.throws(() => normalizePrivateDeckEntries([
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'king', copies: 1 },
    { definitionId: 'queen', copies: 1 },
    { definitionId: 'jack', copies: 1 },
    { definitionId: 'blank', copies: 1 }
  ], expandedRules()), /unavailable/);
  assert.throws(() => normalizePrivateDeckEntries([
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'king', copies: 1 },
    { definitionId: 'queen', copies: 1 },
    { definitionId: 'jack', copies: 1 }
  ], expandedRules({ roundLimit: 4 })), /deck size/);
  assert.throws(() => normalizePrivateDeckEntries([
    { definitionId: 'ace', copies: 4 },
    { definitionId: 'king', copies: 1 }
  ], expandedRules()), /copy limit/);
  assert.throws(() => normalizePrivateDeckEntries([
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'king', copies: 1 },
    { definitionId: 'queen', copies: 1 },
    { definitionId: 'jack', copies: 1 },
    { definitionId: 'ten', copies: 1 }
  ], expandedRules({ roundLimit: 6 })), /round limit/);
  assert.throws(() => normalizePrivateDeckEntries([
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'king', copies: 1 },
    { definitionId: 'queen', copies: 1 },
    { definitionId: 'jack', copies: 1 },
    { definitionId: 'ten', copies: 1 }
  ], expandedRules({ scoreTarget: 11 })), /score target/);
  assert.throws(() => normalizePrivateDeckEntries([{ definitionId: 'ace', copies: 5 }], createClassicPrivateRuleset()), /only for the expanded/);
});
