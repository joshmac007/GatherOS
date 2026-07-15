#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { inspectOpenDatabase } = require('../lib/sqlite-inspection.cjs');

const options = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--hash-media') {
    options.hashMedia = true;
    continue;
  }
  const value = process.argv[index + 1];
  if (!['--app-source', '--database', '--contract', '--user-data', '--output'].includes(flag) || !value) {
    throw new Error('invalid inspection arguments');
  }
  options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  index += 1;
}

for (const name of ['appSource', 'database', 'contract', 'userData', 'output']) {
  if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`);
}

const appSource = fs.realpathSync(options.appSource);
const appRequire = createRequire(path.join(appSource, 'package.json'));
const Database = appRequire('better-sqlite3');
const contract = JSON.parse(fs.readFileSync(options.contract, 'utf8'));
const database = new Database(options.database, { readonly: true, fileMustExist: true });
try {
  const inspection = inspectOpenDatabase(
    database,
    contract,
    options.userData,
    { hashMedia: options.hashMedia === true },
  );
  fs.writeFileSync(options.output, `${JSON.stringify(inspection, null, 2)}\n`);
} finally {
  database.close();
}
