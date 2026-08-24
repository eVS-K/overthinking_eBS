'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMigrations, listMigrationFiles } = require('./scripts/migrate');

const migrationsDir = path.join(__dirname, 'migrations');

test('migrationは番号順に並び、各ファイルを一つのtransactionとして記録する', async () => {
  const files = listMigrationFiles(migrationsDir);
  assert.deepEqual(files, [...files].sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10) || left.localeCompare(right)));
  assert.deepEqual(files, [
    '001_ranked.sql',
    '002_harden_ranked_database_access.sql',
    '003_replace_legacy_uuid_derived_handles.sql'
  ]);

  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'SELECT id FROM app_schema_migrations') return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  await applyMigrations({ connect: async () => client }, migrationsDir);
  assert.equal(queries.filter(({ sql }) => sql === 'BEGIN').length, files.length);
  assert.equal(queries.filter(({ sql }) => sql === 'COMMIT').length, files.length);
  assert.equal(queries.filter(({ sql }) => sql.startsWith('INSERT INTO app_schema_migrations')).length, files.length);
  assert.equal(queries.some(({ sql }) => sql.includes('ENABLE ROW LEVEL SECURITY')), true);
  assert.equal(queries.some(({ sql }) => sql.includes('REVOKE ALL PRIVILEGES')), true);
  assert.equal(queries.at(-1).sql, 'SELECT pg_advisory_unlock($1)');
});
