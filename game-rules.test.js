const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialHand, resolveRound } = require('./game-rules');

const card = (id) => createInitialHand().find((item) => item.id === id);

test('通常は強い数字のカードが勝つ', () => {
  assert.equal(resolveRound(card('ace'), card('king')), 'p1');
  assert.equal(resolveRound(card('jack'), card('queen')), 'p2');
});

test('Two は Ace に、Three は Joker に勝つ', () => {
  assert.equal(resolveRound(card('two'), card('ace')), 'p1');
  assert.equal(resolveRound(card('ace'), card('two')), 'p2');
  assert.equal(resolveRound(card('three'), card('joker')), 'p1');
  assert.equal(resolveRound(card('joker'), card('three')), 'p2');
});

test('Joker は相手の強さをコピーし、Joker 同士は引き分け', () => {
  assert.equal(resolveRound(card('joker'), card('king')), 'draw');
  assert.equal(resolveRound(card('queen'), card('joker')), 'draw');
  assert.equal(resolveRound(card('joker'), card('joker')), 'draw');
});

test('各プレイヤーには独立した7枚の手札が配られる', () => {
  const firstHand = createInitialHand();
  const secondHand = createInitialHand();

  assert.equal(firstHand.length, 7);
  assert.notEqual(firstHand[0], secondHand[0]);
  firstHand.pop();
  assert.equal(secondHand.length, 7);
});
