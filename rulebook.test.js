'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialHand, resolveRound } = require('./game-rules');

const DISPLAY_TO_CARD_ID = {
  A: 'ace',
  K: 'king',
  Q: 'queen',
  J: 'jack',
  Joker: 'joker',
  3: 'three',
  2: 'two'
};

const DISPLAY_ORDER = ['A', 'K', 'Q', 'J', 'Joker', '3', '2'];

test('初見向け勝敗表はcanonical game-rules.jsの全組み合わせと一致する', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const table = html.match(/<table class="matchup-table">([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table, '勝敗表が必要です');
  const cards = Object.fromEntries(createInitialHand().map((card) => [card.id, card]));
  const rows = [...table.matchAll(/<tr><th scope="row">([^<]+)<\/th>([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, DISPLAY_ORDER.length);

  for (const [, ownDisplay, cellsHtml] of rows) {
    assert.ok(DISPLAY_TO_CARD_ID[ownDisplay]);
    const cells = [...cellsHtml.matchAll(/<td class="(outcome-(?:win|loss|draw))">[^<]+<\/td>/g)].map((match) => match[1]);
    assert.equal(cells.length, DISPLAY_ORDER.length, `${ownDisplay}行のセル数`);
    for (const [index, opponentDisplay] of DISPLAY_ORDER.entries()) {
      const result = resolveRound(cards[DISPLAY_TO_CARD_ID[ownDisplay]], cards[DISPLAY_TO_CARD_ID[opponentDisplay]]);
      const expectedClass = result === 'p1' ? 'outcome-win' : result === 'p2' ? 'outcome-loss' : 'outcome-draw';
      assert.equal(cells[index], expectedClass, `${ownDisplay} 対 ${opponentDisplay}`);
    }
  }
});
