'use strict';

const { loadManifest } = require('./manifest');
const { createVerifiedBackup } = require('./backup');
const {
  inspectLegacyState,
  createLedger,
  adoptLegacyPrefix,
} = require('./legacy-adoption');
const { LocalMigrationError } = require('./errors');

const CODES = Object.freeze({
  manifest: 'LOCAL_MIGRATION_MANIFEST_INVALID',
  ahead: 'LOCAL_MIGRATION_AHEAD',
  drift: 'LOCAL_MIGRATION_DRIFT',
  ambiguous: 'LOCAL_MIGRATION_LEGACY_AMBIGUOUS',
  backup: 'LOCAL_MIGRATION_BACKUP_FAILED',
  upstream: 'LOCAL_MIGRATION_UPSTREAM_FAILED',
  mismatch: 'LOCAL_MIGRATION_UPSTREAM_MISMATCH',
  failed: 'LOCAL_MIGRATION_FAILED',
  verify: 'LOCAL_MIGRATION_VERIFY_FAILED',
  integrity: 'LOCAL_MIGRATION_INTEGRITY_FAILED',
});

function migrationError(code, message, details) {
  return new LocalMigrationError(code, message, details);
}

function validateInputs(database, upstream) {
  if (!database || typeof database.prepare !== 'function'
    || typeof database.transaction !== 'function'
    || typeof database.pragma !== 'function') {
    throw migrationError(CODES.manifest, 'invalid database handle', { phase: 'manifest' });
  }
  if (!upstream || !Number.isInteger(upstream.targetVersion)
    || upstream.targetVersion < 0 || typeof upstream.apply !== 'function') {
    throw migrationError(CODES.manifest, 'invalid upstream migration contract', {
      phase: 'manifest',
    });
  }
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest)) {
    throw migrationError(CODES.manifest, 'manifest must be an array', { phase: 'manifest' });
  }
  const ids = new Set();
  const checksums = new Set();
  for (let index = 0; index < manifest.length; index += 1) {
    const entry = manifest[index];
    const ordinal = index + 1;
    if (!entry || entry.ordinal !== ordinal
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id || '')
      || !/^[a-f0-9]{64}$/.test(entry.checksum || '')
      || typeof entry.apply !== 'function'
      || typeof entry.verify !== 'function'
      || ids.has(entry.id)
      || checksums.has(entry.checksum)) {
      throw migrationError(CODES.manifest, `invalid manifest entry at ordinal ${ordinal}`, {
        phase: 'manifest',
        migrationId: entry?.id,
      });
    }
    ids.add(entry.id);
    checksums.add(entry.checksum);
  }
}

function loadValidatedManifest() {
  let manifest;
  try {
    manifest = loadManifest();
  } catch (cause) {
    if (cause instanceof LocalMigrationError) throw cause;
    throw migrationError(CODES.manifest, 'failed to load local migration manifest', {
      phase: 'manifest',
      cause,
    });
  }
  validateManifest(manifest);
  return manifest;
}

