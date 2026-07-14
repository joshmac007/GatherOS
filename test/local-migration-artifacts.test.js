const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  loadManifest,
  checksumArtifact,
} = require('../src/main/gatherlocal/local-migrations/manifest');

const EXPECTED_IDS = Object.freeze([
  'smart-categories-foundation',
  'smart-category-run-metadata',
  'semantic-video-domain',
  'semantic-video-queue-compatibility',
  'save-background-routing',
  'x-tweet-created-at-repair',
  'social-source-key',
]);

const UPSTREAM_SCHEMA = `
CREATE TABLE saves (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  thumb_path  TEXT NOT NULL,
  title       TEXT,
  source_url  TEXT,
  source      TEXT NOT NULL DEFAULT 'x',
  tweet_meta  TEXT,
  deleted_at  INTEGER,
  created_at  INTEGER NOT NULL
);
PRAGMA user_version = 15;
`;

function freshUpstreamDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(UPSTREAM_SCHEMA);
  return database;
}

function artifactPath(ordinal, id) {
  return path.join(
    __dirname,
    '..',
    'src',
    'main',
    'gatherlocal',
    'local-migrations',
    'migrations',
    `${String(ordinal).padStart(3, '0')}-${id}.js`,
  );
}

test('manifest is one frozen, unique, byte-checksummed linear history', () => {
  const manifest = loadManifest();
  assert.equal(Object.isFrozen(manifest), true);
  assert.deepEqual(manifest.map((entry) => entry.ordinal), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(manifest.map((entry) => entry.id), EXPECTED_IDS);
  assert.equal(new Set(manifest.map((entry) => entry.id)).size, manifest.length);

  for (const entry of manifest) {
    assert.equal(Object.isFrozen(entry), true);
    const file = artifactPath(entry.ordinal, entry.id);
    const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(entry.checksum, expected);
    assert.equal(entry.checksum, checksumArtifact(file));
    assert.match(entry.checksum, /^[a-f0-9]{64}$/);
  }
});

test('checksum helper changes when one artifact byte changes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-artifact-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = artifactPath(1, EXPECTED_IDS[0]);
  const copy = path.join(directory, 'artifact.js');
  fs.copyFileSync(source, copy);
  const before = checksumArtifact(copy);
  fs.appendFileSync(copy, ' ');
  assert.notEqual(checksumArtifact(copy), before);
});

test('fresh upstream schema reaches all seven postconditions idempotently', (t) => {
  const database = freshUpstreamDatabase();
  t.after(() => database.close());

  const tweetId = '1800000000000000000';
  database.prepare(`
    INSERT INTO saves
      (id, file_path, thumb_path, source_url, source, tweet_meta, deleted_at, created_at)
    VALUES
      ('old', '/old', '/old-thumb', ?, 'x', '{}', NULL, 10),
      ('new', '/new', '/new-thumb', ?, 'x', '{}', NULL, 20)
  `).run(`https://x.com/user/status/${tweetId}`, `https://twitter.com/user/status/${tweetId}`);

  const manifest = loadManifest();
  for (const entry of manifest) {
    entry.apply(database);
    assert.equal(entry.verify(database), true, entry.id);
    entry.apply(database);
    assert.equal(entry.verify(database), true, `${entry.id} after second apply`);
  }

  assert.equal(database.pragma('user_version', { simple: true }), 15);
  assert.equal(
    database.prepare('SELECT source_key FROM saves WHERE id = ?').get('old').source_key,
    `tw:${tweetId}`,
  );
  assert.equal(database.prepare('SELECT source_key FROM saves WHERE id = ?').get('new').source_key, null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM saves').get().count, 2);
  assert.ok(JSON.parse(database.prepare('SELECT tweet_meta FROM saves WHERE id = ?').get('old').tweet_meta).tweetCreatedAt > 0);
});

test('preserved version-21 shape proves exactly first six artifacts', (t) => {
  const database = freshUpstreamDatabase();
  t.after(() => database.close());
  const manifest = loadManifest();

  for (const entry of manifest.slice(0, 6)) entry.apply(database);
  database.pragma('user_version = 21');

  assert.deepEqual(manifest.map((entry) => entry.verify(database)), [
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  assert.equal(
    database.prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name = 'source_key'").get(),
    undefined,
  );
});

test('partial lookalike schemas do not satisfy adoption fingerprints', (t) => {
  const database = freshUpstreamDatabase();
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE smart_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE semantic_index_generations (id TEXT PRIMARY KEY, status TEXT);
  `);
  const manifest = loadManifest();
  assert.equal(manifest[0].verify(database), false);
  assert.equal(manifest[2].verify(database), false);
});

test('social source key keeps duplicate saves and assigns oldest active canonical', (t) => {
  const database = freshUpstreamDatabase();
  t.after(() => database.close());
  const migration = loadManifest()[6];
  database.prepare(`
    INSERT INTO saves
      (id, file_path, thumb_path, source_url, source, tweet_meta, deleted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('deleted', '/d', '/dt', 'https://x.com/u/status/99', 'x', '{}', 1, 1);
  database.prepare(`
    INSERT INTO saves
      (id, file_path, thumb_path, source_url, source, tweet_meta, deleted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('oldest', '/o', '/ot', 'https://x.com/u/status/99', 'x', '{}', null, 2);
  database.prepare(`
    INSERT INTO saves
      (id, file_path, thumb_path, source_url, source, tweet_meta, deleted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('duplicate', '/n', '/nt', 'https://twitter.com/u/status/99', 'x', '{}', null, 3);

  migration.apply(database);

  assert.equal(migration.verify(database), true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM saves').get().count, 3);
  assert.equal(database.prepare('SELECT source_key FROM saves WHERE id = ?').get('deleted').source_key, null);
  assert.equal(database.prepare('SELECT source_key FROM saves WHERE id = ?').get('oldest').source_key, 'tw:99');
  assert.equal(database.prepare('SELECT source_key FROM saves WHERE id = ?').get('duplicate').source_key, null);
});
