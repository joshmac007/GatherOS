const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('same fingerprint is coalesced and failures never mutate ordinary tags', withTempDb((db) => {
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
    retryAt: 500,
    now: 40,
  });
  const failed = db.getVideoAnalysis('video-save');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retry_count, 1);
  assert.equal(failed.error, 'Codex response was not valid JSON');
  assert.equal(db.claimVideoAnalysis(499), undefined);
  const retry = db.claimVideoAnalysis(500);
  assert.equal(retry.id, claimed.id);
  assert.equal(retry.retry_count, 1);
  assert.deepEqual(db.getTagsForSave('video-save').map((tag) => tag.name), ['existing']);
  assert.deepEqual(db.listVideoTagSuggestions('video-save'), []);
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
