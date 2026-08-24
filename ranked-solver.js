'use strict';

const {
  CARD_IDS,
  applyRound,
  createInitialRankedState,
  getLegalCardIndices,
  isTerminalState,
  stateKey,
  terminalMatchScore
} = require('./ranked-engine');

const RANKED_SOLVER_VERSION = 'ranked-uniform-random-dp-v1';
const RANKED_EVALUATION_VERSION = 'decision-ev-regret-v1';
const VALUE_SCALE = 1_000_000_000_000n;

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1n;
}

function fraction(numerator, denominator = 1n) {
  if (denominator === 0n) throw new RangeError('fraction denominator must not be zero');
  let num = BigInt(numerator);
  let den = BigInt(denominator);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  if (num === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(num, den);
  return { numerator: num / divisor, denominator: den / divisor };
}

const ZERO = fraction(0n);
const HALF = fraction(1n, 2n);
const ONE = fraction(1n);

function add(left, right) {
  const shared = gcd(left.denominator, right.denominator);
  return fraction(
    left.numerator * (right.denominator / shared) + right.numerator * (left.denominator / shared),
    left.denominator * (right.denominator / shared)
  );
}

function divide(value, divisor) {
  return fraction(value.numerator, value.denominator * BigInt(divisor));
}

function compare(left, right) {
  const result = left.numerator * right.denominator - right.numerator * left.denominator;
  return result === 0n ? 0 : result > 0n ? 1 : -1;
}

function subtract(left, right) {
  return fraction(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function fractionToNumber(value) {
  return Number(value.numerator) / Number(value.denominator);
}

function fractionToScaledInt(value, scale = VALUE_SCALE) {
  const safeScale = BigInt(scale);
  // Non-negative utility only. Round to nearest to make serialized values stable.
  return (value.numerator * safeScale + value.denominator / 2n) / value.denominator;
}

function terminalUtility(state) {
  const score = terminalMatchScore(state);
  if (score === 1) return ONE;
  if (score === 0.5) return HALF;
  return ZERO;
}

class ExactRankedSolver {
  constructor() {
    this.memo = new Map();
  }

  solve(state) {
    const key = stateKey(state);
    const existing = this.memo.get(key);
    if (existing) return existing;

    if (isTerminalState(state)) {
      const terminal = { value: terminalUtility(state), qByCardIndex: new Map() };
      this.memo.set(key, terminal);
      return terminal;
    }

    const playerCards = getLegalCardIndices(state.playerMask);
    const aiCards = getLegalCardIndices(state.aiMask);
    const qByCardIndex = new Map();
    let bestValue = null;

    for (const playerCardIndex of playerCards) {
      let total = ZERO;
      for (const aiCardIndex of aiCards) {
        const child = this.solve(applyRound(state, playerCardIndex, aiCardIndex).state);
        total = add(total, child.value);
      }
      const q = divide(total, aiCards.length);
      qByCardIndex.set(playerCardIndex, q);
      if (!bestValue || compare(q, bestValue) > 0) bestValue = q;
    }

    const solved = { value: bestValue, qByCardIndex };
    this.memo.set(key, solved);
    return solved;
  }

  solveInitial() {
    return this.solve(createInitialRankedState());
  }

  get size() {
    return this.memo.size;
  }
}

function getInitialValueFraction() {
  const solver = new ExactRankedSolver();
  return solver.solveInitial().value;
}

function createRankedValueTable() {
  const solver = new ExactRankedSolver();
  const initial = solver.solveInitial().value;
  const values = {};

  for (const [key, solved] of solver.memo) {
    const q = {};
    let maxScaled = null;
    for (const [cardIndex, exactValue] of solved.qByCardIndex) {
      const scaled = fractionToScaledInt(exactValue);
      q[CARD_IDS[cardIndex]] = scaled.toString();
      if (maxScaled === null || scaled > maxScaled) maxScaled = scaled;
    }
    values[key] = {
      v: (maxScaled === null ? fractionToScaledInt(solved.value) : maxScaled).toString(),
      q
    };
  }

  return {
    metadata: {
      solverVersion: RANKED_SOLVER_VERSION,
      evaluationVersion: RANKED_EVALUATION_VERSION,
      valueScale: VALUE_SCALE.toString(),
      initialValueNumerator: initial.numerator.toString(),
      initialValueDenominator: initial.denominator.toString(),
      stateCount: solver.size
    },
    values
  };
}

module.exports = {
  ExactRankedSolver,
  HALF,
  ONE,
  RANKED_EVALUATION_VERSION,
  RANKED_SOLVER_VERSION,
  VALUE_SCALE,
  ZERO,
  add,
  compare,
  createRankedValueTable,
  divide,
  fraction,
  fractionToNumber,
  fractionToScaledInt,
  getInitialValueFraction,
  subtract,
  terminalUtility
};
