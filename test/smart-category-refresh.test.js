const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
  createSmartCategoryRefreshState,
  noteSmartCategoryActivity,
  getSmartCategoryRefreshDecision,
  runIncrementalSmartCategoryRefresh,
  createBackgroundSmartCategoryRefresh,
} = require('../src/main/smart-category-refresh');

test('refresh policy waits for quiet capture, search, edit, modal, and drag windows', () => {
  const config = { ...DEFAULT_SMART_CATEGORY_REFRESH_CONFIG, quietWindowMs: 1000 };
  const state = createSmartCategoryRefreshState({ now: () => 0 });

  noteSmartCategoryActivity(state, { kind: 'capture' }, 100);
  noteSmartCategoryActivity(state, { kind: 'search' }, 200);
  noteSmartCategoryActivity(state, { kind: 'edit' }, 300);
  noteSmartCategoryActivity(state, { kind: 'modal', active: true }, 400);
  noteSmartCategoryActivity(state, { kind: 'dragDrop', active: true }, 500);

  const blocked = getSmartCategoryRefreshDecision({
    state,
    pendingSaveCount: 25,
    categoryCount: 1,
    hasProvider: true,
    now: 900,
    config,
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'user-active');
  assert.deepEqual(blocked.blockers, ['modal', 'dragDrop', 'capture', 'search', 'edit']);

  noteSmartCategoryActivity(state, { kind: 'modal', active: false }, 1300);
  noteSmartCategoryActivity(state, { kind: 'dragDrop', active: false }, 1300);

  const quiet = getSmartCategoryRefreshDecision({
    state,
    pendingSaveCount: 25,
    categoryCount: 1,
    hasProvider: true,
    now: 2501,
    config,
  });

  assert.equal(quiet.ok, true);
  assert.equal(quiet.reason, 'threshold');
});

test('refresh policy starts after threshold or explicit request and defers without categories', () => {
  const config = { ...DEFAULT_SMART_CATEGORY_REFRESH_CONFIG, pendingSaveThreshold: 25 };
  const state = createSmartCategoryRefreshState({ now: () => 0 });

  assert.deepEqual(
    getSmartCategoryRefreshDecision({
      state,
      pendingSaveCount: 24,
      categoryCount: 1,
      hasProvider: true,
      now: 1,
      config,
    }),
    { ok: false, reason: 'below-threshold', pendingSaveCount: 24, threshold: 25 },
  );

  const manual = getSmartCategoryRefreshDecision({
    state,
    pendingSaveCount: 1,
    categoryCount: 1,
    hasProvider: true,
    manual: true,
    now: 1,
    config,
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.reason, 'manual');

  const noCategories = getSmartCategoryRefreshDecision({
    state,
    pendingSaveCount: 25,
    categoryCount: 0,
    hasProvider: true,
    now: 1,
    config,
  });
  assert.equal(noCategories.ok, false);
  assert.equal(noCategories.reason, 'no-categories');
});

test('incremental refresh records no-category run state without forcing assignments', async () => {
  const runs = [];
  const result = await runIncrementalSmartCategoryRefresh({
    pendingSaves: [{ id: 'save-1' }, { id: 'save-2' }],
    categories: [],
    hasProvider: true,
    providerName: 'codex',
    recordSmartCategoryRun: (record) => {
      runs.push(record);
      return { ok: true, run: record };
    },
    now: (() => {
      let t = 1000;
      return () => { t += 50; return t; };
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-categories');
  assert.equal(result.processedCount, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runType, 'incremental_assignment');
  assert.equal(runs[0].inputSaveCount, 2);
  assert.equal(runs[0].failedCount, 0);
  assert.equal(runs[0].provider, 'codex');
  assert.equal(typeof runs[0].startedAt, 'number');
  assert.equal(typeof runs[0].finishedAt, 'number');
});

test('incremental refresh assigns existing categories and records failures and deferral', async () => {
  const calls = [];
  const runs = [];
  const result = await runIncrementalSmartCategoryRefresh({
    pendingSaves: [{ id: 'save-1' }, { id: 'save-2' }, { id: 'save-3' }],
    categories: [{ id: 'cat-ai', status: 'visible', name: 'AI tools' }],
    hasProvider: true,
    providerName: 'codex',
    getSave: (id) => ({ id, file_path: `/tmp/${id}.png` }),
    getTagsForSave: () => [],
    getSaveTopicProfile: (id) => (id === 'save-2' ? { save_id: id, summary: 'existing' } : null),
    createSaveTopicProfile: async ({ save }) => {
      if (save.id === 'save-3') return { ok: false, reason: 'provider-error' };
      return { ok: true, profile: { save_id: save.id, summary: 'fresh' } };
    },
    assignSaveToExistingSmartCategories: async ({ saveId }) => {
      calls.push(saveId);
      return { ok: true, assignedCount: 1 };
    },
    shouldContinue: ({ processedCount }) => processedCount < 2,
    recordSmartCategoryRun: (record) => {
      runs.push(record);
      return { ok: true, run: record };
    },
    now: (() => {
      let t = 2000;
      return () => { t += 25; return t; };
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.processedCount, 2);
  assert.equal(result.assignedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(calls, ['save-1', 'save-2']);
  assert.equal(runs[0].inputSaveCount, 3);
  assert.equal(runs[0].failedCount, 0);
  assert.equal(runs[0].error, 'deferred-active-interaction');
});

test('background refresh marks taxonomy requested for manual or 150 pending saves', async () => {
  const calls = [];
  const refresh = createBackgroundSmartCategoryRefresh({
    getPendingSmartCategorySaves: () => Array.from({ length: 16 }, (_, i) => ({ id: `save-${i}` })),
    listSmartCategories: () => [{ id: 'cat-ai', status: 'visible', name: 'AI tools' }],
    hasProvider: () => true,
    runRefresh: async (payload) => {
      calls.push({
        manual: payload.manual,
        taxonomyRequested: payload.taxonomyRequested,
      });
      return { ok: true };
    },
    now: () => 1_000_000,
    setTimer: () => 1,
    clearTimer: () => {},
    config: {
      ...DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
      pendingSaveThreshold: 1,
      taxonomyPendingSaveThreshold: 150,
    },
  });

  refresh.state.pendingSaveCount = 151;
  await refresh.maybeRun();
  refresh.state.manualRequested = true;
  await refresh.maybeRun();

  assert.deepEqual(calls, [
    { manual: false, taxonomyRequested: true },
    { manual: true, taxonomyRequested: true },
  ]);
});

test('background refresh requests taxonomy after 14 days with 50 pending saves', async () => {
  const calls = [];
  let lastTaxonomyAt = 0;
  const now = 20 * 24 * 60 * 60 * 1000;
  const refresh = createBackgroundSmartCategoryRefresh({
    getPendingSmartCategorySaves: () => Array.from({ length: 50 }, (_, i) => ({ id: `save-${i}` })),
    listSmartCategories: () => [{ id: 'cat-ai', status: 'visible', name: 'AI tools' }],
    getLastTaxonomyRefreshAt: () => lastTaxonomyAt,
    hasProvider: () => true,
    runRefresh: async (payload) => {
      calls.push(payload.taxonomyRequested);
      return { ok: true };
    },
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {},
    config: {
      ...DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
      pendingSaveThreshold: 1,
      taxonomyPendingSaveThreshold: 150,
      taxonomyIntervalPendingSaveThreshold: 50,
      taxonomyIntervalMs: 14 * 24 * 60 * 60 * 1000,
    },
  });

  lastTaxonomyAt = 5 * 24 * 60 * 60 * 1000;
  await refresh.maybeRun();
  refresh.state.lastRunFinishedAt = 0;
  refresh.state.lastTaxonomyRefreshAt = 0;
  lastTaxonomyAt = 10 * 24 * 60 * 60 * 1000;
  await refresh.maybeRun();

  assert.deepEqual(calls, [true, false]);
});
