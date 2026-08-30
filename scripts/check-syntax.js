'use strict';

// A dependency-free parse check for every maintained JavaScript file.  It is
// deliberately separate from the test runner, so a malformed file that is not
// currently imported by a unit test is still caught before deployment.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage']);

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return IGNORED_DIRECTORIES.has(entry.name) ? [] : listJavaScriptFiles(target);
      }
      return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
    });
}

function main() {
  const files = listJavaScriptFiles(ROOT);
  let failed = false;
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    if (result.status === 0) continue;
    failed = true;
    process.stderr.write(`\nSyntax check failed: ${path.relative(ROOT, file)}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (failed) process.exitCode = 1;
  else console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}

if (require.main === module) main();

module.exports = { listJavaScriptFiles };
