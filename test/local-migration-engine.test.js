'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const MODULE_DIR = path.join(
  __dirname,
  '..',
  'src',
  'main',
  'gatherlocal',
  'local-migrations',
);
const INDEX_PATH = path.join(MODULE_DIR, 'index.js');
const MANIFEST_PATH = path.join(MODULE_DIR, 'manifest.js');
const BACKUP_PATH = path.join(MODULE_DIR, 'backup.js');

const BASE_SCHEMA = `
  CREATE TABLE saves (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    thumb_path  TEXT NOT NULL,
    source_url  TEXT,
    tweet_meta  TEXT,
    source      TEXT NOT NULL DEFAULT 'x',
    deleted_at  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id TEXT,
    save_id TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, save_id)
  );
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
  CREATE TABLE save_tags (
    save_id TEXT,
    tag_id TEXT,
    PRIMARY KEY (save_id, tag_id)
  );
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE board_items (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE dismissed_tweets (
    tweet_key TEXT PRIMARY KEY,
    dismissed_at INTEGER NOT NULL
  );
`;

function makeDatabase(file = ':memory:') {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  database.exec(BASE_SCHEMA);
  return database;
}

function setVersion(database, version) {
  database.pragma(`user_version = ${version}`);
}

function version(database) {
  return database.pragma('user_version', { simple: true });
}

function upstream(database, targetVersion = 15, apply) {
  return {
    targetVersion,
    apply: apply || (() => setVersion(database, targetVersion)),
  };
}

function ledger(database) {
  return database.prepare(`
    SELECT ordinal, id, checksum, origin
      FROM gatherlocal_migrations
     ORDER BY ordinal
  `).all();
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name));
}

function loadEngineWith({ manifest, createVerifiedBackup } = {}) {
  const manifestModule = require(MANIFEST_PATH);
  const backupModule = require(BACKUP_PATH);
  const savedManifestExports = require.cache[require.resolve(MANIFEST_PATH)].exports;
  const savedBackupExports = require.cache[require.resolve(BACKUP_PATH)].exports;

  if (manifest) {
    require.cache[require.resolve(MANIFEST_PATH)].exports = {
      ...manifestModule,
      loadManifest: () => manifest,
    };
  }
  if (createVerifiedBackup) {
    require.cache[require.resolve(BACKUP_PATH)].exports = {
      ...backupModule,
      createVerifiedBackup,
    };
  }

  delete require.cache[require.resolve(INDEX_PATH)];
  const loaded = require(INDEX_PATH);
  require.cache[require.resolve(MANIFEST_PATH)].exports = savedManifestExports;
  require.cache[require.resolve(BACKUP_PATH)].exports = savedBackupExports;
  delete require.cache[require.resolve(INDEX_PATH)];
  return loaded.migrateWithLocalOverlay;
}

const migrateWithLocalOverlay = loadEngineWith();
const { loadManifest } = require(MANIFEST_PATH);

function withTempDatabase(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-migrations-'));
  const file = path.join(dir, 'library.db');
  const database = makeDatabase(file);
  try {
    return callback(database, file);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fresh upstream DB applies named history; second startup is no-op', () => {
  const database = makeDatabase();
  try {
    const first = migrateWithLocalOverlay({ database, upstream: upstream(database) });
    assert.equal(version(database), 15);
    assert.deepEqual(first.adopted, []);
    assert.deepEqual(first.applied, loadManifest().map((entry) => entry.id));
    assert.equal(first.backupPath, null);
    assert.equal(ledger(database).length, 7);

    let upstreamCalls = 0;
    const second = migrateWithLocalOverlay({
      database,
      upstream: upstream(database, 15, () => { upstreamCalls += 1; }),
    });
    assert.equal(upstreamCalls, 1);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.adopted, []);
    assert.equal(second.backupPath, null);
  } finally {
    database.close();
  }
});

