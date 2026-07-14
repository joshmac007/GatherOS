const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadBackupModule(root, databasePath) {
  const backupPath = require.resolve('../src/main/backup');
  const registryPath = require.resolve('../src/main/library-registry');
  const dbPath = require.resolve('../src/main/db');

  require.cache[registryPath] = {
    id: registryPath,
    filename: registryPath,
    loaded: true,
    exports: { getActiveLibraryRoot: () => root },
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { getDatabasePath: () => databasePath },
  };
  delete require.cache[backupPath];
  return {
    backup: require(backupPath),
    cleanup() {
      delete require.cache[backupPath];
      delete require.cache[registryPath];
      delete require.cache[dbPath];
    },
  };
}

test('backup discovery distinguishes upstream versions from named local migrations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-backup-list-'));
  const databasePath = path.join(root, 'moodmark.db');
  const upstreamBackup = `${databasePath}.pre-v16.2026-07-14.bak`;
  const localBackup = `${databasePath}.pre-local-migrate.2026-07-14-abcdef.bak`;
  const ignored = `${databasePath}.pre-something-else.bak`;
  fs.writeFileSync(upstreamBackup, 'upstream');
  fs.writeFileSync(localBackup, 'local');
  fs.writeFileSync(ignored, 'ignored');

  const loaded = loadBackupModule(root, databasePath);
  try {
    const migrations = loaded.backup.listSnapshots()
      .filter((entry) => entry.kind !== 'snapshot');
    assert.equal(migrations.length, 2);
    assert.deepEqual(
      migrations.map((entry) => ({
        name: path.basename(entry.path),
        kind: entry.kind,
        migrationToVersion: entry.migrationToVersion,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      [
        {
          name: path.basename(localBackup),
          kind: 'local-migration',
          migrationToVersion: undefined,
        },
        {
          name: path.basename(upstreamBackup),
          kind: 'migration',
          migrationToVersion: 16,
        },
      ],
    );
  } finally {
    loaded.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
