'use strict';

const LEGACY_UPSTREAM_BASE = 15;
const LEGACY_MIN_VERSION = 16;
const LEGACY_MAX_VERSION = 22;

const FOUNDATION_TABLES = Object.freeze([
  'smart_categories',
  'smart_category_aliases',
  'smart_category_members',
  'save_topic_profiles',
  'smart_category_runs',
]);

const KNOWN_LOCAL_TABLES = Object.freeze([
  ...FOUNDATION_TABLES,
  'semantic_index_generations',
  'semantic_index_state',
  'semantic_vectors',
  'semantic_index_jobs',
  'video_analysis_jobs',
  'video_tag_suggestions',
  'save_background_routes',
]);

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS gatherlocal_migrations (
    ordinal     INTEGER PRIMARY KEY CHECK (ordinal > 0),
    id          TEXT NOT NULL UNIQUE,
    checksum    TEXT NOT NULL,
    origin      TEXT NOT NULL,
    applied_at  INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS gatherlocal_migrations_no_update
  BEFORE UPDATE ON gatherlocal_migrations
  BEGIN
    SELECT RAISE(ABORT, 'gatherlocal migration history is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS gatherlocal_migrations_no_delete
  BEFORE DELETE ON gatherlocal_migrations
  BEGIN
    SELECT RAISE(ABORT, 'gatherlocal migration history is immutable');
  END;
`;

function tableNames(database) {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all().map((row) => row.name));
}

function inspectLegacyState(database, manifest, userVersion, upstreamTargetVersion) {
  const tables = tableNames(database);
  const anyLocalTable = KNOWN_LOCAL_TABLES.some((name) => tables.has(name));
  const hasFoundationTables = FOUNDATION_TABLES.every((name) => tables.has(name));
  const firstPostcondition = hasFoundationTables && manifest.length > 0
    ? manifest[0].verify(database) === true
    : false;

  if (!anyLocalTable) {
    if (userVersion > upstreamTargetVersion) {
      return { kind: 'ahead', reason: 'upstream cursor is newer than this app' };
    }
    return { kind: 'ordinary' };
  }

  if (!hasFoundationTables || !firstPostcondition) {
    return { kind: 'ambiguous', reason: 'partial or contradictory GatherLocal fingerprint' };
  }
  if (userVersion < LEGACY_MIN_VERSION || userVersion > LEGACY_MAX_VERSION) {
    return { kind: 'ambiguous', reason: 'GatherLocal fingerprint has unknown legacy cursor' };
  }

  const claimedCount = userVersion - LEGACY_UPSTREAM_BASE;
  if (claimedCount > manifest.length) {
    return { kind: 'ahead', reason: 'legacy history is newer than this manifest' };
  }

  const verifiedEntries = [];
  for (let index = 0; index < claimedCount; index += 1) {
    const entry = manifest[index];
    if (entry.verify(database) !== true) break;
    verifiedEntries.push(entry);
  }

  return {
    kind: 'legacy',
    originalUserVersion: userVersion,
    verifiedEntries,
  };
}

function createLedger(database) {
  database.exec(LEDGER_SQL);
}

function adoptLegacyPrefix(database, legacy) {
  const adopt = database.transaction(() => {
    createLedger(database);
    const insert = database.prepare(`
      INSERT INTO gatherlocal_migrations
        (ordinal, id, checksum, origin, applied_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const origin = `legacy-user-version-${legacy.originalUserVersion}`;
    for (const entry of legacy.verifiedEntries) {
      insert.run(entry.ordinal, entry.id, entry.checksum, origin, now);
    }
    database.pragma(`user_version = ${LEGACY_UPSTREAM_BASE}`);
  });
  adopt();
}

module.exports = {
  LEGACY_UPSTREAM_BASE,
  inspectLegacyState,
  createLedger,
  adoptLegacyPrefix,
};
