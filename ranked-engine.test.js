'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const {
  applyRound,
  createInitialRankedState,
  getCurrentRound,
  isTerminalState,
  popcount,
  terminalMatchScore
} = require('./ranked-engine');

test('Ranked applyRound は canonical resolveRound と一致し、双方から一枚ずつ除く', () => {
  for (const playerCard of CARD_DEFINITIONS) {
    for (const aiCard of CARD_DEFINITIONS) {
      const result = applyRound(createInitialRankedState(), playerCard.id, aiCard.id);
      assert.equal(result.canonicalResult, resolveRound(playerCard, aiCard));
      assert.equal(popcount(result.state.playerMask), 6);
      assert.equal(popcount(result.state.aiMask), 6);
      assert.equal(result.state.playerScore + result.state.aiScore + result.state.stackCount, 2);
    }
  }
});

test('draw stack は次の勝者へ渡り、得点とstackの不変条件を保つ', () => {
  let state = createInitialRankedState();
  state = applyRound(state, 'joker', 'king').state;
  assert.equal(state.stackCount, 2);
  const result = applyRound(state, 'ace', 'queen');
  assert.equal(result.winner, 'player');
  assert.equal(result.awardedCards, 4);
  assert.equal(result.state.playerScore, 4);
  assert.equal(result.state.stackCount, 0);
});

test('7ラウンド終了またはscore > 8で terminal になる', () => {
  let state = createInitialRankedState();
  const cards = ['ace', 'king', 'queen', 'jack', 'joker', 'three', 'two'];
  for (let round = 1; round <= 7; round += 1) {
    const playerCard = cards[round - 1];
    const aiCard = cards[round - 1];
    const result = applyRound(state, playerCard, aiCard);
    state = result.state;
    if (round < 7 && !isTerminalState(state)) assert.equal(getCurrentRound(state), round + 1);
  }
  assert.equal(isTerminalState(state), true);
  assert.ok([0, 0.5, 1].includes(terminalMatchScore(state)));
});

test('score > 8は残り札があっても直ちにterminalになる', () => {
  const state = {
    playerMask: 0b0000011,
    aiMask: 0b0000011,
    playerScore: 8,
    aiScore: 0,
    stackCount: 2
  };
  const result = applyRound(state, 'ace', 'king');
  assert.equal(result.state.playerScore, 12);
  assert.equal(result.terminal, true);
  assert.equal(result.matchScore, 1);
});
