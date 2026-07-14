'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const USER_DATA_TABLES = Object.freeze([
  'saves',
  'collections',
  'collection_items',
  'tags',
  'save_tags',
  'boards',
  'board_items',
  'dismissed_tweets',
  'smart_categories',
  'smart_category_aliases',
  'smart_category_members',
  'save_topic_profiles',
  'smart_category_runs',
  'semantic_index_generations',
  'semantic_vectors',
  'semantic_index_jobs',
  'video_analysis_jobs',
  'video_tag_suggestions',
  'save_background_routes',
]);

function databaseFile(database) {
  const name = typeof database?.name === 'string' ? database.name : '';
  if (!name || name === ':memory:' || name.startsWith('file::memory:')) return null;
  return path.resolve(name);
}

function hasUserRows(database) {
  const present = new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all().map((row) => row.name));

  for (const table of USER_DATA_TABLES) {
    if (!present.has(table)) continue;
    const quoted = `"${table.replace(/"/g, '""')}"`;
    if (database.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get()) return true;
  }
  return false;
}

function uniqueBackupPath(file) {
  for (;;) {
    const suffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const candidate = `${file}.pre-local-migrate.${suffix}.bak`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function assertBackupIntegrity(file) {
  let backup;
  try {
    backup = new Database(file, { readonly: true, fileMustExist: true });
    const rows = backup.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0].quick_check !== 'ok') {
      const details = rows.map((row) => row.quick_check).filter(Boolean).join('; ');
      throw new Error(`backup quick_check failed${details ? `: ${details}` : ''}`);
    }
  } finally {
    if (backup) backup.close();
  }
}

function createVerifiedBackup(database, { force = false } = {}) {
  const file = databaseFile(database);
  if (!file) return null;
  if (!force && !hasUserRows(database)) return null;

  const backupPath = uniqueBackupPath(file);
  try {
    database.prepare('VACUUM INTO ?').run(backupPath);
    assertBackupIntegrity(backupPath);
    return backupPath;
  } catch (error) {
    try { fs.unlinkSync(backupPath); } catch {}
    error.backupPath = backupPath;
    throw error;
  }
}

module.exports = {
  createVerifiedBackup,
  hasUserRows,
};
