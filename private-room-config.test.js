'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPrivateRoomConfig,
  deckRequiresBlankFallback
} = require('./private-room-config');
const { getPrivateCardDefinition } = require('./private-card-definitions');

const NORMAL_EXPANDED_DECK = [
  { definitionId: 'ace', copies: 1 },
  { definitionId: 'king', copies: 1 },
  { definitionId: 'queen', copies: 1 },
  { definitionId: 'jack', copies: 1 },
  { definitionId: 'ten', copies: 1 }
];

test('選択不能化するカードがない拡張デッキでは、Blankなしで開始する設定を選べる', () => {
  const config = createPrivateRoomConfig({
    ruleset: 'private-expanded-v1',
    roundLimit: 5,
    scoreTarget: null,
    blankEnabled: false,
    deck: NORMAL_EXPANDED_DECK
  });
  assert.equal(config.blankRequired, false);
  assert.equal(config.blankEnabled, false);
  assert.equal(config.timeoutPolicy, 'random-legal');
  assert.equal(config.deck.length, 5);
});

test('Blankを有効にした拡張デッキでは、タイムアウト方針もBlankを含む抽選へ固定される', () => {
  const config = createPrivateRoomConfig({
    ruleset: 'private-expanded-v1',
    roundLimit: 5,
    scoreTarget: null,
    blankEnabled: true,
    deck: NORMAL_EXPANDED_DECK
  });
  assert.equal(config.blankRequired, false);
  assert.equal(config.blankEnabled, true);
  assert.equal(config.timeoutPolicy, 'random-legal-with-blank');
});

test('将来のロック系カードはBlank fallbackを必須にできるメタデータを持つ', () => {
  const justice = getPrivateCardDefinition('justice');
  assert.equal(justice.mayPreventAllLegalPlays, true);
  assert.equal(deckRequiresBlankFallback([{ definitionId: 'justice', copies: 1 }]), true);
  assert.equal(deckRequiresBlankFallback(NORMAL_EXPANDED_DECK), false);
});
