'use strict';

// This file is deliberately not named `*.test.js`: it resets the public
// schema of an explicitly designated disposable PostgreSQL database and must
// never be picked up by the ordinary, dependency-free `npm test` suite.
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPostgresPool } = require('./database');
const { applyMigrations, listMigrationFiles } = require('./scripts/migrate');
const { PostgresRankedRepository } = require('./ranked-repository');
const { PrivatePresetService } = require('./private-preset-service');
const { RankedError, RankedService } = require('./ranked-service');
const { loadRankedValueTable } = require('./ranked-values');
const { readTestDatabaseUrl } = require('./scripts/postgres-test-config');

const TEST_TABLES = Object.freeze([
  'profiles',
  'app_sessions',
  'oauth_transactions',
  'seasons',
  'ranked_profiles',
  'ranked_games',
  'ranked_moves',
  'app_schema_migrations',
  'private_pvp_presets'
]);
const RESTRICTED_ROLES = Object.freeze(['anon', 'authenticated']);
const TABLE_PRIVILEGES = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
]);
const SEQUENCE_PRIVILEGES = Object.freeze(['SELECT', 'USAGE', 'UPDATE']);

function uniqueUserId() {
  return crypto.randomUUID();
}

function uniqueHash() {
  return crypto.randomBytes(32).toString('hex');
}

function classicPreset(name) {
  return {
    name,
    config: {
      ruleset: 'classic-v1',
      turnTimeLimitMs: 90_000
    }
  };
}

function assertRankedError(code) {
  return (error) => error instanceof RankedError && error.code === code;
}

async function ensureTestRoles(pool) {
  // PostgreSQL's official CI image starts without Supabase's browser roles.
  // Create no-login equivalents before the hardening migration so its REVOKE
  // statements are exercised rather than silently skipped.
  await pool.query(`DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
    END
  $roles$;`);
}

async function assertTestDatabasePermissions(client) {
  // Check the permissions that this intentionally destructive test needs
  // before dropping the schema. A local user without these capabilities gets
  // a clear setup error instead of an empty schema followed by a later role or
  // extension failure.
  const { rows } = await client.query(
    `SELECT (r.rolsuper OR r.rolcreaterole) AS can_create_role,
            has_database_privilege(current_database(), 'CREATE') AS can_create_schema,
            (r.rolsuper OR EXISTS (
              SELECT 1
              FROM pg_namespace n
              WHERE n.nspname = 'public' AND n.nspowner = r.oid
            )) AS owns_public_schema,
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto') AS has_pgcrypto
     FROM pg_roles r
     WHERE r.rolname = current_user`
  );
  const permissions = rows[0];
  if (!permissions?.can_create_role
    || !permissions?.can_create_schema
    || !permissions?.owns_public_schema
    || !permissions?.has_pgcrypto) {
    throw new Error('PostgreSQL integration tests require a disposable database role with CREATE ROLE, database CREATE privilege, ownership of the public schema, and the pgcrypto extension available.');
  }
}

