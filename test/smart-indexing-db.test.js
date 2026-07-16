'use strict';

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
  for (const modulePath of ['../src/main/db.js', '../src/main/library-registry.js']) {
    delete require.cache[require.resolve(modulePath)];
  }
  return require('../src/main/db.js');
}

function withTempDb(run) {
  return async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-smart-db-'));
    const db = loadDb(userData);
    try {
      db.initDatabase();
      await run(db);
    } finally {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

function insertSave(db, id, { kind = 'image', createdAt = 100 } = {}) {
  return db.insertSave({
    id,
    filePath: `/tmp/${id}.${kind === 'video' ? 'mp4' : 'png'}`,
    thumbPath: `/tmp/${id}-thumb.png`,
    title: id,
    kind,
    createdAt,
  });
}

function floatBuffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

test('save insertion creates one durable background route without changing upstream user_version', withTempDb((db) => {
  const database = db.getDatabase();
  const version = database.pragma('user_version', { simple: true });
  insertSave(db, 'save-route', { createdAt: 250 });
  assert.deepEqual(db.getSaveBackgroundRoute('save-route'), {
    save_id: 'save-route',
    state: 'pending',
    retry_count: 0,
    available_at: 250,
    error: null,
    created_at: 250,
    updated_at: 250,
    started_at: null,
    finished_at: null,
  });
  assert.equal(database.pragma('user_version', { simple: true }), version);
  assert.equal(db.claimSaveBackgroundRoute('save-route', 250).state, 'running');
  assert.deepEqual(db.failSaveBackgroundRoute({
    saveId: 'save-route', error: 'first failure', now: 260,
  }), { ok: true, availableAt: 5260, retryCount: 1 });
  assert.equal(db.claimSaveBackgroundRoute('save-route', 5259), undefined);
  assert.equal(db.claimSaveBackgroundRoute('save-route', 5260).state, 'running');
  assert.deepEqual(db.failSaveBackgroundRoute({
    saveId: 'save-route', error: 'second failure', now: 5270,
  }), { ok: true, availableAt: 15270, retryCount: 2 });
  assert.equal(db.claimSaveBackgroundRoute('save-route', 15270).state, 'running');
  assert.equal(db.completeSaveBackgroundRoute('save-route', 15280).ok, true);
  assert.equal(db.getSaveBackgroundRoute('save-route').state, 'completed');
  database.prepare('DELETE FROM save_background_routes WHERE save_id = ?').run('save-route');
  assert.equal(db.backfillSaveBackgroundRoutes(300).count, 1);
  assert.equal(db.backfillSaveBackgroundRoutes(301).count, 0);
  assert.equal(db.getSaveBackgroundRoute('save-route').state, 'pending');
}));

test('smart-category profiles, memberships, aliases, and alias search remain relational', withTempDb((db) => {
  insertSave(db, 'save-design');
  const created = db.upsertSmartCategory({
    id: 'cat-design',
    name: 'Editorial design',
    description: 'Poster systems',
    status: 'visible',
    visibilityScore: 0.9,
    createdAt: 100,
    updatedAt: 100,
  });
  assert.equal(created.ok, true);
  db.upsertSmartCategoryAlias({ categoryId: 'cat-design', alias: 'Graphic layouts', createdAt: 110 });
  db.upsertSaveTopicProfile({
    saveId: 'save-design',
    summary: 'Editorial poster grid',
    concepts: ['poster', 'grid', 'typography'],
    contentType: 'moodboard',
    intentGuess: 'inspiration',
    confidence: 0.92,
    updatedAt: 120,
  });
  db.upsertSmartCategoryMembership({
    categoryId: 'cat-design',
    saveId: 'save-design',
    weight: 0.91,
    evidence: { source: 'test' },
    assignedAt: 130,
    updatedAt: 130,
  });

  assert.deepEqual(db.getSaveTopicProfile('save-design').concepts, ['poster', 'grid', 'typography']);
  assert.equal(db.listSaveTopicProfiles()[0].save_id, 'save-design');
  assert.equal(db.getSmartCategoryMembers('cat-design')[0].evidence.source, 'test');
  assert.deepEqual(db.getAllSaves({ search: 'graphic layouts' }).map((row) => row.id), ['save-design']);
  assert.equal(db.getSmartCategorySaves('cat-design')[0].id, 'save-design');

  db.pinSmartCategory('cat-design', true);
  const replayed = db.upsertSmartCategory({
    id: 'cat-design',
    name: 'Changed by discovery',
    description: 'Updated description',
    status: 'candidate',
    updatedAt: 140,
  });
  assert.equal(replayed.category.name, 'Editorial design');
  assert.equal(replayed.category.status, 'visible');
  assert.equal(replayed.category.description, 'Updated description');
}));

test('semantic rebuild atomically activates only after valid vectors complete', withTempDb((db) => {
  insertSave(db, 'save-a');
  insertSave(db, 'save-b');
  const generation = db.createSemanticRebuild({
    id: 'generation-1',
    model: 'embed-model',
    sourceVersion: 1,
    createdAt: 200,
    jobs: [
      { id: 'job-a', saveId: 'save-a', sourceHash: 'hash-a' },
      { id: 'job-b', saveId: 'save-b', sourceHash: 'hash-b' },
    ],
  });
  assert.equal(generation.status, 'building');
  const first = db.claimSemanticIndexJob('rebuild', 200);
  assert.equal(first.id, 'job-a');
  assert.equal(db.completeSemanticIndexJob({
    id: first.id,
    sourceHash: first.source_hash,
    model: 'embed-model',
    dimension: 2,
    vector: floatBuffer([1, 0]),
    now: 210,
  }).ok, true);
  assert.equal(db.getSemanticIndexState().active_generation_id, null);

  const second = db.claimSemanticIndexJob('rebuild', 220);
  assert.equal(db.completeSemanticIndexJob({
    id: second.id,
    sourceHash: second.source_hash,
    model: 'embed-model',
    dimension: 2,
    vector: floatBuffer([0, 1]),
    now: 230,
  }).ok, true);
  assert.equal(db.getSemanticIndexState().active_generation_id, 'generation-1');
  assert.equal(db.getSemanticIndexState().building_generation_id, null);
  assert.equal(db.getActiveSemanticVectors().length, 2);
  assert.equal(db.getSemanticIndexStatus().indexed, 2);
}));

test('video analysis suggestions resolve into ordinary tags and recovery restores claimed work', withTempDb((db) => {
  insertSave(db, 'save-video', { kind: 'video' });
  db.enqueueVideoAnalysis({
    id: 'video-job',
    saveId: 'save-video',
    fingerprint: 'fingerprint-1',
    promptVersion: 1,
    now: 300,
  });
  const claimed = db.claimVideoAnalysis(300);
  assert.equal(claimed.state, 'running');
  const recovered = db.recoverBackgroundJobs(305);
  assert.equal(recovered.video, 1);
  const reclaimed = db.claimVideoAnalysis(305);
  assert.equal(reclaimed.id, 'video-job');
  assert.equal(db.completeVideoAnalysis({
    id: reclaimed.id,
    fingerprint: 'fingerprint-1',
    suggestions: [{ name: '#Motion', confidence: 'high', evidence: ['frame 1'] }],
    now: 310,
  }).ok, true);
  const suggestion = db.listVideoTagSuggestions('save-video')[0];
  assert.equal(suggestion.name, 'motion');
  assert.equal(db.acceptVideoTagSuggestion({ suggestionId: suggestion.id, now: 320 }).ok, true);
  assert.deepEqual(db.getTagsForSave('save-video').map((tag) => tag.name), ['motion']);
  assert.equal(db.listVideoTagSuggestions('save-video')[0].state, 'accepted');
}));
