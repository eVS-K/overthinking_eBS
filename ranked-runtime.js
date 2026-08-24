'use strict';

const { createAuthConfig, AuthService, isAuthConfigured } = require('./auth');
const { createPostgresPool } = require('./database');
const { parseEncryptionKey } = require('./ranked-crypto');
const { PostgresRankedRepository } = require('./ranked-repository');
const { RankedService } = require('./ranked-service');
const { loadRankedValueTable } = require('./ranked-values');

function unavailable(reason) {
  return { available: false, reason, service: null, auth: null, repository: null, pool: null };
}

function createRankedRuntime({ environment = process.env, logger = console } = {}) {
  const config = createAuthConfig(environment);
  if (!environment.DATABASE_URL) return unavailable('DATABASE_URL is not configured');
  if (!isAuthConfigured(config)) return unavailable('Supabase Auth or APP_ORIGIN is not configured');
  if (!environment.RANKED_SEED_ENCRYPTION_KEY) return unavailable('RANKED_SEED_ENCRYPTION_KEY is not configured');

  let valueLookup;
  let seedEncryptionKey;
  let pool;
  try {
    valueLookup = loadRankedValueTable(environment.RANKED_VALUES_FILE || undefined);
    seedEncryptionKey = parseEncryptionKey(environment.RANKED_SEED_ENCRYPTION_KEY);
    pool = createPostgresPool({ connectionString: environment.DATABASE_URL });
  } catch (error) {
    logger.warn?.(`Ranked disabled: ${error.message}`);
    return unavailable('Ranked value table or persistence initialization failed');
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
  return { available: true, reason: null, service, auth, repository, pool };
}

function startRankedDeadlineSweeper(runtime, { intervalMs = 30_000, logger = console } = {}) {
  if (!runtime?.available) return null;
  const timer = setInterval(() => {
    runtime.service.expireDueGames().catch((error) => logger.warn?.(`Ranked deadline sweep failed: ${error.message}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { createRankedRuntime, startRankedDeadlineSweeper };
