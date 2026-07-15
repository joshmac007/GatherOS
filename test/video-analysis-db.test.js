const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createSaveBackgroundRouter } = require('../src/main/save-background-router');
const { createVideoSemanticWorkflows } = require('../src/main/video-semantic-workflows');

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
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-db-'));
    const db = loadDb(userData);
    try {
      db.initDatabase();
      await fn(db);
    } finally {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

function sqlitePath(userData) {
  return path.join(userData, 'libraries', 'library_default', 'moodmark.db');
}

function insertVideo(db, id = 'video-save') {
  return db.insertSave({
    id,
    filePath: `/tmp/${id}.mp4`,
    thumbPath: `/tmp/${id}.jpg`,
    title: 'Patio build',
    kind: 'video',
    createdAt: 1,
  });
}

test('tag lookup returns every affected save id for global mutations', withTempDb((db) => {
  insertVideo(db, 'save-a');
  insertVideo(db, 'save-b');
  db.addTagToSave({ saveId: 'save-a', name: 'aviation' });
  const tag = db.getTagsForSave('save-a')[0];
  db.addTagToSave({ saveId: 'save-b', name: 'aviation' });

  assert.deepEqual(db.getSaveIdsForTag(tag.id), ['save-a', 'save-b']);
}));

test('video queue persists pending and running states and recovers interrupted work', withTempDb((db) => {
  insertVideo(db);
  db.enqueueVideoAnalysis({
    id: 'video-job', saveId: 'video-save', fingerprint: 'fp-1', promptVersion: 1, now: 10,
  });
  assert.equal(db.getVideoAnalysis('video-save').state, 'pending');

  const claimed = db.claimVideoAnalysis(20);
  assert.equal(claimed.id, 'video-job');
  assert.equal(db.getVideoAnalysis('video-save').state, 'running');

  const recovered = db.recoverBackgroundJobs(30);
  assert.equal(recovered.video, 1);
  const pending = db.getVideoAnalysis('video-save');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.started_at, null);
  assert.equal(pending.updated_at, 30);
}));

test('save insert atomically creates durable background route and legacy rows are not backfilled', withTempDb((db) => {
  insertVideo(db, 'legacy-save');
  db.getDatabase().prepare('DELETE FROM save_background_routes WHERE save_id = ?').run('legacy-save');
  insertVideo(db, 'route-failure-save');
  assert.equal(db.getSaveBackgroundRoute('legacy-save'), undefined);
  assert.equal(db.getSaveBackgroundRoute('route-failure-save').state, 'pending');
  assert.equal(db.claimSaveBackgroundRoute('route-failure-save', 10).state, 'running');
  db.failSaveBackgroundRoute({ saveId: 'route-failure-save', error: 'queue locked', now: 20 });
  db.closeDatabase();
  db.initDatabase();
  assert.equal(db.getSaveBackgroundRoute('route-failure-save').state, 'pending');
  assert.equal(db.claimSaveBackgroundRoute('route-failure-save', 5020).state, 'running');
  assert.equal(db.completeSaveBackgroundRoute('route-failure-save', 30).ok, true);
  assert.equal(db.getSaveBackgroundRoute('route-failure-save').state, 'completed');
  db.getDatabase().prepare('DELETE FROM saves WHERE id = ?').run('route-failure-save');
  assert.equal(db.getSaveBackgroundRoute('route-failure-save'), undefined);
}));

