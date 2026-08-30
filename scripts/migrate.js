'use strict';

const fs = require('fs');
const path = require('path');
const { createPostgresPool, runSqlMigration } = require('../database');

function listMigrationFiles(migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(file))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10) || left.localeCompare(right));
}

async function applyMigrations(pool, migrationsDir = path.join(__dirname, '..', 'migrations')) {
  if (!pool) throw new Error('DATABASE_URL must be configured before running migrations');
  const client = await pool.connect();
  try {
    // Migrations 001 and 002 intentionally agree on `public`.  Do not rely on
    // a host-specific default search_path here: an application role with a
    // nonstandard path could otherwise create the tracking table outside the
    // schema that the hardening migration later protects.
    await client.query('SET search_path TO public');
    await client.query(`CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('SELECT pg_advisory_lock($1)', [741_902_318]);
    const applied = new Set((await client.query('SELECT id FROM public.app_schema_migrations')).rows.map((row) => row.id));
    for (const file of listMigrationFiles(migrationsDir)) {
      if (applied.has(file)) continue;
      await client.query('BEGIN');
      try {
        await runSqlMigration(client, fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
        await client.query('INSERT INTO public.app_schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
      console.log(`Applied migrations/${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [741_902_318]).catch(() => {});
    client.release();
  }
}

async function main() {
  const pool = createPostgresPool();
  try {
    await applyMigrations(pool);
  } finally {
    await pool?.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { applyMigrations, listMigrationFiles };
