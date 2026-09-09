const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialHand, resolveRound, resolveRoundDetails } = require('./game-rules');

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

test('公開用の比較理由は勝敗正本と同じ規則から作られる', () => {
  assert.deepEqual(resolveRoundDetails(card('two'), card('ace')), {
    winner: 'p1', p1Strength: 2, p2Strength: 14, comparison: 'two-beats-ace'
  });
  assert.deepEqual(resolveRoundDetails(card('three'), card('joker')), {
    winner: 'p1', p1Strength: 3, p2Strength: 0, comparison: 'three-beats-joker'
  });
  assert.deepEqual(resolveRoundDetails(card('joker'), card('king')), {
    winner: 'draw', p1Strength: 13, p2Strength: 13, comparison: 'joker-copies'
  });
  assert.deepEqual(resolveRoundDetails(card('king'), card('queen')), {
    winner: 'p1', p1Strength: 13, p2Strength: 12, comparison: 'strength-compare'
  });
});

test('各プレイヤーには独立した7枚の手札が配られる', () => {
  const firstHand = createInitialHand();
  const secondHand = createInitialHand();

  assert.equal(firstHand.length, 7);
  assert.notEqual(firstHand[0], secondHand[0]);
  firstHand.pop();
  assert.equal(secondHand.length, 7);
});