function ledgerExists(database) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_schema
     WHERE type = 'table' AND name = 'gatherlocal_migrations'
  `).get());
}

function readAndValidateLedger(database, manifest) {
  let rows;
  try {
    rows = database.prepare(`
      SELECT ordinal, id, checksum, origin, applied_at
        FROM gatherlocal_migrations
       ORDER BY ordinal ASC
    `).all();
  } catch (cause) {
    throw migrationError(CODES.drift, 'local migration ledger schema is invalid', {
      phase: 'history',
      cause,
    });
  }

  if (rows.length > manifest.length) {
    throw migrationError(CODES.ahead, 'local migration history is newer than this app', {
      phase: 'history',
      migrationId: rows[manifest.length]?.id,
    });
  }

  const manifestIds = new Set(manifest.map((entry) => entry.id));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const entry = manifest[index];
    const expectedOrdinal = index + 1;
    if (row.ordinal !== expectedOrdinal || row.id !== entry.id) {
      if (!manifestIds.has(row.id)) {
        throw migrationError(CODES.ahead, 'local migration history contains an unknown migration', {
          phase: 'history',
          migrationId: row.id,
        });
      }
      throw migrationError(CODES.drift, 'local migration history is not an exact manifest prefix', {
        phase: 'history',
        migrationId: row.id,
      });
    }
    if (row.checksum !== entry.checksum) {
      throw migrationError(CODES.drift, `checksum drift for local migration ${entry.id}`, {
        phase: 'history',
        migrationId: entry.id,
      });
    }
    if (row.origin !== 'applied' && !/^legacy-user-version-(?:1[6-9]|2[0-2])$/.test(row.origin)) {
      throw migrationError(CODES.drift, `invalid origin for local migration ${entry.id}`, {
        phase: 'history',
        migrationId: entry.id,
      });
    }
    if (!Number.isInteger(row.applied_at) || row.applied_at < 0) {
      throw migrationError(CODES.drift, `invalid timestamp for local migration ${entry.id}`, {
        phase: 'history',
        migrationId: entry.id,
      });
    }
  }
  return rows;
}

function getUserVersion(database) {
  const value = database.pragma('user_version', { simple: true });
  return Number(value);
}

function createBackupOrThrow(database, force) {
  try {
    return createVerifiedBackup(database, { force });
  } catch (cause) {
    throw migrationError(CODES.backup, 'failed to create verified local migration backup', {
      phase: 'backup',
      cause,
      backupPath: cause?.backupPath,
    });
  }
}

function callUpstream(database, upstream, backupPath) {
  const from = getUserVersion(database);
  try {
    upstream.apply();
  } catch (cause) {
    throw migrationError(CODES.upstream, 'upstream migration failed', {
      phase: 'upstream',
      cause,
      backupPath,
    });
  }
  const to = getUserVersion(database);
  if (to !== upstream.targetVersion) {
    throw migrationError(
      CODES.mismatch,
      `upstream migration ended at user_version ${to}; expected ${upstream.targetVersion}`,
      { phase: 'upstream', backupPath },
    );
  }
  return { from, to };
}

function applyMigration(database, entry, backupPath) {
  let phase = 'apply';
  let verifyCause;
  try {
    const run = database.transaction(() => {
      entry.apply(database);
      phase = 'verify';
      let verified;
      try {
        verified = entry.verify(database);
      } catch (cause) {
        verifyCause = cause;
        throw cause;
      }
      if (verified !== true) {
        verifyCause = new Error(`postcondition returned ${String(verified)}`);
        throw verifyCause;
      }
      phase = 'ledger';
      database.prepare(`
        INSERT INTO gatherlocal_migrations
          (ordinal, id, checksum, origin, applied_at)
        VALUES (?, ?, ?, 'applied', ?)
      `).run(entry.ordinal, entry.id, entry.checksum, Date.now());
    });
    run();
  } catch (cause) {
    if (phase === 'verify') {
      throw migrationError(CODES.verify, `verification failed for local migration ${entry.id}`, {
        phase: 'verify',
        migrationId: entry.id,
        cause: verifyCause || cause,
        backupPath,
      });
    }
    throw migrationError(CODES.failed, `local migration ${entry.id} failed`, {
      phase,
      migrationId: entry.id,
      cause,
      backupPath,
    });
  }
}

function assertIntegrity(database, backupPath) {
  let rows;
  try {
    rows = database.prepare('PRAGMA quick_check').all();
  } catch (cause) {
    throw migrationError(CODES.integrity, 'local migration integrity check failed', {
      phase: 'integrity',
      cause,
      backupPath,
    });
  }
  if (rows.length !== 1 || rows[0].quick_check !== 'ok') {
    const details = rows.map((row) => row.quick_check).filter(Boolean).join('; ');
    throw migrationError(
      CODES.integrity,
      `local migration integrity check failed${details ? `: ${details}` : ''}`,
      { phase: 'integrity', backupPath },
    );
  }
}

function migrateWithLocalOverlay({ database, upstream } = {}) {
  validateInputs(database, upstream);
  const manifest = loadValidatedManifest();
  const initialUserVersion = getUserVersion(database);
  let ledgerRows = [];
  let backupPath = null;
  let adopted = [];

  if (ledgerExists(database)) {
    ledgerRows = readAndValidateLedger(database, manifest);
    if (initialUserVersion > upstream.targetVersion) {
      throw migrationError(CODES.ahead, 'upstream cursor is newer than this app', {
        phase: 'history',
      });
    }
  } else {
    let legacy;
    try {
      legacy = inspectLegacyState(
        database,
        manifest,
        initialUserVersion,
        upstream.targetVersion,
      );
    } catch (cause) {
      throw migrationError(CODES.ambiguous, 'failed to verify legacy GatherLocal state', {
        phase: 'legacy-adoption',
        cause,
      });
    }
    if (legacy.kind === 'ahead') {
      throw migrationError(CODES.ahead, legacy.reason, { phase: 'history' });
    }
    if (legacy.kind === 'ambiguous') {
      throw migrationError(CODES.ambiguous, legacy.reason, { phase: 'legacy-adoption' });
    }
    if (legacy.kind === 'legacy') {
      backupPath = createBackupOrThrow(database, true);
      try {
        adoptLegacyPrefix(database, legacy);
      } catch (cause) {
        throw migrationError(CODES.ambiguous, 'legacy GatherLocal adoption failed', {
          phase: 'legacy-adoption',
          cause,
          backupPath,
        });
      }
      adopted = legacy.verifiedEntries.map((entry) => entry.id);
      ledgerRows = readAndValidateLedger(database, manifest);
    }
  }

  if (initialUserVersion < upstream.targetVersion && backupPath === null) {
    backupPath = createBackupOrThrow(database, false);
  }
  const upstreamReport = callUpstream(database, upstream, backupPath);
  const pending = manifest.slice(ledgerRows.length);
  if (pending.length > 0 && backupPath === null) {
    backupPath = createBackupOrThrow(database, false);
  }
  if (pending.length > 0 && !ledgerExists(database)) {
    try {
      createLedger(database);
    } catch (cause) {
      throw migrationError(CODES.failed, 'failed to create local migration ledger', {
        phase: 'ledger',
        cause,
        backupPath,
      });
    }
  }

  const applied = [];
  for (const entry of pending) {
    applyMigration(database, entry, backupPath);
    applied.push(entry.id);
  }

  assertIntegrity(database, backupPath);
  return {
    upstream: upstreamReport,
    adopted,
    applied,
    backupPath,
  };
}

module.exports = { migrateWithLocalOverlay };