test('implementation and verifier failures roll back domain work and ledger row', () => {
  const checksum = 'a'.repeat(64);
  const database = makeDatabase();
  setVersion(database, 15);
  try {
    const throwingManifest = [{
      ordinal: 1,
      id: 'rollback-probe',
      checksum,
      apply(db) {
        db.exec('CREATE TABLE rollback_probe (id INTEGER); INSERT INTO rollback_probe VALUES (1)');
        throw new Error('boom');
      },
      verify: () => true,
    }];
    const throwingEngine = loadEngineWith({ manifest: throwingManifest });
    assert.throws(
      () => throwingEngine({ database, upstream: upstream(database, 15, () => {}) }),
      (error) => error.code === 'LOCAL_MIGRATION_FAILED'
        && error.migrationId === 'rollback-probe',
    );
    assert.equal(tableExists(database, 'rollback_probe'), false);
    assert.equal(ledger(database).length, 0);

    const verifierManifest = [{
      ordinal: 1,
      id: 'rollback-probe',
      checksum,
      apply(db) {
        db.exec('CREATE TABLE rollback_probe (id INTEGER); INSERT INTO rollback_probe VALUES (1)');
      },
      verify: () => false,
    }];
    const verifierEngine = loadEngineWith({ manifest: verifierManifest });
    assert.throws(
      () => verifierEngine({ database, upstream: upstream(database, 15, () => {}) }),
      (error) => error.code === 'LOCAL_MIGRATION_VERIFY_FAILED'
        && error.migrationId === 'rollback-probe',
    );
    assert.equal(tableExists(database, 'rollback_probe'), false);
    assert.equal(ledger(database).length, 0);

    const retryManifest = [{
      ordinal: 1,
      id: 'rollback-probe',
      checksum,
      apply(db) { db.exec('CREATE TABLE rollback_probe (id INTEGER)'); },
      verify: (db) => tableExists(db, 'rollback_probe'),
    }];
    const retryEngine = loadEngineWith({ manifest: retryManifest });
    const report = retryEngine({ database, upstream: upstream(database, 15, () => {}) });
    assert.deepEqual(report.applied, ['rollback-probe']);
    assert.equal(ledger(database).length, 1);
  } finally {
    database.close();
  }
});

test('drift and ahead history fail before upstream writes', () => {
  for (const kind of ['drift', 'ahead']) {
    const database = makeDatabase();
    try {
      migrateWithLocalOverlay({ database, upstream: upstream(database) });
      database.exec(`
        DROP TRIGGER gatherlocal_migrations_no_update;
        DROP TRIGGER gatherlocal_migrations_no_delete;
      `);
      if (kind === 'drift') {
        database.prepare(`
          UPDATE gatherlocal_migrations SET checksum = ? WHERE ordinal = 1
        `).run('f'.repeat(64));
      } else {
        database.prepare(`
          UPDATE gatherlocal_migrations SET id = 'future-local-history' WHERE ordinal = 7
        `).run();
      }
      let upstreamCalled = false;
      const expected = kind === 'drift' ? 'LOCAL_MIGRATION_DRIFT' : 'LOCAL_MIGRATION_AHEAD';
      assert.throws(
        () => migrateWithLocalOverlay({
          database,
          upstream: upstream(database, 15, () => { upstreamCalled = true; }),
        }),
        (error) => error.code === expected,
      );
      assert.equal(upstreamCalled, false);
    } finally {
      database.close();
    }
  }
});

test('invalid manifest fails before upstream or database writes', () => {
  const database = makeDatabase();
  try {
    const checksum = 'b'.repeat(64);
    const invalidManifest = [
      { ordinal: 1, id: 'first', checksum, apply() {}, verify: () => true },
      { ordinal: 2, id: 'second', checksum, apply() {}, verify: () => true },
    ];
    const invalidEngine = loadEngineWith({ manifest: invalidManifest });
    let upstreamCalled = false;
    assert.throws(
      () => invalidEngine({
        database,
        upstream: upstream(database, 15, () => { upstreamCalled = true; }),
      }),
      (error) => error.code === 'LOCAL_MIGRATION_MANIFEST_INVALID',
    );
    assert.equal(upstreamCalled, false);
    assert.equal(version(database), 0);
    assert.equal(tableExists(database, 'gatherlocal_migrations'), false);
  } finally {
    database.close();
  }
});

