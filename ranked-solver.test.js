'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRound, createInitialRankedState, getLegalCardIndices, isTerminalState, popcount, stateFromKey } = require('./ranked-engine');
const {
  ExactRankedSolver,
  HALF,
  ONE,
  ZERO,
  compare,
  fractionToNumber,
  subtract,
  terminalUtility
} = require('./ranked-solver');

const solver = new ExactRankedSolver();

test('Ranked solver の初期値は golden value 1931 / 2520', () => {
  const value = solver.solveInitial().value;
  assert.equal(value.numerator, 1931n);
  assert.equal(value.denominator, 2520n);
  assert.equal(fractionToNumber(value), 1931 / 2520);
});

test('全reachable stateで V(s) = max Q(s,a)、regret >= 0', () => {
  solver.solveInitial();
  for (const solved of solver.memo.values()) {
    if (!solved.qByCardIndex.size) continue;
    let maxQ = null;
    for (const q of solved.qByCardIndex.values()) {
      if (!maxQ || compare(q, maxQ) > 0) maxQ = q;
      assert.ok(compare(subtract(solved.value, q), ZERO) >= 0);
    }
    assert.equal(compare(solved.value, maxQ), 0);
  }
});

test('terminal utility はWin=1 / Draw=.5 / Loss=0', () => {
  assert.deepEqual(terminalUtility({ playerMask: 0, aiMask: 0, playerScore: 2, aiScore: 0, stackCount: 12 }), ONE);
  assert.deepEqual(terminalUtility({ playerMask: 0, aiMask: 0, playerScore: 1, aiScore: 1, stackCount: 12 }), HALF);
  assert.deepEqual(terminalUtility({ playerMask: 0, aiMask: 0, playerScore: 0, aiScore: 2, stackCount: 12 }), ZERO);
});

test('solverは初期状態を解け、循環せず有限のreachable stateだけをmemoizeする', () => {
  const initial = createInitialRankedState();
  solver.solve(initial);
  assert.ok(solver.size > 1);
  assert.ok(solver.size < 1_000_000);
});

test('全reachable transitionは必ず残り手札を一枚ずつ減らすため有限である', () => {
  solver.solveInitial();
  for (const key of solver.memo.keys()) {
    const state = stateFromKey(key);
    if (isTerminalState(state)) continue;
    for (const playerCard of getLegalCardIndices(state.playerMask)) {
      for (const aiCard of getLegalCardIndices(state.aiMask)) {
        const next = applyRound(state, playerCard, aiCard).state;
        assert.equal(popcount(next.playerMask), popcount(state.playerMask) - 1);
        assert.equal(popcount(next.aiMask), popcount(state.aiMask) - 1);
      }
    }
  }
});
