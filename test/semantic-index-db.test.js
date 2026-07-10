const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function loadDb(userData) {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        getPath(name) {
          if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
          return userData;
        },
      },
    },
  };

  for (const mod of ['../src/main/db.js', '../src/main/library-registry.js']) {
    delete require.cache[require.resolve(mod)];
  }
  return require('../src/main/db.js');
}

function withTempDb(fn) {
  return async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-semantic-db-'));
    const db = loadDb(userData);
    try {
      db.initDatabase();
      await fn(db, userData);
    } finally {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

function sqlitePath(userData) {
  return path.join(userData, 'libraries', 'library_default', 'moodmark.db');
}

function insertSave(db, id) {
  return db.insertSave({
    id,
    filePath: `/tmp/${id}.png`,
    thumbPath: `/tmp/${id}-thumb.png`,
    title: id,
    createdAt: 1,
  });
}

function floatBuffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

const DOMAIN_TABLES = [
  'semantic_index_state',
  'semantic_index_generations',
  'semantic_vectors',
  'semantic_index_jobs',
  'video_analysis_jobs',
  'video_tag_suggestions',
];

test('fresh schema and one upgrade migration create all domain tables', withTempDb((db, userData) => {
  const database = db.getDatabase();
  const targetVersion = database.pragma('user_version', { simple: true });
  const freshNames = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map((row) => row.name);
  for (const name of DOMAIN_TABLES) assert.ok(freshNames.includes(name), name);

  db.closeDatabase();
  const raw = new Database(sqlitePath(userData));
  raw.pragma('foreign_keys = OFF');
  for (const name of [...DOMAIN_TABLES].reverse()) raw.exec(`DROP TABLE ${name}`);
  raw.pragma(`user_version = ${targetVersion - 1}`);
  raw.close();

  db.initDatabase();
  const upgradedNames = db.getDatabase().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map((row) => row.name);
  for (const name of DOMAIN_TABLES) assert.ok(upgradedNames.includes(name), name);
  assert.equal(db.getDatabase().pragma('user_version', { simple: true }), targetVersion);
}));

test('jobs coalesce to latest source identity while active vectors stay generation-scoped', withTempDb((db) => {
  insertSave(db, 'save-1');
  const active = db.createSemanticGeneration({
    id: 'gen-active',
    model: 'embeddinggemma',
    sourceVersion: 1,
    status: 'active',
    createdAt: 10,
  });
  db.enqueueSemanticIndexJob({
    generationId: active.id,
    saveId: 'save-1',
    kind: 'incremental',
    sourceHash: 'hash-old',
    now: 20,
  });
  const activeJob = db.claimSemanticIndexJob('incremental', 30);
  assert.equal(activeJob.source_hash, 'hash-old');
  db.completeSemanticIndexJob({
    id: activeJob.id,
    sourceHash: 'hash-old',
    model: 'embeddinggemma',
    dimension: 3,
    vector: floatBuffer([1, 2, 3]),
    now: 40,
  });

  const building = db.createSemanticGeneration({
    id: 'gen-building',
    model: 'nomic-embed-text',
    sourceVersion: 2,
    status: 'building',
    createdAt: 50,
  });
  db.enqueueSemanticIndexJob({
    generationId: building.id,
    saveId: 'save-1',
    kind: 'rebuild',
    sourceHash: 'hash-1',
    now: 60,
  });
  const staleClaim = db.claimSemanticIndexJob('rebuild', 65);
  db.enqueueSemanticIndexJob({
    generationId: building.id,
    saveId: 'save-1',
    kind: 'rebuild',
    sourceHash: 'hash-2',
    now: 70,
  });

  const queued = db.listSemanticIndexJobs({ generationId: building.id });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].source_hash, 'hash-2');
  assert.equal(queued[0].state, 'pending');
  assert.equal(db.completeSemanticIndexJob({
    id: staleClaim.id,
    sourceHash: 'hash-1',
    model: 'nomic-embed-text',
    dimension: 3,
    vector: floatBuffer([9, 9, 9]),
    now: 75,
  }).reason, 'stale');
  assert.equal(db.getSemanticIndexStatus().waiting, 1);
  assert.deepEqual(db.getSemanticIndexState(), {
    active_generation_id: active.id,
    building_generation_id: building.id,
    paused: false,
    pause_reason: null,
    paused_at: null,
    updated_at: 50,
  });

  const activeVector = db.getSemanticVector('save-1');
  assert.equal(activeVector.generation_id, active.id);
  assert.equal(activeVector.model, 'embeddinggemma');
  assert.equal(activeVector.dimension, 3);
  assert.equal(activeVector.source_hash, 'hash-old');
  assert.deepEqual(activeVector.vector, floatBuffer([1, 2, 3]));

  db.enqueueSemanticIndexJob({
    generationId: active.id,
    saveId: 'save-1',
    kind: 'incremental',
    sourceHash: 'hash-wrong-dimension',
    now: 80,
  });
  const incompatible = db.claimSemanticIndexJob('incremental', 90);
  assert.equal(db.completeSemanticIndexJob({
    id: incompatible.id,
    sourceHash: 'hash-wrong-dimension',
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([4, 5]),
    now: 100,
  }).reason, 'dimension_mismatch');
  assert.equal(db.getSemanticVector('save-1').source_hash, 'hash-old');
}));