test('upstream failure and cursor mismatch block local work', () => {
  for (const kind of ['failure', 'mismatch']) {
    const database = makeDatabase();
    try {
      const apply = kind === 'failure'
        ? () => { throw new Error('future upstream failed'); }
        : () => setVersion(database, 14);
      const expected = kind === 'failure'
        ? 'LOCAL_MIGRATION_UPSTREAM_FAILED'
        : 'LOCAL_MIGRATION_UPSTREAM_MISMATCH';
      assert.throws(
        () => migrateWithLocalOverlay({ database, upstream: upstream(database, 15, apply) }),
        (error) => error.code === expected,
      );
      assert.equal(tableExists(database, 'gatherlocal_migrations'), false);
      assert.equal(tableExists(database, 'smart_categories'), false);
    } finally {
      database.close();
    }
  }
});

test('legacy cursors 16 through 22 adopt exact verified prefix and apply suffix', () => {
  const manifest = loadManifest();
  for (let cursor = 16; cursor <= 22; cursor += 1) {
    const database = makeDatabase();
    try {
      const claimed = cursor - 15;
      for (const entry of manifest.slice(0, claimed)) entry.apply(database);
      setVersion(database, cursor);

      const report = migrateWithLocalOverlay({ database, upstream: upstream(database) });
      assert.deepEqual(report.adopted, manifest.slice(0, claimed).map((entry) => entry.id));
      assert.deepEqual(report.applied, manifest.slice(claimed).map((entry) => entry.id));
      assert.equal(version(database), 15);
      assert.equal(ledger(database).length, 7);
    } finally {
      database.close();
    }
  }
});

test('legacy repair restores base 15 before future upstream callback', () => {
  const database = makeDatabase();
  const manifest = loadManifest();
  try {
    for (const entry of manifest.slice(0, 6)) entry.apply(database);
    setVersion(database, 21);
    let observedVersion;
    const report = migrateWithLocalOverlay({
      database,
      upstream: upstream(database, 16, () => {
        observedVersion = version(database);
        database.exec('ALTER TABLE saves ADD COLUMN future_upstream TEXT');
        setVersion(database, 16);
      }),
    });
    assert.equal(observedVersion, 15);
    assert.deepEqual(report.upstream, { from: 15, to: 16 });
    assert.deepEqual(report.adopted, manifest.slice(0, 6).map((entry) => entry.id));
    assert.deepEqual(report.applied, ['social-source-key']);
    assert.equal(version(database), 16);
  } finally {
    database.close();
  }
});

test('pure future-upstream cursor without local fingerprint is ordinary', () => {
  const database = makeDatabase();
  try {
    setVersion(database, 16);
    let callbackCalls = 0;
    const report = migrateWithLocalOverlay({
      database,
      upstream: upstream(database, 16, () => { callbackCalls += 1; }),
    });
    assert.equal(callbackCalls, 1);
    assert.deepEqual(report.upstream, { from: 16, to: 16 });
    assert.deepEqual(report.adopted, []);
    assert.equal(report.applied.length, 7);
    assert.equal(version(database), 16);
  } finally {
    database.close();
  }
});

test('WAL-resident user row exists in verified local backup', () => {
  withTempDatabase((database) => {
    database.pragma('journal_mode = WAL');
    database.prepare(`
      INSERT INTO saves (id, file_path, thumb_path, source, created_at)
      VALUES ('wal-row', '/original', '/thumb', 'x', 1)
    `).run();

    const report = migrateWithLocalOverlay({ database, upstream: upstream(database) });
    assert.ok(report.backupPath);
    assert.match(path.basename(report.backupPath), /\.pre-local-migrate\.[^.]+\.bak$/);

    const backup = new Database(report.backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.prepare(`SELECT COUNT(*) AS n FROM saves WHERE id = 'wal-row'`).get().n, 1);
      assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      backup.close();
    }
  });
});

