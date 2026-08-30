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
    '003_replace_legacy_uuid_derived_handles.sql',
    '004_leaderboard_visibility_and_threshold.sql',
    '005_private_pvp_presets.sql'
  ]);

  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'SELECT id FROM public.app_schema_migrations') return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  await applyMigrations({ connect: async () => client }, migrationsDir);
  assert.equal(queries.filter(({ sql }) => sql === 'BEGIN').length, files.length);
  assert.equal(queries.filter(({ sql }) => sql === 'COMMIT').length, files.length);
  assert.equal(queries.filter(({ sql }) => sql.startsWith('INSERT INTO public.app_schema_migrations')).length, files.length);
  assert.equal(queries[0].sql, 'SET search_path TO public');
  assert.equal(queries[1].sql.includes('CREATE TABLE IF NOT EXISTS public.app_schema_migrations'), true);
  assert.equal(queries.some(({ sql }) => sql.includes('ENABLE ROW LEVEL SECURITY')), true);
  assert.equal(queries.some(({ sql }) => sql.includes('REVOKE ALL PRIVILEGES')), true);
  assert.equal(queries.at(-1).sql, 'SELECT pg_advisory_unlock($1)');
});

test('Private設定プリセットmigrationは保存数・所有者・OAuth復帰先をDBでも制限する', () => {
  const sql = require('fs').readFileSync(path.join(migrationsDir, '005_private_pvp_presets.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.private_pvp_presets/);
  assert.match(sql, /preset_slot SMALLINT NOT NULL CHECK \(preset_slot BETWEEN 1 AND 10\)/);
  assert.match(sql, /UNIQUE \(user_id, preset_slot\)/);
  assert.match(sql, /UNIQUE \(user_id, normalized_name\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS return_path/);
  assert.match(sql, /CHECK \(return_path IN \('\/', '\/ranked'\)\)/);
  assert.match(sql, /ALTER TABLE public\.private_pvp_presets ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.private_pvp_presets/);
});