test('rejects wrong-length and non-finite semantic vector payloads', withTempDb((db) => {
  insertSave(db, 'save-invalid-vector');
  const generation = db.createSemanticGeneration({
    id: 'gen-invalid-vector',
    model: 'embeddinggemma',
    sourceVersion: 1,
    status: 'active',
    createdAt: 10,
  });
  db.enqueueSemanticIndexJob({
    generationId: generation.id,
    saveId: 'save-invalid-vector',
    kind: 'incremental',
    sourceHash: 'bad-length',
    now: 20,
  });
  let job = db.claimSemanticIndexJob('incremental', 30);
  assert.equal(db.completeSemanticIndexJob({
    id: job.id,
    sourceHash: 'bad-length',
    model: 'embeddinggemma',
    dimension: 2,
    vector: Buffer.alloc(4),
    now: 40,
  }).reason, 'invalid_vector_payload');
  assert.equal(db.getSemanticVector('save-invalid-vector'), undefined);

  db.enqueueSemanticIndexJob({
    generationId: generation.id,
    saveId: 'save-invalid-vector',
    kind: 'incremental',
    sourceHash: 'non-finite',
    now: 50,
  });
  job = db.claimSemanticIndexJob('incremental', 60);
  assert.equal(db.completeSemanticIndexJob({
    id: job.id,
    sourceHash: 'non-finite',
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([1, Number.NaN]),
    now: 70,
  }).reason, 'invalid_vector_payload');
  assert.equal(db.getSemanticVector('save-invalid-vector'), undefined);
}));

test('pause, retry, dismiss, and crash recovery are durable queue operations', withTempDb((db) => {
  insertSave(db, 'save-a');
  insertSave(db, 'save-b');
  const generation = db.createSemanticGeneration({
    id: 'gen-a', model: 'embeddinggemma', sourceVersion: 1, status: 'active', createdAt: 10,
  });
  for (const [saveId, sourceHash] of [['save-a', 'hash-a'], ['save-b', 'hash-b']]) {
    db.enqueueSemanticIndexJob({
      generationId: generation.id, saveId, kind: 'incremental', sourceHash, now: 20,
    });
  }

  db.pauseSemanticIndex({ reason: 'ollama unavailable', now: 30 });
  assert.equal(db.claimSemanticIndexJob('incremental', 40), undefined);
  assert.equal(db.getSemanticIndexStatus().paused, true);

  db.resumeSemanticIndex(50);
  const first = db.claimSemanticIndexJob('incremental', 60);
  db.failSemanticIndexJob({ id: first.id, error: 'model missing', retryAt: 500, now: 70 });
  assert.equal(db.getSemanticIndexStatus().failed, 1);
  assert.equal(db.listSemanticIndexJobs({ state: 'failed' })[0].retry_count, 1);

  db.retrySemanticFailures([first.id], 80);
  assert.equal(db.listSemanticIndexJobs().find((job) => job.id === first.id).retry_count, 1);
  const running = [
    db.claimSemanticIndexJob('incremental', 90),
    db.claimSemanticIndexJob('incremental', 90),
  ];
  assert.equal(running.some((job) => job.id === first.id && job.retry_count === 1), true);

  const recovered = db.recoverBackgroundJobs(100);
  assert.equal(recovered.semantic, 2);
  assert.equal(db.listSemanticIndexJobs({ state: 'pending' }).length, 2);

  const recoveredJob = db.claimSemanticIndexJob('incremental', 110);
  db.failSemanticIndexJob({ id: recoveredJob.id, error: 'bad vector', now: 120 });
  db.dismissSemanticFailures([recoveredJob.id], 130);
  const dismissed = db.listSemanticIndexJobs({ state: 'dismissed' });
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].error, 'bad vector');
  assert.equal(dismissed[0].finished_at, 130);
}));

