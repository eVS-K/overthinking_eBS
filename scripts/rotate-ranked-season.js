'use strict';

const { createPostgresPool } = require('../database');
const { PostgresRankedRepository } = require('../ranked-repository');
const { buildCurrentSeasonSpec } = require('../ranked-service');
const { loadRankedValueTable } = require('../ranked-values');

async function main() {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Refusing to rotate a Ranked season without --confirm');
  }
  const pool = createPostgresPool();
  if (!pool) throw new Error('DATABASE_URL must be configured before rotating a season');
  try {
    const repository = new PostgresRankedRepository(pool);
    const lookup = loadRankedValueTable(process.env.RANKED_VALUES_FILE || undefined);
    const season = await repository.transaction(async (tx) => {
      await tx.lockSeason();
      const activeGames = await tx.countActiveGames();
      if (activeGames > 0) {
        throw new Error(`Refusing to rotate while ${activeGames} Ranked game(s) are active; let them finish or forfeit first.`);
      }
      const active = await tx.getActiveSeason({ forUpdate: true });
      if (active) await tx.closeActiveSeason(new Date());
      return tx.createSeason(buildCurrentSeasonSpec(lookup));
    });
    console.log(`Opened Ranked season ${season.id} with value table ${season.valueTableChecksum}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
