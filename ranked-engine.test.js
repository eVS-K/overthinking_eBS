'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const {
  applyRound,
  assertRankedState,
  cardBit,
  cardFromIndex,
  cardIdFromIndex,
  cardIndexFromId,
  cloneRankedState,
  createInitialRankedState,
  getCurrentRound,
  getLegalCardIds,
  isTerminalState,
  popcount,
  stateFromKey,
  stateKey,
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

test('Ranked stateの変換と境界検証は不正なmask・key・カードを拒否する', () => {
  const initial = createInitialRankedState();
  const clone = cloneRankedState(initial);
  assert.notEqual(clone, initial);
  assert.deepEqual(clone, initial);
  assert.equal(cardIndexFromId('ace'), 0);
  assert.equal(cardIdFromIndex(0), 'ace');
  assert.equal(cardFromIndex(0).id, 'ace');
  assert.equal(cardBit('ace'), 1);
  assert.deepEqual(getLegalCardIds(initial.playerMask), CARD_DEFINITIONS.map((card) => card.id));
  assert.equal(stateFromKey(stateKey(initial)).playerMask, initial.playerMask);

  assert.throws(() => cardFromIndex(99), RangeError);
  assert.throws(() => cardBit('not-a-card'), RangeError);
  assert.throws(() => stateFromKey('1.2.3'), TypeError);
  assert.throws(() => stateFromKey('1.1.0.0.1'), RangeError);
  assert.throws(() => assertRankedState({ ...initial, playerMask: -1 }), RangeError);
  assert.throws(() => assertRankedState({ ...initial, aiMask: 0 }), RangeError);
  assert.throws(() => assertRankedState({ ...initial, playerMask: initial.playerMask & ~1 }), RangeError);
  assert.throws(() => applyRound(initial, 'not-a-card', 'ace'), RangeError);
  assert.throws(() => applyRound(initial, 'ace', 'not-a-card'), RangeError);
});

test('terminal stateは勝敗を三値で返し、追加roundを拒否する', () => {
  const playerWin = { playerMask: 0, aiMask: 0, playerScore: 10, aiScore: 4, stackCount: 0 };
  const aiWin = { playerMask: 0, aiMask: 0, playerScore: 4, aiScore: 10, stackCount: 0 };
  const draw = { playerMask: 0, aiMask: 0, playerScore: 7, aiScore: 7, stackCount: 0 };
  assert.equal(terminalMatchScore(playerWin), 1);
  assert.equal(terminalMatchScore(aiWin), 0);
  assert.equal(terminalMatchScore(draw), 0.5);
  assert.throws(() => terminalMatchScore(createInitialRankedState()), /not terminal/);
  assert.throws(() => applyRound(draw, 'ace', 'ace'), /terminal/);
});

test('既に使われたカードはどちらの手札からも再提出できない', () => {
  const afterFirstRound = applyRound(createInitialRankedState(), 'ace', 'king').state;
  assert.throws(() => applyRound(afterFirstRound, 'ace', 'queen'), /corresponding hand/);
  assert.throws(() => applyRound(afterFirstRound, 'queen', 'king'), /corresponding hand/);
});