test('retryable semantic failures become claimable after durable backoff', withTempDb((db) => {
  insertSave(db, 'save-transient');
  const generation = db.createSemanticGeneration({
    id: 'gen-transient', model: 'embeddinggemma', sourceVersion: 1, status: 'active', createdAt: 10,
  });
  db.enqueueSemanticIndexJob({
    generationId: generation.id,
    saveId: 'save-transient',
    kind: 'incremental',
    sourceHash: 'hash-transient',
    now: 20,
  });
  const first = db.claimSemanticIndexJob('incremental', 30);
  db.failSemanticIndexJob({
    id: first.id,
    error: 'ollama unavailable',
    retryable: true,
    retryAt: 100,
    now: 40,
  });

  const waiting = db.listSemanticIndexJobs()[0];
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.retryable, 1);
  assert.equal(waiting.retry_count, 1);
  assert.equal(waiting.error, 'ollama unavailable');
  assert.equal(db.claimSemanticIndexJob('incremental', 99), undefined);
  const retry = db.claimSemanticIndexJob('incremental', 100);
  assert.equal(retry.id, first.id);
  assert.equal(retry.retry_count, 1);
}));

test('successful building generation activates atomically and cancellation keeps old active data', withTempDb((db) => {
  insertSave(db, 'save-1');
  const oldGeneration = db.createSemanticGeneration({
    id: 'gen-old', model: 'embeddinggemma', sourceVersion: 1, status: 'active', createdAt: 10,
  });
  db.enqueueSemanticIndexJob({
    generationId: oldGeneration.id,
    saveId: 'save-1',
    kind: 'incremental',
    sourceHash: 'old-hash',
    now: 20,
  });
  const oldJob = db.claimSemanticIndexJob('incremental', 30);
  db.completeSemanticIndexJob({
    id: oldJob.id,
    sourceHash: 'old-hash',
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([1, 1]),
    now: 40,
  });

  const cancelled = db.createSemanticGeneration({
    id: 'gen-cancelled', model: 'embeddinggemma', sourceVersion: 2, status: 'building', createdAt: 50,
  });
  db.enqueueSemanticIndexJob({
    generationId: cancelled.id,
    saveId: 'save-1',
    kind: 'rebuild',
    sourceHash: 'cancel-hash',
    now: 60,
  });
  const partial = db.claimSemanticIndexJob('rebuild', 70);
  db.completeSemanticIndexJob({
    id: partial.id,
    sourceHash: 'cancel-hash',
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([2, 2]),
    now: 80,
    activate: false,
  });
  db.cancelSemanticGeneration(cancelled.id, 90);

  assert.equal(db.getSemanticIndexState().active_generation_id, oldGeneration.id);
  assert.equal(db.getSemanticIndexState().building_generation_id, null);
  assert.equal(db.getSemanticVector('save-1').source_hash, 'old-hash');
  assert.equal(db.getDatabase().prepare(
    'SELECT COUNT(*) AS n FROM semantic_vectors WHERE generation_id = ?',
  ).get(cancelled.id).n, 0);

  const replacement = db.createSemanticGeneration({
    id: 'gen-new', model: 'embeddinggemma', sourceVersion: 2, status: 'building', createdAt: 100,
  });
  db.enqueueSemanticIndexJob({
    generationId: replacement.id,
    saveId: 'save-1',
    kind: 'rebuild',
    sourceHash: 'new-hash',
    now: 110,
  });
  const replacementJob = db.claimSemanticIndexJob('rebuild', 120);
  db.completeSemanticIndexJob({
    id: replacementJob.id,
    sourceHash: 'new-hash',
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([3, 3]),
    now: 130,
  });

  assert.equal(db.getSemanticIndexState().active_generation_id, replacement.id);
  assert.equal(db.getSemanticIndexState().building_generation_id, null);
  assert.equal(db.getSemanticVector('save-1').source_hash, 'new-hash');
  assert.deepEqual(db.getActiveSemanticVectors().map((row) => row.save_id), ['save-1']);
  assert.equal(db.cancelSemanticGeneration(oldGeneration.id, 140).reason, 'not_building');
  assert.equal(db.getDatabase().prepare(
    'SELECT COUNT(*) AS n FROM semantic_vectors WHERE generation_id = ?',
  ).get(oldGeneration.id).n, 1);
}));