test('pre-v19 migration leaves legacy saves unrouted and startup dispatches a crashed new route exactly once', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-route-recovery-'));
  const db = loadDb(userData);
  let runtime;
  try {
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(sqlitePath(userData));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP TABLE save_background_routes;
      PRAGMA user_version = 18;
      INSERT INTO saves (id, file_path, thumb_path, title, kind, created_at)
      VALUES ('legacy-before-v19', '/tmp/legacy.png', '/tmp/legacy-thumb.png',
              'Legacy save', 'image', 10);
    `);
    legacy.close();

    db.initDatabase();
    const currentVersion = db.getDatabase().pragma('user_version', { simple: true });
    assert.ok(currentVersion >= 20);
    assert.equal(db.getSaveBackgroundRoute('legacy-before-v19'), undefined);

    db.insertSave({
      id: 'new-after-upgrade',
      filePath: '/tmp/new-after-upgrade.url',
      thumbPath: '/tmp/new-after-upgrade-thumb.png',
      title: 'New save',
      kind: 'url',
      createdAt: 100,
    });
    assert.equal(db.claimSaveBackgroundRoute('new-after-upgrade', 200).state, 'running');
    db.closeDatabase();

    db.initDatabase();
    let downstreamDispatches = 0;
    runtime = createVideoSemanticWorkflows({
      repository: db,
      ollama: {
        model: 'embeddinggemma',
        health: async () => ({ ok: true, model: 'embeddinggemma' }),
        embed: async () => [1, 0],
      },
      codex: {
        hasCodexSession: () => true,
        generateVideoTagSuggestions: async () => ({ tags: [], warnings: [] }),
      },
      frameExtractor: { extract: async () => ({ duration: 0, timestamps: [], frames: [] }) },
      createSemanticIndexService: () => ({
        enqueue(saveId) {
          assert.equal(saveId, 'new-after-upgrade');
          downstreamDispatches += 1;
          return { ok: true };
        },
        createLanes: () => [],
      }),
      createSemanticSearchService: () => ({ search: async () => ({ results: [] }) }),
      createVideoAnalysisService: () => ({ prepare: async () => ({ status: 'queued' }) }),
      now: () => 300,
    });
    runtime.start();

    const router = createSaveBackgroundRouter({
      backgroundRuntime: runtime,
      repository: db,
      getSave: db.getSave,
      isImageSave: () => false,
      now: () => 300,
    });
    assert.deepEqual(await router.resume(), { ok: true, count: 1 });
    assert.deepEqual(await router.recover(), { ok: true, count: 0 });
    assert.equal(downstreamDispatches, 1);
    assert.equal(db.getSaveBackgroundRoute('new-after-upgrade').state, 'completed');
    assert.equal(db.getSaveBackgroundRoute('legacy-before-v19'), undefined);
  } finally {
    try { await runtime?.stopAndDrain(); } catch {}
    try { db.closeDatabase(); } catch {}
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('fingerprint supersession removes unresolved suggestions but preserves accepted and dismissed history', withTempDb((db) => {
  insertVideo(db);
  db.enqueueVideoAnalysis({
    id: 'job-1', saveId: 'video-save', fingerprint: 'fp-1', promptVersion: 1, now: 10,
  });
  const first = db.claimVideoAnalysis(20);
  db.completeVideoAnalysis({
    id: first.id,
    fingerprint: 'fp-1',
    suggestions: [
      { name: 'Patio Renovation', confidence: 'high', evidence: ['visual'] },
      { name: 'Outdoor Living', confidence: 'high', evidence: ['visual', 'post_context'] },
      { name: 'Woodworking', confidence: 'high', evidence: ['visual'] },
    ],
    now: 30,
  });
  const initial = db.listVideoTagSuggestions('video-save');
  assert.deepEqual(initial.map((row) => row.name), [
    'outdoor living', 'patio renovation', 'woodworking',
  ]);

  const accepted = initial.find((row) => row.name === 'patio renovation');
  const dismissed = initial.find((row) => row.name === 'outdoor living');
  assert.deepEqual(db.acceptVideoTagSuggestion({ suggestionId: accepted.id, now: 40 }), {
    ok: true,
    saveId: 'video-save',
  });
  assert.deepEqual(db.dismissVideoTagSuggestion({ suggestionId: dismissed.id, now: 50 }), {
    ok: true,
    saveId: 'video-save',
  });
  assert.deepEqual(db.getTagsForSave('video-save').map((tag) => tag.name), ['patio renovation']);

  db.enqueueVideoAnalysis({
    id: 'job-2', saveId: 'video-save', fingerprint: 'fp-2', promptVersion: 2, now: 60,
  });
  assert.equal(db.getVideoAnalysis('video-save').id, 'job-2');
  assert.equal(db.getVideoAnalysis('video-save').state, 'pending');

  const history = db.listVideoTagSuggestions('video-save');
  assert.deepEqual(history.map((row) => [row.name, row.state]), [
    ['outdoor living', 'dismissed'],
    ['patio renovation', 'accepted'],
  ]);
  assert.equal(history.every((row) => row.fingerprint === 'fp-1'), true);

  const remembered = db.enqueueVideoAnalysis({
    id: 'job-3', saveId: 'video-save', fingerprint: 'fp-1', promptVersion: 1, now: 70,
  });
  assert.equal(remembered.id, 'job-1');
  assert.equal(remembered.state, 'completed');
  assert.equal(db.getVideoAnalysis('video-save').id, 'job-1');
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM video_analysis_jobs').get().n, 2);
  assert.deepEqual(db.listVideoTagSuggestions('video-save').map((row) => [row.name, row.state]), [
    ['outdoor living', 'dismissed'],
    ['patio renovation', 'accepted'],
  ]);
}));

test('same fingerprint is coalesced and retryable failures wait for capped backoff', withTempDb((db) => {
  insertVideo(db);
  db.addTagToSave({ saveId: 'video-save', name: 'existing' });
  const first = db.enqueueVideoAnalysis({
    id: 'job-original', saveId: 'video-save', fingerprint: 'fp-stable', promptVersion: 1, now: 10,
  });
  const duplicate = db.enqueueVideoAnalysis({
    id: 'job-duplicate', saveId: 'video-save', fingerprint: 'fp-stable', promptVersion: 1, now: 20,
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM video_analysis_jobs').get().n, 1);

  const claimed = db.claimVideoAnalysis(30);
  db.failVideoAnalysis({
    id: claimed.id,
    error: 'Codex response was not valid JSON',
    retryable: true,
    retryAt: Number.MAX_SAFE_INTEGER,
    now: 40,
  });
  const failed = db.getVideoAnalysis('video-save');
  assert.equal(failed.state, 'pending');
  assert.equal(failed.retryable, 1);
  assert.equal(failed.retry_count, 1);
  assert.equal(failed.error, 'Codex response was not valid JSON');
  assert.equal(failed.available_at, 40 + (15 * 60 * 1000));
  assert.equal(db.getNextVideoAnalysisReadyAt(), failed.available_at);
  assert.equal(db.claimVideoAnalysis(failed.available_at - 1), undefined);
  const retry = db.claimVideoAnalysis(failed.available_at);
  assert.equal(retry.id, claimed.id);
  assert.equal(retry.retry_count, 1);
  assert.equal(db.getNextVideoAnalysisReadyAt(), null);
  assert.deepEqual(db.getTagsForSave('video-save').map((tag) => tag.name), ['existing']);
  assert.deepEqual(db.listVideoTagSuggestions('video-save'), []);
}));

test('permanent video failures stay inspectable and are never auto-claimed', withTempDb((db) => {
  insertVideo(db, 'video-permanent');
  db.enqueueVideoAnalysis({
    id: 'job-permanent',
    saveId: 'video-permanent',
    fingerprint: 'fp-permanent',
    promptVersion: 1,
    now: 10,
  });
  const claimed = db.claimVideoAnalysis(20);
  db.failVideoAnalysis({
    id: claimed.id,
    error: 'unsupported video evidence',
    retryable: false,
    retryAt: 30,
    now: 25,
  });

  const failed = db.getVideoAnalysis('video-permanent');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryable, 0);
  assert.equal(failed.error, 'unsupported video evidence');
  assert.equal(db.claimVideoAnalysis(Number.MAX_SAFE_INTEGER), undefined);
}));

test('interrupted A to B to A fingerprint sequence restores A as pending', withTempDb((db) => {
  insertVideo(db, 'video-interrupted');
  db.enqueueVideoAnalysis({
    id: 'job-a', saveId: 'video-interrupted', fingerprint: 'fp-a', promptVersion: 1, now: 10,
  });
  assert.equal(db.claimVideoAnalysis(20).id, 'job-a');
  db.enqueueVideoAnalysis({
    id: 'job-b', saveId: 'video-interrupted', fingerprint: 'fp-b', promptVersion: 1, now: 30,
  });
  const restored = db.enqueueVideoAnalysis({
    id: 'job-a-duplicate',
    saveId: 'video-interrupted',
    fingerprint: 'fp-a',
    promptVersion: 1,
    now: 40,
  });

  assert.equal(restored.id, 'job-a');
  assert.equal(restored.state, 'pending');
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM video_analysis_jobs').get().n, 2);
  assert.equal(db.claimVideoAnalysis(50).id, 'job-a');
}));

test('suggestion resolution is idempotent and deleting a save cascades video state', withTempDb((db) => {
  insertVideo(db, 'video-cascade');
  db.enqueueVideoAnalysis({
    id: 'job-cascade',
    saveId: 'video-cascade',
    fingerprint: 'fp-cascade',
    promptVersion: 1,
    now: 10,
  });
  const job = db.claimVideoAnalysis(20);
  db.completeVideoAnalysis({
    id: job.id,
    fingerprint: 'fp-cascade',
    suggestions: [{ name: '#Design  Systems ', confidence: 'high', evidence: ['visual'] }],
    now: 30,
  });
  const suggestion = db.listVideoTagSuggestions('video-cascade')[0];
  assert.equal(suggestion.name, 'design  systems');
  assert.deepEqual(JSON.parse(suggestion.evidence), ['visual']);
  assert.equal(db.dismissVideoTagSuggestion({ suggestionId: suggestion.id, now: 40 }).ok, true);
  assert.equal(db.dismissVideoTagSuggestion({ suggestionId: suggestion.id, now: 50 }).reason, 'resolved');

  db.getDatabase().prepare('DELETE FROM saves WHERE id = ?').run('video-cascade');
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM video_analysis_jobs').get().n, 0);
  assert.equal(db.getDatabase().prepare('SELECT COUNT(*) AS n FROM video_tag_suggestions').get().n, 0);
}));
