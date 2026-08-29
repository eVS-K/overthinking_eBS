'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  REQUIRED_RANKED_TABLES,
  attachPoolErrorHandler,
  createRankedReadinessChecker,
  createRankedRuntime
} = require('./ranked-runtime');

test('idle PostgreSQL pool errorは記録してGuest PvPのNode processを落とさない', () => {
  const pool = new EventEmitter();
  const notices = [];
  attachPoolErrorHandler(pool, { warn: (message) => notices.push(message) });
  assert.doesNotThrow(() => pool.emit('error', new Error('connection reset')));
  assert.match(notices[0], /Ranked database pool error: connection reset/);
});

test('Ranked設定がない場合はruntimeだけfail closedし、PvP起動を妨げない', async () => {
  const notices = [];
  const runtime = createRankedRuntime({ environment: { NODE_ENV: 'test' }, logger: { warn: (message) => notices.push(message) } });
  assert.equal(runtime.available, false);
  assert.match(runtime.reason, /DATABASE_URL/);
  assert.deepEqual(await runtime.checkReadiness(), {
    status: 'disabled',
    reason: 'DATABASE_URL is not configured'
  });
  assert.deepEqual(notices, []);
});

test('保存済みPrivate設定tableも認証ランタイムのreadiness対象に含める', () => {
  assert.equal(REQUIRED_RANKED_TABLES.includes('private_pvp_presets'), true);
});

test('Readinessは必須tableと全migrationを確認し、短時間の同一確認をDBへ重複送信しない', async () => {
  let queryCount = 0;
  const pool = {
    query: async (sql) => {
      queryCount += 1;
      if (sql.startsWith('SELECT to_regclass')) {
        return {
          rows: [Object.fromEntries(REQUIRED_RANKED_TABLES.map((name) => [name, name]))]
        };
      }
      return { rows: [{ id: '001_ranked.sql' }, { id: '002_harden_ranked_database_access.sql' }] };
    }
  };
  const checkReadiness = createRankedReadinessChecker({
    available: true,
    configured: true,
    pool,
    requiredMigrationIds: ['001_ranked.sql', '002_harden_ranked_database_access.sql'],
    now: () => 1_000
  });
  assert.deepEqual(await checkReadiness(), { status: 'ready', reason: null });
  assert.deepEqual(await checkReadiness(), { status: 'ready', reason: null });
  assert.equal(queryCount, 2);
});

test('Readinessはmigration不足やDBエラーを公開せずRankedをdegradedとして返す', async () => {
  const missingMigration = createRankedReadinessChecker({
    available: true,
    configured: true,
    pool: {
      query: async (sql) => sql.startsWith('SELECT to_regclass')
        ? { rows: [Object.fromEntries(REQUIRED_RANKED_TABLES.map((name) => [name, name]))] }
        : { rows: [{ id: '001_ranked.sql' }] }
    },
    requiredMigrationIds: ['001_ranked.sql', '002_harden_ranked_database_access.sql']
  });
  assert.match((await missingMigration()).reason, /002_harden/);

  const unavailableDatabase = createRankedReadinessChecker({
    available: true,
    configured: true,
    pool: { query: async () => { throw new Error('password=secret host=private'); } },
    requiredMigrationIds: []
  });
  assert.deepEqual(await unavailableDatabase(), {
    status: 'unavailable',
    reason: 'Ranked persistence check failed'
  });
});

test('value tableが検証不能ならRankedだけfail closedする', () => {
  const notices = [];
  const runtime = createRankedRuntime({
    environment: {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://ranked.test/database',
      APP_ORIGIN: 'https://ranked.test',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'public',
      RANKED_SEED_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      RANKED_VALUES_FILE: 'C:/definitely-missing-ranked-values.json'
    },
    logger: { warn: (message) => notices.push(message) }
  });
  assert.equal(runtime.available, false);
  assert.match(runtime.reason, /value table/);
  assert.equal(notices.length, 1);
});
