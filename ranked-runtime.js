'use strict';

const fs = require('fs');
const path = require('path');
const { createAuthConfig, AuthService, isAuthConfigured } = require('./auth');
const { createPostgresPool, readDatabaseQueryTimeout, readDatabaseSslConfig } = require('./database');
const { parseEncryptionKey } = require('./ranked-crypto');
const { PostgresRankedRepository } = require('./ranked-repository');
const { RankedService } = require('./ranked-service');
const { loadRankedValueTable } = require('./ranked-values');

const REQUIRED_RANKED_TABLES = Object.freeze([
  'profiles',
  'app_sessions',
  'oauth_transactions',
  'seasons',
  'ranked_profiles',
  'ranked_games',
  'ranked_moves',
  'app_schema_migrations'
]);

function hasRankedConfiguration(environment = process.env) {
  return [
    'DATABASE_URL',
    'APP_ORIGIN',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'RANKED_SEED_ENCRYPTION_KEY'
  ].some((name) => Boolean(environment[name]));
}

function listRequiredMigrationIds(migrationsDir = path.join(__dirname, 'migrations')) {
  return fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(file))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10) || left.localeCompare(right));
}

function unavailable(reason, { configured = false } = {}) {
  const runtime = {
    available: false,
    configured,
    reason,
    service: null,
    auth: null,
    repository: null,
    pool: null
  };
  runtime.checkReadiness = async () => ({
    status: configured ? 'unavailable' : 'disabled',
    reason
  });
  return runtime;
}

function createRankedReadinessChecker({
  available,
  configured,
  reason,
  pool,
  requiredMigrationIds = listRequiredMigrationIds(),
  cacheMs = 10_000,
  now = () => Date.now()
} = {}) {
  let cached = null;
  let pending = null;

  return async function checkRankedReadiness() {
    if (!configured) return { status: 'disabled', reason: reason || 'Ranked is not configured' };
    if (!available || !pool) return { status: 'unavailable', reason: reason || 'Ranked runtime is unavailable' };

    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) return cached.value;
    if (pending) return pending;

    pending = (async () => {
      try {
        const tableResult = await pool.query(
          `SELECT ${REQUIRED_RANKED_TABLES
            .map((name) => `to_regclass('public.${name}') AS ${name}`)
            .join(', ')}`
        );
        const tables = tableResult.rows?.[0] || {};
        const missingTables = REQUIRED_RANKED_TABLES.filter((name) => !tables[name]);
        if (missingTables.length > 0) {
          return {
            status: 'unavailable',
            reason: `Required Ranked tables are missing: ${missingTables.join(', ')}`
          };
        }

        const migrationResult = await pool.query('SELECT id FROM public.app_schema_migrations');
        const applied = new Set((migrationResult.rows || []).map((row) => row.id));
        const missingMigrations = requiredMigrationIds.filter((id) => !applied.has(id));
        if (missingMigrations.length > 0) {
          return {
            status: 'unavailable',
            reason: `Required migrations are missing: ${missingMigrations.join(', ')}`
          };
        }

        return { status: 'ready', reason: null };
      } catch (error) {
        return {
          status: 'unavailable',
          // Do not surface database topology, credentials, or driver errors
          // through a public health endpoint.
          reason: 'Ranked persistence check failed'
        };
      }
    })();

    try {
      const value = await pending;
      cached = { value, expiresAt: now() + cacheMs };
      return value;
    } finally {
      pending = null;
    }
  };
}

function attachPoolErrorHandler(pool, logger = console) {
  if (typeof pool?.on !== 'function') return;
  // pg-pool emits `error` for an idle client's network/database failure. An
  // EventEmitter with no listener would terminate this Node process, taking
  // the independent guest PvP service down with an optional Ranked database.
  pool.on('error', (error) => logger.warn?.(`Ranked database pool error: ${error.message}`));
}

function createRankedRuntime({ environment = process.env, logger = console } = {}) {
  const configured = hasRankedConfiguration(environment);
  const config = createAuthConfig(environment);
  if (!environment.DATABASE_URL) return unavailable('DATABASE_URL is not configured', { configured });
  if (!isAuthConfigured(config)) return unavailable('Supabase Auth or APP_ORIGIN is not configured', { configured });
  if (!environment.RANKED_SEED_ENCRYPTION_KEY) return unavailable('RANKED_SEED_ENCRYPTION_KEY is not configured', { configured });

  let valueLookup;
  let seedEncryptionKey;
  let pool;
  try {
    valueLookup = loadRankedValueTable(environment.RANKED_VALUES_FILE || undefined);
    seedEncryptionKey = parseEncryptionKey(environment.RANKED_SEED_ENCRYPTION_KEY);
    pool = createPostgresPool({
      connectionString: environment.DATABASE_URL,
      ssl: readDatabaseSslConfig(environment.DATABASE_SSL, environment.NODE_ENV),
      queryTimeoutMs: readDatabaseQueryTimeout(environment.DATABASE_QUERY_TIMEOUT_MS)
    });
    attachPoolErrorHandler(pool, logger);
  } catch (error) {
    logger.warn?.(`Ranked disabled: ${error.message}`);
    return unavailable('Ranked value table or persistence initialization failed', { configured });
  }

  const repository = new PostgresRankedRepository(pool);
  const service = new RankedService({
    repository,
    valueLookup,
    seedEncryptionKey,
    turnTimeLimitMs: Number.parseInt(environment.RANKED_TURN_TIME_LIMIT_MS, 10) || undefined,
    abandonAfterMs: Number.parseInt(environment.RANKED_ABANDON_AFTER_MS, 10) || undefined
  });
  const auth = new AuthService({ repository, config });
  const runtime = {
    available: true,
    configured,
    reason: null,
    service,
    auth,
    repository,
    pool
  };
  runtime.checkReadiness = createRankedReadinessChecker({
    available: runtime.available,
    configured: runtime.configured,
    reason: runtime.reason,
    pool: runtime.pool
  });
  return runtime;
}

function startRankedDeadlineSweeper(runtime, { intervalMs = 30_000, logger = console } = {}) {
  if (!runtime?.available) return null;
  const timer = setInterval(() => {
    runtime.service.expireDueGames().catch((error) => logger.warn?.(`Ranked deadline sweep failed: ${error.message}`));
    runtime.service.pruneExpiredAuthArtifacts().catch((error) => logger.warn?.(`Ranked auth cleanup failed: ${error.message}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  REQUIRED_RANKED_TABLES,
  attachPoolErrorHandler,
  createRankedReadinessChecker,
  createRankedRuntime,
  hasRankedConfiguration,
  listRequiredMigrationIds,
  startRankedDeadlineSweeper
};
