'use strict';

// Node's built-in threshold flags aggregate every included file. Running a
// small, explicit check per security/game-critical module prevents a 100%
// utility from hiding a weakly tested state engine in the aggregate.
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COVERAGE_CHECKS = Object.freeze([
  { file: 'chat.js', tests: ['chat.test.js'], lines: 95, branches: 85, functions: 95 },
  { file: 'game-rules.js', tests: ['game-rules.test.js'], lines: 95, branches: 95, functions: 95 },
  { file: 'matchmaking.js', tests: ['matchmaking.test.js'], lines: 100, branches: 95, functions: 100 },
  { file: 'private-game-engine.js', tests: ['private-game-engine.test.js'], lines: 95, branches: 85, functions: 100 },
  // The state-engine tests intentionally exercise this validator through the
  // public game-state boundary, so include them instead of measuring only the
  // direct constructor calls in private-ruleset.test.js.
  { file: 'private-ruleset.js', tests: ['private-ruleset.test.js', 'private-game-engine.test.js'], lines: 96, branches: 90, functions: 100 },
  { file: 'ranked-engine.js', tests: ['ranked-engine.test.js'], lines: 98, branches: 90, functions: 100 },
  { file: 'ranked-rng.js', tests: ['ranked-rng.test.js'], lines: 98, branches: 90, functions: 100 },
  { file: 'rating.js', tests: ['rating.test.js'], lines: 98, branches: 95, functions: 100 }
]);

function runCoverageCheck(check) {
  const args = [
    '--test',
    '--experimental-test-coverage',
    `--test-coverage-lines=${check.lines}`,
    `--test-coverage-branches=${check.branches}`,
    `--test-coverage-functions=${check.functions}`,
    `--test-coverage-include=${check.file}`,
    ...check.tests
  ];
  console.log(`\nCoverage gate: ${check.file} (L${check.lines}/B${check.branches}/F${check.functions})`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function main() {
  for (const check of COVERAGE_CHECKS) {
    if (!runCoverageCheck(check)) {
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nPer-module coverage gates passed for ${COVERAGE_CHECKS.length} core modules.`);
}

if (require.main === module) main();

module.exports = { COVERAGE_CHECKS, runCoverageCheck };
