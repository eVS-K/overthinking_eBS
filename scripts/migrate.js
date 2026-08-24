'use strict';

const fs = require('fs');
const path = require('path');
const { createPostgresPool, runSqlMigration } = require('../database');

async function main() {
  const pool = createPostgresPool();
  if (!pool) throw new Error('DATABASE_URL must be configured before running migrations');
  try {
    const migrationPath = path.join(__dirname, '..', 'migrations', '001_ranked.sql');
    await runSqlMigration(pool, fs.readFileSync(migrationPath, 'utf8'));
    console.log('Applied migrations/001_ranked.sql');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
