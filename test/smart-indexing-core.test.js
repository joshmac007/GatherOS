'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSaveTopicProfile } = require('../src/main/save-topic-profiles');
const { discoverSmartCategories } = require('../src/main/smart-category-discovery');
const {
  assignSmartCategoryMemberships,
  computeSemanticCategoryCentroid,
} = require('../src/main/smart-category-memberships');
const {
  runIncrementalSmartCategoryRefresh,
  getSmartCategoryRefreshDecision,
  createSmartCategoryRefreshState,
  createBackgroundSmartCategoryRefresh,
} = require('../src/main/smart-category-refresh');
const { runSmartCategoryTaxonomyRefresh } = require('../src/main/smart-category-taxonomy-refresh');
const { buildSemanticSource } = require('../src/main/semantic-source');
const { createSemanticSearch } = require('../src/main/semantic-search');
const { createSemanticIndex } = require('../src/main/semantic-index');
const { createBackgroundWorkCoordinator } = require('../src/main/background-work-coordinator');
const { vectorToBuffer } = require('../src/main/smart-category-vectors');

test('topic profiling uses structured capability and validates before storage', async () => {
  const calls = [];
  const stored = [];
  const result = await createSaveTopicProfile({
    save: { id: 'save-1', title: 'Poster', kind: 'url', source_url: 'https://example.com' },
    structuredProvider: {
      completeJson: async (request) => {
        calls.push(request);
        return {
          summary: 'A bold poster layout.',
          concepts: ['Typography', 'Poster', 'Layout'],
          content_type: 'moodboard',
          intent: 'inspiration',
          visible_text: 'HELLO',
          confidence: 0.93,
        };
      },
    },
    upsertSaveTopicProfile: (profile) => {
      stored.push(profile);
      return { ok: true, profile };
    },
    now: () => 100,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile.concepts, ['typography', 'poster', 'layout']);
  assert.equal(stored[0].saveId, 'save-1');
  assert.equal(calls[0].imagePath, null);
  assert.match(calls[0].system, /Return JSON only/);
});

test('fresh-library discovery validates and persists deterministic candidate categories', async () => {
  const categories = [];
  const aliases = [];
  const result = await discoverSmartCategories({
    profiles: [{ summary: 'Editorial poster system', concepts: ['poster', 'typography', 'grid'] }],
    structuredProvider: {
      completeJson: async () => ({
        categories: [{
          name: 'Editorial design',
          description: 'Poster and typography references.',
          aliases: ['Graphic design'],
          confidence: 0.9,
        }],
      }),
    },
    storage: {
      upsertSmartCategory: (category) => categories.push(category),
      upsertSmartCategoryAlias: (alias) => aliases.push(alias),
    },
    now: () => 200,
  });
  assert.equal(result.createdCount, 1);
  assert.match(categories[0].id, /^smart-editorial-design-/);
  assert.equal(categories[0].status, 'candidate');
  assert.equal(aliases[0].categoryId, categories[0].id);
});

test('semantic centroids assign weighted memberships without structured provider call', async () => {
  const identity = { generationId: 'gen-1', model: 'embed-model', dimension: 2 };
  const centroid = computeSemanticCategoryCentroid({
    categoryId: 'cat-design',
    identity,
    members: [{
      save_id: 'member-1', generation_id: 'gen-1', model: 'embed-model', dimension: 2,
      source_hash: 'hash-1', weight: 0.9, vector: vectorToBuffer([1, 0]),
    }],
  });
  assert.equal(centroid.ok, true);

  let providerCalls = 0;
  const stored = [];
  const result = await assignSmartCategoryMemberships({
    saveId: 'save-target',
    profile: { summary: 'Design reference', concepts: ['design'] },
    candidateCategories: [{ id: 'cat-design', name: 'Design', status: 'visible' }],
    structuredProvider: { completeJson: async () => { providerCalls += 1; return {}; } },
    upsertSmartCategoryMembership: (membership) => stored.push(membership),
    getSemanticIndexState: () => ({ active_generation_id: 'gen-1' }),
    getSemanticVector: () => ({
      save_id: 'save-target', generation_id: 'gen-1', model: 'embed-model', dimension: 2,
      source_hash: 'target', vector: vectorToBuffer([0.98, 0.02]),
    }),
    getActiveSemanticVectors: () => [{
      save_id: 'member-1', generation_id: 'gen-1', model: 'embed-model', dimension: 2,
      source_hash: 'hash-1', vector: vectorToBuffer([1, 0]),
    }],
    getSmartCategoryMembers: () => [{ save_id: 'member-1', weight: 0.9 }],
    now: () => 300,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'semantic-index');
  assert.equal(result.memberships[0].strength, 'primary');
  assert.equal(providerCalls, 0);
  assert.equal(stored[0].evidence.source, 'semantic-index');
});

test('incremental refresh bootstraps empty taxonomy before assigning pending saves', async () => {
  const categories = [];
  let discoveryCalls = 0;
  let assignmentCalls = 0;
  const result = await runIncrementalSmartCategoryRefresh({
    pendingSaves: [{ id: 'save-1' }],
    categories: [],
    structuredProvider: { completeJson: async () => ({}) },
    getSaveTopicProfile: () => null,
    createSaveTopicProfile: async () => ({
      ok: true,
      profile: { summary: 'A profile', concepts: ['a', 'b', 'c'] },
    }),
    discoverSmartCategories: async ({ storage }) => {
      discoveryCalls += 1;
      storage.upsertSmartCategory({ id: 'cat-1', name: 'Design', status: 'candidate' });
      return { ok: true, createdCount: 1 };
    },
    assignSaveToExistingSmartCategories: async () => {
      assignmentCalls += 1;
      return { ok: true, assignedCount: 1 };
    },
    storage: {
      listSaveTopicProfiles: () => [],
      upsertSmartCategory: (category) => categories.push(category),
      listSmartCategories: () => categories,
    },
    now: (() => { let value = 400; return () => value++; })(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.createdCount, 1);
  assert.equal(result.assignedCount, 1);
  assert.equal(discoveryCalls, 1);
  assert.equal(assignmentCalls, 1);
});

test('refresh decision permits fresh-library discovery after quiet threshold', () => {
  const state = createSmartCategoryRefreshState({ now: () => 0 });
  assert.deepEqual(getSmartCategoryRefreshDecision({
    state,
    pendingSaveCount: 25,
    categoryCount: 0,
    hasProvider: true,
    now: 10_000,
  }), { ok: true, reason: 'threshold-discovery' });
});

test('smart refresh pause aborts and drains without post-await writes', async () => {
  let releaseProvider;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const providerResult = new Promise((resolve) => { releaseProvider = resolve; });
  const stored = [];
  const refresh = createBackgroundSmartCategoryRefresh({
    getPendingSmartCategorySaves: () => [{ id: 'save-1', kind: 'url' }],
    listSmartCategories: () => [{ id: 'cat-1', name: 'Design', status: 'visible' }],
    hasProvider: true,
    runRefresh: ({ pendingSaves, categories, shouldContinue, signal }) => (
      runIncrementalSmartCategoryRefresh({
        pendingSaves,
        categories,
        structuredProvider: {
          completeJson: async () => {
            providerStarted();
            return providerResult;
          },
        },
        getSave: (id) => ({ id, kind: 'url' }),
        getTagsForSave: () => [],
        getSaveTopicProfile: () => null,
        createSaveTopicProfile,
        assignSaveToExistingSmartCategories: async () => ({ ok: true, assignedCount: 1 }),
        shouldContinue,
        signal,
        storage: {
          upsertSaveTopicProfile: (profile) => {
            stored.push(profile);
            return { ok: true, profile };
          },
        },
      })
    ),
    config: {
      pendingSaveThreshold: 1,
      quietWindowMs: 0,
      batchSize: 1,
      minRunIntervalMs: 0,
      taxonomyPendingSaveThreshold: 100,
      taxonomyIntervalMs: 100,
      taxonomyIntervalPendingSaveThreshold: 100,
    },
  });
  const running = refresh.maybeRun();
  await started;
  refresh.pause();
  releaseProvider({
    summary: 'A design reference.',
    concepts: ['design', 'layout', 'poster'],
    content_type: 'moodboard',
    intent: 'inspiration',
    visible_text: '',
    confidence: 0.9,
  });
  await refresh.drain();
  assert.deepEqual(await running, { ok: false, reason: 'aborted' });
  assert.deepEqual(stored, []);
  assert.equal(refresh.paused, true);
  assert.equal(refresh.resume().resumed, true);
});

test('discovery and taxonomy abort before writes after provider await', async () => {
  const discoveryController = new AbortController();
  const categories = [];
  const discovery = discoverSmartCategories({
    profiles: [{ summary: 'Design', concepts: ['design', 'layout', 'poster'] }],
    structuredProvider: {
      completeJson: async () => {
        discoveryController.abort();
        return { categories: [{ name: 'Design', description: 'Visual work', confidence: 0.9 }] };
      },
    },
    storage: { upsertSmartCategory: (row) => categories.push(row) },
    signal: discoveryController.signal,
  });
  assert.equal((await discovery).reason, 'aborted');
  assert.deepEqual(categories, []);

  const taxonomyController = new AbortController();
  const applied = [];
  const taxonomy = await runSmartCategoryTaxonomyRefresh({
    categories: [{ id: 'cat-1', name: 'Design', status: 'visible', aliases: [] }],
    structuredProvider: {
      completeJson: async () => {
        taxonomyController.abort();
        return { renames: [], aliases: [], merges: [], splits: [] };
      },
    },
    storage: { applySmartCategoryTaxonomyChanges: (row) => applied.push(row) },
    signal: taxonomyController.signal,
  });
  assert.equal(taxonomy.reason, 'aborted');
  assert.deepEqual(applied, []);
});

test('taxonomy refresh preserves frozen names and applies safe aliases atomically', async () => {
  const applied = [];
  const result = await runSmartCategoryTaxonomyRefresh({
    categories: [{
      id: 'cat-1', name: 'Design', description: '', status: 'visible', frozen_name: true,
      last_changed_at: null, member_count: 3, aliases: [],
    }],
    structuredProvider: {
      completeJson: async () => ({
        renames: [{ category_id: 'cat-1', new_name: 'Visual design', confidence: 0.99, reason: 'Clearer' }],
        aliases: [{ category_id: 'cat-1', alias: 'Graphic design', confidence: 0.95 }],
        merges: [], splits: [],
      }),
    },
    storage: {
      applySmartCategoryTaxonomyChanges: (changes) => {
        applied.push(changes);
        return { ok: true, renamedCount: changes.renames.length, aliasCount: changes.aliases.length };
      },
    },
    now: (() => { let value = 500; return () => value++; })(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.renamedCount, 0);
  assert.equal(result.aliasCount, 1);
  assert.equal(result.skippedRenames[0].reason, 'name-frozen');
  assert.equal(applied[0].renames.length, 0);
});

test('semantic source is stable across tag order and includes topic evidence', () => {
  const first = buildSemanticSource({
    save: { title: 'Poster', notes: 'Reference' },
    tags: ['Layout', 'poster'],
    topicProfile: { concepts: ['Grid', 'Typography'], summary: 'Editorial system' },
  });
  const second = buildSemanticSource({
    save: { title: 'Poster', notes: 'Reference' },
    tags: ['poster', 'Layout'],
    topicProfile: { concepts: ['Typography', 'Grid'], summary: 'Editorial system' },
  });
  assert.equal(first.sourceHash, second.sourceHash);
  assert.match(first.text, /Topic summary: Editorial system/);
});

test('semantic search uses embedding capability object and ranks active-generation vectors', async () => {
  const rows = [{ id: 'near' }, { id: 'far' }];
  const repository = {
    getSemanticIndexState: () => ({ active_generation_id: 'gen-1' }),
    getActiveSemanticVectors: () => [
      { save_id: 'near', generation_id: 'gen-1', model: 'embed-model', dimension: 2, vector: vectorToBuffer([1, 0]) },
      { save_id: 'far', generation_id: 'gen-1', model: 'embed-model', dimension: 2, vector: vectorToBuffer([0, 1]) },
    ],
    getSavesByIds: (ids) => rows.filter((row) => ids.includes(row.id)),
    getAllSaves: ({ search }) => search ? [] : rows,
  };
  const requests = [];
  const search = createSemanticSearch({
    repository,
    embeddingProvider: {
      model: 'embed-model',
      embed: async (request) => { requests.push(request); return { vector: [1, 0], model: 'embed-model', dimension: 2 }; },
    },
  });
  const result = await search.search('editorial poster');
  assert.equal(result.semanticAvailable, true);
  assert.deepEqual(result.results.map((row) => row.id), ['near']);
  assert.deepEqual(requests[0], { text: 'editorial poster', expectedDimension: 2 });
});

test('semantic index creates generation and writes provider-neutral embedding result', async () => {
  const saves = [{ id: 'save-1', title: 'Poster' }];
  let manifest;
  let completed;
  const repository = {
    getSave: (id) => saves.find((save) => save.id === id),
    getTagsForSave: () => [],
    getSaveTopicProfile: () => ({ summary: 'Editorial poster', concepts: ['poster', 'grid', 'type'] }),
    getAllSaves: () => saves,
    createSemanticRebuild: (value) => { manifest = value; return { ok: true, id: value.id }; },
    getSemanticIndexStatus: () => ({ active_generation_id: null, active_model: null, building_generation_id: manifest?.id || null }),
    listSemanticIndexJobs: () => [],
    getSemanticIndexState: () => ({ active_generation_id: null, building_generation_id: manifest?.id || null, paused: false }),
    getSemanticVector: () => null,
    completeSemanticIndexJob: (value) => { completed = value; return { ok: true }; },
    failSemanticIndexJob: () => { throw new Error('must not fail'); },
    claimSemanticIndexJob: () => null,
  };
  const embedRequests = [];
  const index = createSemanticIndex({
    repository,
    embeddingProvider: {
      model: 'embed-model',
      health: async () => ({ ok: true }),
      embed: async (request) => { embedRequests.push(request); return { vector: [0.5, 0.5], model: 'embed-model', dimension: 2 }; },
    },
    randomUUID: () => 'gen-1',
    now: () => 600,
  });
  const rebuild = index.startRebuild();
  assert.equal(rebuild.ok, true);
  const job = { id: 'job-1', save_id: 'save-1', generation_id: 'gen-1', kind: 'rebuild', source_hash: manifest.jobs[0].sourceHash, retry_count: 0 };
  const result = await index.createLanes()[1].run(job);
  assert.equal(result.ok, true);
  assert.equal(embedRequests[0].text.includes('Topic summary: Editorial poster'), true);
  assert.equal(completed.model, 'embed-model');
  assert.equal(completed.dimension, 2);
  assert.equal(Buffer.isBuffer(completed.vector), true);
});

test('background coordinator preserves lane priority and serial execution', async () => {
  const pending = ['one', 'two'];
  const ran = [];
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [{
      claimReady: () => pending.shift() || null,
      run: async (job) => ran.push(job),
      nextReadyAt: () => null,
    }],
    isForegroundBusy: () => false,
  });
  coordinator.start();
  await coordinator.whenIdle();
  assert.deepEqual(ran, ['one', 'two']);
  coordinator.stop();
});
