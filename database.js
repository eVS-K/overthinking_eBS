'use strict';

const DEFAULT_DATABASE_QUERY_TIMEOUT_MS = 8_000;

function readDatabaseSslConfig(value = process.env.DATABASE_SSL, nodeEnvironment = process.env.NODE_ENV) {
  if (value === 'disable' || value === 'false') return false;
  return nodeEnvironment === 'production' ? { rejectUnauthorized: true } : false;
}

function readDatabaseQueryTimeout(value = process.env.DATABASE_QUERY_TIMEOUT_MS) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 60_000
    ? parsed
    : DEFAULT_DATABASE_QUERY_TIMEOUT_MS;
}

function createPostgresPool({
  connectionString = process.env.DATABASE_URL,
  ssl = readDatabaseSslConfig(),
  queryTimeoutMs = readDatabaseQueryTimeout()
} = {}) {
  if (!connectionString) return null;
  // pg is deliberately loaded only when Ranked persistence is configured.
  // Guest PvP can therefore start while Ranked dependencies are unavailable.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    ssl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // `statement_timeout` is enforced by PostgreSQL and `query_timeout` is a
    // client-side backstop. Operators may temporarily raise this bounded
    // value for a reviewed migration, but request handlers must not wait
    // forever for an unavailable or overloaded database.
    statement_timeout: queryTimeoutMs,
    query_timeout: queryTimeoutMs,
    maxUses: 10_000
  });
}

async function runSqlMigration(pool, sql) {
  if (!pool) throw new Error('PostgreSQL is not configured');
  await pool.query(sql);
}

module.exports = {
  DEFAULT_DATABASE_QUERY_TIMEOUT_MS,
  createPostgresPool,
  readDatabaseQueryTimeout,
  readDatabaseSslConfig,
  runSqlMigration
};
