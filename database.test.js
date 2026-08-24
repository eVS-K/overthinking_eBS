'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_DATABASE_QUERY_TIMEOUT_MS, readDatabaseQueryTimeout, readDatabaseSslConfig } = require('./database');

test('database timeout設定は安全な範囲だけを受け入れる', () => {
  assert.equal(readDatabaseQueryTimeout('1000'), 1000);
  assert.equal(readDatabaseQueryTimeout('60000'), 60000);
  assert.equal(readDatabaseQueryTimeout('999'), DEFAULT_DATABASE_QUERY_TIMEOUT_MS);
  assert.equal(readDatabaseQueryTimeout('60001'), DEFAULT_DATABASE_QUERY_TIMEOUT_MS);
  assert.equal(readDatabaseQueryTimeout('not-a-number'), DEFAULT_DATABASE_QUERY_TIMEOUT_MS);
  assert.equal(readDatabaseSslConfig('disable'), false);
  assert.deepEqual(readDatabaseSslConfig(undefined, 'production'), { rejectUnauthorized: true });
});
