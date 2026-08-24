'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  RANKED_RULES_VERSION,
  applyRound,
  createInitialRankedState,
  getLegalCardIds,
  getLegalCardIndices,
  isTerminalState,
  stateKey,
  terminalMatchScore
} = require('./ranked-engine');
const {
  RANKED_EVALUATION_VERSION,
  RANKED_SOLVER_VERSION,
  VALUE_SCALE,
  createRankedValueTable
} = require('./ranked-solver');

const RANKED_VALUES_FILE = path.join(__dirname, 'data', 'ranked-values.v1.json');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function checksumPayload(table) {
  const metadata = { ...(table?.metadata || {}) };
  delete metadata.checksum;
  return { metadata, values: table?.values };
}

function computeRankedValuesChecksum(table) {
  return crypto.createHash('sha256').update(stableStringify(checksumPayload(table))).digest('hex');
}

function createSignedRankedValueTable() {
  const generated = createRankedValueTable();
  const table = {
    metadata: {
      ...generated.metadata,
      rulesVersion: RANKED_RULES_VERSION,
      checksum: ''
    },
    values: generated.values
  };
  table.metadata.checksum = computeRankedValuesChecksum(table);
  return table;
}

function assertScaledValue(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${label} is not a scaled integer string`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > VALUE_SCALE) throw new Error(`${label} is outside [0, VALUE_SCALE]`);
  return parsed;
}

function validateRankedValueTable(table) {
  if (!table || typeof table !== 'object' || !table.metadata || !table.values) {
    throw new Error('ranked value table has an invalid shape');
  }
  const { metadata } = table;
  if (metadata.rulesVersion !== RANKED_RULES_VERSION) throw new Error('ranked value table rules version mismatch');
  if (metadata.solverVersion !== RANKED_SOLVER_VERSION) throw new Error('ranked value table solver version mismatch');
  if (metadata.evaluationVersion !== RANKED_EVALUATION_VERSION) throw new Error('ranked value table evaluation version mismatch');
  if (metadata.valueScale !== VALUE_SCALE.toString()) throw new Error('ranked value table scale mismatch');
  if (metadata.initialValueNumerator !== '1931' || metadata.initialValueDenominator !== '2520') {
    throw new Error('ranked value table initial value mismatch');
  }
  if (typeof metadata.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.checksum)) {
    throw new Error('ranked value table checksum is malformed');
  }
  if (computeRankedValuesChecksum(table) !== metadata.checksum) {
    throw new Error('ranked value table checksum mismatch');
  }

  const initialKey = stateKey(createInitialRankedState());
  if (!table.values[initialKey]) throw new Error('ranked value table does not include initial state');

  // A checksum protects the generated file against accidental mismatch, but it
  // does not by itself prove that a syntactically valid table covers the exact
  // game graph. Walk the canonical graph before Ranked is enabled: every
  // reachable non-terminal state needs precisely one Q value per legal player
  // card, and its V must be max(Q). This is deliberately a startup-only check;
  // the request path remains a constant-time table lookup.
  const visited = new Set();
  const validateState = (state) => {
    const key = stateKey(state);
    if (visited.has(key)) return;
    visited.add(key);

    const entry = table.values[key];
    if (!entry || typeof entry !== 'object' || !entry.q || typeof entry.q !== 'object') {
      throw new Error(`ranked value table is missing or malformed at reachable state ${key}`);
    }
    const value = assertScaledValue(entry.v, `V(${key})`);
    const qEntries = Object.entries(entry.q);

    if (isTerminalState(state)) {
      if (qEntries.length !== 0) throw new Error(`terminal state ${key} must not contain legal actions`);
      const matchScore = terminalMatchScore(state);
      const expected = matchScore === 0.5 ? VALUE_SCALE / 2n : matchScore === 1 ? VALUE_SCALE : 0n;
      if (value !== expected) throw new Error(`terminal utility mismatch at ${key}`);
      return;
    }

    const legalCards = getLegalCardIds(state.playerMask);
    if (qEntries.length !== legalCards.length || qEntries.some(([cardId]) => !legalCards.includes(cardId))) {
      throw new Error(`ranked value table actions do not match legal cards at ${key}`);
    }
    let maximumQ = null;
    for (const [cardId, q] of qEntries) {
      const qValue = assertScaledValue(q, `Q(${key}, ${cardId})`);
      if (qValue > value) throw new Error(`ranked value table has negative regret at ${key}/${cardId}`);
      if (maximumQ === null || qValue > maximumQ) maximumQ = qValue;
    }
    if (value !== maximumQ) throw new Error(`ranked value table violates V=max(Q) at ${key}`);

    for (const playerCardIndex of getLegalCardIndices(state.playerMask)) {
      for (const aiCardIndex of getLegalCardIndices(state.aiMask)) {
        validateState(applyRound(state, playerCardIndex, aiCardIndex).state);
      }
    }
  };

  validateState(createInitialRankedState());
  if (visited.size !== Number(metadata.stateCount)) {
    throw new Error('ranked value table reachable state count mismatch');
  }
  return table;
}

class RankedValueLookup {
  constructor(table) {
    this.table = validateRankedValueTable(table);
    this.valueScale = VALUE_SCALE;
  }

  getStateValues(state) {
    const key = stateKey(state);
    const entry = this.table.values[key];
    if (!entry) throw new Error(`ranked value lookup missing reachable state ${key}`);
    return {
      stateKey: key,
      value: BigInt(entry.v),
      qByCardId: entry.q
    };
  }

  getDecision(state, cardId) {
    const values = this.getStateValues(state);
    const q = values.qByCardId[cardId];
    if (q === undefined) throw new Error(`ranked value lookup missing legal card ${cardId}`);
    const qValue = BigInt(q);
    const regret = values.value - qValue;
    if (regret < 0n) throw new Error('ranked value lookup produced negative regret');
    return {
      stateKey: values.stateKey,
      value: values.value,
      q: qValue,
      regret
    };
  }
}

function loadRankedValueTable(filePath = RANKED_VALUES_FILE) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return new RankedValueLookup(JSON.parse(raw));
}

module.exports = {
  RANKED_VALUES_FILE,
  RankedValueLookup,
  computeRankedValuesChecksum,
  createSignedRankedValueTable,
  loadRankedValueTable,
  stableStringify,
  validateRankedValueTable
};
