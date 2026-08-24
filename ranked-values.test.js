'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialRankedState } = require('./ranked-engine');
const {
  RankedValueLookup,
  computeRankedValuesChecksum,
  createSignedRankedValueTable,
  loadRankedValueTable,
  validateRankedValueTable
} = require('./ranked-values');

let table;

test('生成済みRanked value tableはversion/checksum/golden valueを検証できる', () => {
  table = createSignedRankedValueTable();
  assert.equal(table.metadata.initialValueNumerator, '1931');
  assert.equal(table.metadata.initialValueDenominator, '2520');
  assert.equal(validateRankedValueTable(table), table);
  assert.equal(computeRankedValuesChecksum(table), table.metadata.checksum);
});

test('lookupは合法手のV/Q/regretをscaled integerで返す', () => {
  const lookup = new RankedValueLookup(table || createSignedRankedValueTable());
  const decision = lookup.getDecision(createInitialRankedState(), 'ace');
  assert.ok(decision.value >= decision.q);
  assert.equal(decision.regret, decision.value - decision.q);
});

test('checksumまたはQが改ざんされたtableはfail closedする', () => {
  const invalid = createSignedRankedValueTable();
  invalid.values['127.127.0.0.0'].q.ace = '1000000000000';
  assert.throws(() => validateRankedValueTable(invalid), /checksum mismatch/);
});

test('checksumを作り直しても、reachable stateのV=max(Q)またはaction欠落はfail closedする', () => {
  const invalidValue = createSignedRankedValueTable();
  invalidValue.values['127.127.0.0.0'].v = '999999999999';
  invalidValue.metadata.checksum = computeRankedValuesChecksum(invalidValue);
  assert.throws(() => validateRankedValueTable(invalidValue), /V=max\(Q\)/);

  const missingAction = createSignedRankedValueTable();
  delete missingAction.values['127.127.0.0.0'].q.ace;
  missingAction.metadata.checksum = computeRankedValuesChecksum(missingAction);
  assert.throws(() => validateRankedValueTable(missingAction), /actions do not match legal cards/);
});

test('リリースartifactは実際に読み込め、初期stateをlookupできる', () => {
  const lookup = loadRankedValueTable();
  const decision = lookup.getDecision(createInitialRankedState(), 'ace');
  assert.equal(lookup.table.metadata.stateCount, 34453);
  assert.ok(decision.value >= decision.q);
});
