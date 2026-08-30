'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseEndpointIdentity, readTestDatabaseUrl } = require('./scripts/postgres-test-config');

const LOCAL_TEST_URL = 'postgresql://test:test@127.0.0.1:5432/overthinking_test';

test('PostgreSQL統合テストは明示的な隔離DB以外を拒否する', () => {
  assert.throws(() => readTestDatabaseUrl({}), /RUN_POSTGRES_INTEGRATION/);
  assert.throws(() => readTestDatabaseUrl({ RUN_POSTGRES_INTEGRATION: '1' }), /TEST_DATABASE_URL is required/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: LOCAL_TEST_URL,
    DATABASE_URL: LOCAL_TEST_URL
  }), /same database endpoint/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: 'postgresql://test:test@localhost:5432/overthinking_test',
    DATABASE_URL: 'postgres://production:other@localhost/overthinking_test'
  }), /same database endpoint/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: 'https://example.test/not-a-db'
  }), /PostgreSQL protocol/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/overthinking'
  }), /contain test or testing/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: 'postgresql://test:test@db.example.test:5432/overthinking_test'
  }), /ALLOW_REMOTE_TEST_DATABASE/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: `${LOCAL_TEST_URL}?host=db.example.test`
  }), /may not override its endpoint/);
  assert.throws(() => readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: `${LOCAL_TEST_URL}?PORT=6543`
  }), /may not override its endpoint/);
});

test('PostgreSQL統合テストはローカルまたは明示承認済みのtest DBだけを受け入れる', () => {
  assert.equal(readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: LOCAL_TEST_URL
  }), LOCAL_TEST_URL);
  const remoteTestUrl = 'postgresql://test:test@db.example.test:5432/overthinking_testing';
  assert.equal(readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: remoteTestUrl,
    ALLOW_REMOTE_TEST_DATABASE: '1'
  }), remoteTestUrl);
});

test('接続先比較はnode-postgresのhost/port解釈を明示的に正規化する', () => {
  assert.deepEqual(
    databaseEndpointIdentity('postgres://test:test@LOCALHOST/overthinking_test', {}),
    { host: 'localhost', port: '5432', databaseName: 'overthinking_test' }
  );
  assert.deepEqual(
    databaseEndpointIdentity('postgresql://test:test@127.0.0.1/overthinking_test?host=db.example.test&port=6432', {}),
    { host: 'db.example.test', port: '6432', databaseName: 'overthinking_test' }
  );
  assert.equal(readTestDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: '1',
    TEST_DATABASE_URL: 'postgresql://test:test@[::1]:5432/overthinking_test'
  }), 'postgresql://test:test@[::1]:5432/overthinking_test');
});
