'use strict';

function readDatabaseSslConfig(value = process.env.DATABASE_SSL) {
  if (value === 'disable' || value === 'false') return false;
  return process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false;
}

function createPostgresPool({ connectionString = process.env.DATABASE_URL, ssl = readDatabaseSslConfig() } = {}) {
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
    maxUses: 10_000
  });
}

async function runSqlMigration(pool, sql) {
  if (!pool) throw new Error('PostgreSQL is not configured');
  await pool.query(sql);
}

module.exports = { createPostgresPool, readDatabaseSslConfig, runSqlMigration };
