'use strict';

const fs = require('fs');
const path = require('path');
const { RANKED_VALUES_FILE, createSignedRankedValueTable, validateRankedValueTable } = require('../ranked-values');

const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : RANKED_VALUES_FILE;
const table = createSignedRankedValueTable();
validateRankedValueTable(table);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(table)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`Generated ${outputPath} (${table.metadata.stateCount} states, ${table.metadata.checksum})`);