test('dismissed rebuild failures cannot activate a partial generation', withTempDb((db) => {
  insertSave(db, 'save-a');
  insertSave(db, 'save-b');
  const active = db.createSemanticGeneration({
    id: 'gen-complete', model: 'embeddinggemma', sourceVersion: 1, status: 'active', createdAt: 10,
  });
  db.enqueueSemanticIndexJob({
    generationId: active.id,
    saveId: 'save-a',
    kind: 'incremental',
    sourceHash: 'active-a',
    now: 20,
  });
  let job = db.claimSemanticIndexJob('incremental', 30);
  db.completeSemanticIndexJob({
    id: job.id,
    sourceHash: 'active-a',
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([1, 0]),
    now: 40,
  });

  const building = db.createSemanticGeneration({
    id: 'gen-partial', model: 'embeddinggemma', sourceVersion: 2, status: 'building', createdAt: 50,
  });
  db.enqueueSemanticIndexJob({
    generationId: building.id,
    saveId: 'save-a',
    kind: 'rebuild',
    sourceHash: 'rebuild-a',
    now: 60,
  });
  db.enqueueSemanticIndexJob({
    generationId: building.id,
    saveId: 'save-b',
    kind: 'rebuild',
    sourceHash: 'rebuild-b',
    now: 61,
  });
  job = db.claimSemanticIndexJob('rebuild', 70);
  db.failSemanticIndexJob({ id: job.id, error: 'permanent malformed input', now: 80 });
  db.dismissSemanticFailures([job.id], 90);

  job = db.claimSemanticIndexJob('rebuild', 100);
  db.completeSemanticIndexJob({
    id: job.id,
    sourceHash: job.source_hash,
    model: 'embeddinggemma',
    dimension: 2,
    vector: floatBuffer([0, 1]),
    now: 110,
  });

  assert.equal(db.getSemanticIndexState().active_generation_id, active.id);
  assert.equal(db.getSemanticIndexState().building_generation_id, building.id);
  assert.equal(db.getDatabase().prepare(
    'SELECT status FROM semantic_index_generations WHERE id = ?',
  ).get(building.id).status, 'building');
  assert.equal(db.getSemanticVector('save-a').source_hash, 'active-a');
  assert.equal(db.listSemanticIndexJobs({ generationId: building.id, state: 'dismissed' }).length, 1);
}));

test('deleting a save cascades semantic vectors and jobs', withTempDb((db) => {
  insertSave(db, 'save-cascade');
  const generation = db.createSemanticGeneration({
    id: 'gen-cascade', model: 'embeddinggemma', sourceVersion: 1, status: 'active', createdAt: 10,
  });
  db.enqueueSemanticIndexJob({
    generationId: generation.id,
    saveId: 'save-cascade',
    kind: 'incremental',
    sourceHash: 'hash-cascade',
    now: 20,
  });
  const job = db.claimSemanticIndexJob('incremental', 30);
  db.completeSemanticIndexJob({
    id: job.id,
    sourceHash: 'hash-cascade',
    model: 'embeddinggemma',
    dimension: 1,
    vector: floatBuffer([1]),
    now: 40,
  });
  db.enqueueSemanticIndexJob({
    generationId: generation.id,
    saveId: 'save-cascade',
    kind: 'incremental',
    sourceHash: 'hash-new',
    now: 50,
  });

  db.getDatabase().prepare('DELETE FROM saves WHERE id = ?').run('save-cascade');
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM semantic_vectors').get().n, 0);
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM semantic_index_jobs').get().n, 0);
}));