test('backup failure blocks all local mutation', () => {
  withTempDatabase((database) => {
    setVersion(database, 15);
    database.prepare(`
      INSERT INTO collections (id, name, color, created_at)
      VALUES ('collection-only', 'Only collection', '#000', 1)
    `).run();
    const failedBackupEngine = loadEngineWith({
      createVerifiedBackup() { throw new Error('forced backup failure'); },
    });

    assert.throws(
      () => failedBackupEngine({ database, upstream: upstream(database, 15, () => {}) }),
      (error) => error.code === 'LOCAL_MIGRATION_BACKUP_FAILED'
        && error.cause?.message === 'forced backup failure',
    );
    assert.equal(version(database), 15);
    assert.equal(tableExists(database, 'gatherlocal_migrations'), false);
    assert.equal(tableExists(database, 'smart_categories'), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 1);
  });
});

test('verified backup gates future upstream migrations', () => {
  withTempDatabase((database) => {
    setVersion(database, 15);
    database.prepare(`
      INSERT INTO collections (id, name, color, created_at)
      VALUES ('future-upstream', 'Future upstream', '#000', 1)
    `).run();
    migrateWithLocalOverlay({ database, upstream: upstream(database) });

    let backupCreated = false;
    const guardedEngine = loadEngineWith({
      createVerifiedBackup() {
        backupCreated = true;
        return '/verified/future-upstream.bak';
      },
    });
    const report = guardedEngine({
      database,
      upstream: upstream(database, 16, () => {
        assert.equal(backupCreated, true);
        setVersion(database, 16);
      }),
    });

    assert.equal(version(database), 16);
    assert.equal(report.backupPath, '/verified/future-upstream.bak');
    assert.deepEqual(report.applied, []);
  });

  withTempDatabase((database) => {
    setVersion(database, 15);
    database.prepare(`
      INSERT INTO collections (id, name, color, created_at)
      VALUES ('blocked-upstream', 'Blocked upstream', '#000', 1)
    `).run();
    migrateWithLocalOverlay({ database, upstream: upstream(database) });

    let upstreamCalled = false;
    const failedBackupEngine = loadEngineWith({
      createVerifiedBackup() {
        throw new Error('future backup failed');
      },
    });
    assert.throws(
      () => failedBackupEngine({
        database,
        upstream: upstream(database, 16, () => {
          upstreamCalled = true;
          setVersion(database, 16);
        }),
      }),
      error => error.code === 'LOCAL_MIGRATION_BACKUP_FAILED'
        && error.cause?.message === 'future backup failed',
    );
    assert.equal(upstreamCalled, false);
    assert.equal(version(database), 15);
  });
});

test('failed VACUUM removes partial backup while retaining attempted path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-backup-failure-'));
  const file = path.join(dir, 'library.db');
  fs.writeFileSync(file, 'live');
  const { createVerifiedBackup } = require(BACKUP_PATH);
  const fakeDatabase = {
    name: file,
    prepare(sql) {
      assert.equal(sql, 'VACUUM INTO ?');
      return {
        run(target) {
          fs.writeFileSync(target, 'partial');
          throw new Error('simulated disk failure');
        },
      };
    },
  };
  try {
    let attemptedPath;
    assert.throws(
      () => createVerifiedBackup(fakeDatabase, { force: true }),
      (error) => {
        attemptedPath = error.backupPath;
        return error.message === 'simulated disk failure' && Boolean(error.backupPath);
      },
    );
    assert.equal(fs.existsSync(attemptedPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger update and delete are rejected', () => {
  const database = makeDatabase();
  try {
    migrateWithLocalOverlay({ database, upstream: upstream(database) });
    assert.throws(
      () => database.prepare('UPDATE gatherlocal_migrations SET checksum = checksum').run(),
      /immutable/,
    );
    assert.throws(
      () => database.prepare('DELETE FROM gatherlocal_migrations WHERE ordinal = 7').run(),
      /immutable/,
    );
  } finally {
    database.close();
  }
});
