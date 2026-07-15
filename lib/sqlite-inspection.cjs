'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashJson(value) {
  return hash(JSON.stringify(value));
}

function normalize(value) {
  if (Buffer.isBuffer(value)) return { blob: value.toString('base64') };
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (Number.isNaN(value)) return { number: 'NaN' };
  if (value === Infinity) return { number: 'Infinity' };
  if (value === -Infinity) return { number: '-Infinity' };
  return value;
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQLite identifier: ${String(value)}`);
  }
  return `"${value}"`;
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .sort((a, b) => a.cid - b.cid)
    .map(column => column.name);
}

function tableDigest(database, table, selectedColumns) {
  const present = tableColumns(database, table);
  const columns = selectedColumns || present;
  for (const column of columns) {
    if (!present.includes(column)) throw new Error(`${table}.${column} is missing`);
  }
  const select = columns.map(quoteIdentifier).join(', ');
  const rows = database.prepare(`SELECT ${select} FROM ${quoteIdentifier(table)}`).all();
  const normalizedRows = rows.map(row => JSON.stringify(columns.map(column => normalize(row[column]))));
  normalizedRows.sort();
  return {
    columns,
    count: rows.length,
    sha256: hashJson({ columns, rows: normalizedRows }),
  };
}

function hashFile(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function mappedMedia(database, contract, userDataRoot, hashMedia) {
  const pathColumns = ['file_path', 'thumb_path', 'preview_path'];
  const rows = database.prepare(`
    SELECT id, deleted_at, file_path, thumb_path, preview_path
      FROM saves
     ORDER BY id
  `).all();
  const recordedRoot = path.resolve(contract.snapshot.recorded_user_data_root);
  const copiedRoot = fs.realpathSync(userDataRoot);
  const values = [];
  const files = [];
  let nonNull = 0;
  let activeNonNull = 0;

  for (const row of rows) {
    for (const column of pathColumns) {
      const value = row[column] ?? null;
      values.push([row.id, column, value]);
      if (value === null) continue;
      nonNull += 1;
      if (row.deleted_at === null) activeNonNull += 1;
      const relative = path.relative(recordedRoot, path.resolve(value));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`stored path escapes recorded user-data root: ${column}`);
      }
      const mapped = path.resolve(copiedRoot, relative);
      if (!mapped.startsWith(`${copiedRoot}${path.sep}`)) {
        throw new Error(`mapped path escapes copied user-data root: ${column}`);
      }
      const stat = fs.lstatSync(mapped);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`mapped media is not a regular file: ${relative}`);
      }
      const physical = fs.realpathSync(mapped);
      if (!physical.startsWith(`${copiedRoot}${path.sep}`)) {
        throw new Error(`mapped media escapes copied user-data root: ${column}`);
      }
      const item = [row.id, column, relative, stat.size];
      if (hashMedia) item.push(hashFile(physical));
      files.push(item);
    }
  }

  return {
    cell_count: values.length,
    non_null_count: nonNull,
    active_non_null_count: activeNonNull,
    values_sha256: hashJson(values),
    mapped_file_count: files.length,
    media_sha256: hashMedia ? hashJson(files) : null,
  };
}

function sourceKeyStats(database) {
  if (!tableColumns(database, 'saves').includes('source_key')) return null;
  const rows = database.prepare(`
    SELECT id, source_url, source_key
      FROM saves
     WHERE deleted_at IS NULL
       AND source_url IS NOT NULL
       AND tweet_meta IS NOT NULL
     ORDER BY created_at ASC, id ASC
  `).all();
  const keyFor = url => {
    if (typeof url !== 'string') return null;
    const tweet = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
    if (tweet) return `tw:${tweet[1]}`;
    const instagram = url.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
    return instagram ? `ig:${instagram[1]}` : null;
  };
  const eligible = rows.filter(row => keyFor(row.source_url));
  const claims = eligible.filter(row => row.source_key !== null);
  const counts = new Map();
  for (const row of claims) counts.set(row.source_key, (counts.get(row.source_key) || 0) + 1);
  return {
    eligible_rows: eligible.length,
    active_claims: claims.length,
    eligible_nulls: eligible.length - claims.length,
    duplicate_claims: [...counts.values()].filter(count => count > 1).length,
    claims_sha256: hashJson(claims.map(row => [row.id, row.source_key])),
  };
}

function inspectOpenDatabase(database, contract, userDataRoot, { hashMedia = false } = {}) {
  const quickCheck = database.prepare('PRAGMA quick_check').all().map(row => row.quick_check);
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
  const schemaRows = database.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_schema
     ORDER BY type, name
  `).all().map(row => [row.type, row.name, row.tbl_name, row.sql]);
  const protectedTables = {};
  for (const table of contract.before.protected_tables) {
    protectedTables[table] = tableDigest(database, table);
  }
  const saves = tableDigest(database, 'saves', contract.before.protected_save_columns);
  const counts = database.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active
      FROM saves
  `).get();
  const ledgerExists = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_schema
     WHERE type = 'table' AND name = 'gatherlocal_migrations'
  `).get());
  const ledger = ledgerExists
    ? database.prepare(`
        SELECT ordinal, id, checksum, origin, applied_at
          FROM gatherlocal_migrations
         ORDER BY ordinal
      `).all()
    : [];

  return {
    quick_check: quickCheck,
    foreign_key_error_count: foreignKeyErrors.length,
    user_version: Number(database.pragma('user_version', { simple: true })),
    schema_version: Number(database.pragma('schema_version', { simple: true })),
    schema_sha256: hashJson(schemaRows),
    save_count: counts.total,
    active_save_count: counts.active,
    protected_saves: saves,
    protected_tables: protectedTables,
    paths: mappedMedia(database, contract, userDataRoot, hashMedia),
    ledger,
    source_keys: sourceKeyStats(database),
  };
}

module.exports = {
  hashFile,
  hashJson,
  inspectOpenDatabase,
  tableDigest,
};