async function assertMigrationAccessControls(pool) {
  const migrationIds = (await pool.query('SELECT id FROM public.app_schema_migrations ORDER BY id ASC')).rows.map((row) => row.id);
  assert.deepEqual(migrationIds, listMigrationFiles(require('path').join(__dirname, 'migrations')));

  const tableResult = await pool.query(
    `SELECT c.relname, c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [TEST_TABLES]
  );
  assert.equal(tableResult.rows.length, TEST_TABLES.length, 'all application tables must exist in public');
  for (const row of tableResult.rows) {
    assert.equal(row.relrowsecurity, true, `RLS must be enabled for public.${row.relname}`);
  }

  for (const role of RESTRICTED_ROLES) {
    for (const table of TEST_TABLES) {
      for (const privilege of TABLE_PRIVILEGES) {
        const { rows } = await pool.query(
          'SELECT has_table_privilege($1, $2, $3) AS allowed',
          [role, `public.${table}`, privilege]
        );
        assert.equal(rows[0].allowed, false, `${role} must not have ${privilege} on public.${table}`);
      }
    }
  }
  for (const role of RESTRICTED_ROLES) {
    for (const privilege of SEQUENCE_PRIVILEGES) {
      const { rows } = await pool.query(
        'SELECT has_sequence_privilege($1, $2, $3) AS allowed',
        [role, 'public.ranked_moves_id_seq', privilege]
      );
      assert.equal(rows[0].allowed, false, `${role} must not have ${privilege} on public.ranked_moves_id_seq`);
    }
  }
}

async function countActiveGames(pool, userId) {
  const { rows } = await pool.query(
    "SELECT count(*)::integer AS total FROM public.ranked_games WHERE user_id = $1 AND status = 'active'",
    [userId]
  );
  return Number(rows[0].total);
}

let testDatabaseUrl;
let setupError;
try {
  testDatabaseUrl = readTestDatabaseUrl();
} catch (error) {
  setupError = error;
}

if (setupError) {
  test('PostgreSQL integration test safety guard', () => {
    throw setupError;
  });
} else {
  test('実PostgreSQL: migration、権限、競合、所有権を隔離DBで検証する', { concurrency: false }, async (t) => {
    const pool = createPostgresPool({
      connectionString: testDatabaseUrl,
      ssl: false,
      queryTimeoutMs: 20_000
    });
    let isolationClient;
    t.after(async () => {
      if (isolationClient) {
        await isolationClient.query('SELECT pg_advisory_unlock($1)', [741_902_319]).catch(() => {});
        isolationClient.release();
      }
      await pool.end();
    });

    // Keep a session advisory lock for the full test. It prevents two CI
    // processes accidentally configured with the same disposable database
    // from interleaving schema resets, while repository operations still use
    // separate pool connections to exercise real row locking.
    isolationClient = await pool.connect();
    await isolationClient.query('SELECT pg_advisory_lock($1)', [741_902_319]);
    await assertTestDatabasePermissions(isolationClient);

    // This is intentionally destructive, but only after the explicit guards
    // above. Each run starts from an empty schema and cannot accidentally
    // migrate or write through DATABASE_URL.
    await isolationClient.query('DROP SCHEMA public CASCADE');
    await isolationClient.query('CREATE SCHEMA public');
    await ensureTestRoles(pool);
    await applyMigrations(pool);

    const repository = new PostgresRankedRepository(pool);
    const rankedService = new RankedService({
      repository,
      valueLookup: loadRankedValueTable(),
      seedEncryptionKey: Buffer.alloc(32, 73)
    });
    const presetService = new PrivatePresetService({ repository });

    await t.test('migrationがpublic schema、RLS、直接DB権限を実際に保護する', async () => {
      await assertMigrationAccessControls(pool);
    });

    await t.test('同一accountの同時作成はactive game一件へ収束する', async () => {
      const userId = uniqueUserId();
      const [first, second] = await Promise.all([
        rankedService.createOrResumeGame(userId),
        rankedService.createOrResumeGame(userId)
      ]);
      assert.equal(first.id, second.id);
      assert.equal(await countActiveGames(pool, userId), 1);
      assert.equal((await repository.findActiveGameForUser(userId)).id, first.id);
    });

    await t.test('moveの同時再送と同ラウンド競合は一度だけ状態を進める', async () => {
      const duplicateUserId = uniqueUserId();
      const duplicateGame = await rankedService.createOrResumeGame(duplicateUserId);
      const requestId = crypto.randomUUID();
      const duplicateResults = await Promise.all([
        rankedService.submitMove(duplicateUserId, duplicateGame.id, { expectedRound: 1, cardId: 'ace', requestId }),
        rankedService.submitMove(duplicateUserId, duplicateGame.id, { expectedRound: 1, cardId: 'ace', requestId })
      ]);
      assert.deepEqual(duplicateResults.map((result) => result.idempotent).sort(), [false, true]);
      assert.equal((await repository.listMoves(duplicateGame.id)).length, 1);
      assert.equal((await repository.findGameById(duplicateGame.id)).currentRound, 2);

      const raceUserId = uniqueUserId();
      const raceGame = await rankedService.createOrResumeGame(raceUserId);
      const raceResults = await Promise.allSettled([
        rankedService.submitMove(raceUserId, raceGame.id, { expectedRound: 1, cardId: 'ace', requestId: crypto.randomUUID() }),
        rankedService.submitMove(raceUserId, raceGame.id, { expectedRound: 1, cardId: 'ace', requestId: crypto.randomUUID() })
      ]);
      assert.equal(raceResults.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(raceResults.filter((result) => result.status === 'rejected').length, 1);
      const rejected = raceResults.find((result) => result.status === 'rejected');
      assert.ok(rejected && assertRankedError('ROUND_MISMATCH')(rejected.reason));
      assert.equal((await repository.listMoves(raceGame.id)).length, 1);
      assert.equal((await repository.findGameById(raceGame.id)).currentRound, 2);
    });

    await t.test('同時forfeitでもRatingは一回だけ確定する', async () => {
      const userId = uniqueUserId();
      const game = await rankedService.createOrResumeGame(userId);
      const results = await Promise.all([
        rankedService.forfeitGame(userId, game.id),
        rankedService.forfeitGame(userId, game.id)
      ]);
      assert.equal(results[0].status, 'forfeited');
      assert.equal(results[1].status, 'forfeited');
      const persistedGame = await repository.findGameById(game.id);
      assert.ok(persistedGame.ratingFinalizedAt);
      const profile = await rankedService.getProfileSummary(userId);
      assert.equal(profile.ratedGames, 1);
      assert.equal(profile.forfeits, 1);
    });

    await t.test('Private設定は実DBでも十件上限と所有権を守る', async () => {
      const ownerId = uniqueUserId();
      const otherUserId = uniqueUserId();
      await Promise.all([repository.ensureProfile(ownerId), repository.ensureProfile(otherUserId)]);
      const results = await Promise.allSettled(
        Array.from({ length: 11 }, (_unused, index) => presetService.createPreset(ownerId, classicPreset(`preset-${index + 1}`)))
      );
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      assert.equal(fulfilled.length, 10);
      assert.equal(rejected.length, 1);
      assert.ok(assertRankedError('PRIVATE_PRESET_LIMIT')(rejected[0].reason));
      const presets = await repository.listPrivatePresets(ownerId);
      assert.equal(presets.length, 10);
      assert.equal(new Set(presets.map((preset) => preset.slot)).size, 10);
      const original = presets[0];
      await assert.rejects(
        presetService.updatePreset(otherUserId, original.id, classicPreset('not-owner')),
        assertRankedError('PRIVATE_PRESET_NOT_FOUND')
      );
      const stillOwned = await repository.findPrivatePresetById(ownerId, original.id);
      assert.equal(stillOwned.name, original.name);
    });

    await t.test('OAuth transactionのconsumeとrollbackは実transactionで一回だけ行われる', async () => {
      const stateHash = uniqueHash();
      const expiresAt = new Date(Date.now() + 60_000);
      await repository.createOAuthTransaction({
        stateHash,
        provider: 'github',
        codeVerifier: 'integration-test-verifier',
        redirectUri: 'https://example.test/auth/callback',
        returnPath: '/ranked',
        expiresAt
      });
      const consumed = await Promise.all([
        repository.consumeOAuthTransaction(stateHash),
        repository.consumeOAuthTransaction(stateHash)
      ]);
      assert.equal(consumed.filter(Boolean).length, 1);

      const rollbackHash = uniqueHash();
      await assert.rejects(repository.transaction(async (tx) => {
        await tx.createOAuthTransaction({
          stateHash: rollbackHash,
          provider: 'google',
          codeVerifier: 'rollback-verifier',
          redirectUri: 'https://example.test/auth/callback',
          returnPath: '/',
          expiresAt
        });
        throw new Error('intentional rollback');
      }), /intentional rollback/);
      assert.equal(await repository.consumeOAuthTransaction(rollbackHash), null);
    });
  });
}
