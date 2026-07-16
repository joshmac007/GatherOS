'use strict';

const DEFAULT_SMART_CATEGORY_REFRESH_CONFIG = {
  pendingSaveThreshold: 25,
  quietWindowMs: 3 * 60 * 1000,
  batchSize: 8,
  minRunIntervalMs: 60 * 1000,
  taxonomyPendingSaveThreshold: 150,
  taxonomyIntervalMs: 14 * 24 * 60 * 60 * 1000,
  taxonomyIntervalPendingSaveThreshold: 50,
};

const QUIET_ACTIVITY_KINDS = new Set(['capture', 'import', 'search', 'edit']);
const ACTIVE_ACTIVITY_KINDS = new Set(['modal', 'dragDrop']);

function abortError() {
  const error = new Error('Smart-category refresh aborted');
  error.name = 'AbortError';
  error.code = 'smart_category_refresh_aborted';
  return error;
}

function guardedWrite(signal, fn) {
  if (typeof fn !== 'function') return fn;
  return (...args) => {
    if (signal?.aborted) throw abortError();
    return fn(...args);
  };
}

function createSmartCategoryRefreshState({ now = Date.now } = {}) {
  return {
    lastActivityAt: new Map(), active: new Set(), lastRunFinishedAt: 0,
    running: false, pendingSaveCount: 0, manualRequested: false,
    lastTaxonomyRefreshAt: 0, createdAt: now(),
  };
}

function noteSmartCategoryActivity(state, event = {}, at = Date.now()) {
  if (!state || !event?.kind) return state;
  const { kind } = event;
  if (ACTIVE_ACTIVITY_KINDS.has(kind)) {
    if (event.active === false) state.active.delete(kind);
    else state.active.add(kind);
    state.lastActivityAt.set(kind, at);
  } else if (QUIET_ACTIVITY_KINDS.has(kind)) {
    state.lastActivityAt.set(kind, at);
  }
  return state;
}

function activeQuietBlockers(state, timestamp, config = DEFAULT_SMART_CATEGORY_REFRESH_CONFIG) {
  const blockers = [];
  for (const kind of ACTIVE_ACTIVITY_KINDS) if (state?.active?.has(kind)) blockers.push(kind);
  for (const kind of QUIET_ACTIVITY_KINDS) {
    const last = Number(state?.lastActivityAt?.get(kind)) || 0;
    if (last && timestamp - last < config.quietWindowMs) blockers.push(kind);
  }
  return blockers;
}

function getSmartCategoryRefreshDecision({
  state,
  pendingSaveCount = 0,
  categoryCount = 0,
  hasProvider = false,
  manual = false,
  now = Date.now(),
  config = DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
} = {}) {
  if (state?.running) return { ok: false, reason: 'already-running' };
  if (!hasProvider) return { ok: false, reason: 'provider-unavailable' };
  const blockers = activeQuietBlockers(state, now, config);
  if (blockers.length) return { ok: false, reason: 'user-active', blockers };
  if (state?.lastRunFinishedAt && now - state.lastRunFinishedAt < config.minRunIntervalMs && !manual) {
    return { ok: false, reason: 'rate-limited' };
  }
  if (manual) return { ok: true, reason: categoryCount > 0 ? 'manual' : 'manual-discovery' };
  const threshold = Math.max(1, Number(config.pendingSaveThreshold) || 25);
  if (pendingSaveCount < threshold) return { ok: false, reason: 'below-threshold', pendingSaveCount, threshold };
  return { ok: true, reason: categoryCount > 0 ? 'threshold' : 'threshold-discovery' };
}

async function runIncrementalSmartCategoryRefresh({
  pendingSaves = [],
  categories = [],
  structuredProvider,
  providerName = null,
  getSave = () => null,
  getTagsForSave = () => [],
  getSaveTopicProfile = () => null,
  createSaveTopicProfile,
  discoverSmartCategories,
  assignSaveToExistingSmartCategories,
  shouldContinue = () => true,
  recordSmartCategoryRun,
  now = Date.now,
  config = DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
  storage = {},
  signal,
} = {}) {
  const startedAt = now();
  const safePending = Array.isArray(pendingSaves) ? pendingSaves : [];
  let activeCategories = (Array.isArray(categories) ? categories : [])
    .filter((category) => category?.status === 'visible' || category?.status === 'candidate');
  const finish = (summary) => {
    const run = {
      runType: 'incremental_assignment', startedAt, finishedAt: now(), inputSaveCount: safePending.length,
      createdCount: summary.createdCount || 0, renamedCount: 0, mergedCount: 0, splitCount: 0,
      failedCount: summary.failedCount || 0, provider: providerName, error: summary.error || null,
    };
    if (!signal?.aborted) recordSmartCategoryRun?.(run);
    return { ok: true, processedCount: 0, assignedCount: 0, failedCount: 0, ...summary, run };
  };
  if (signal?.aborted) return finish({ ok: false, reason: 'aborted' });
  if (typeof structuredProvider?.completeJson !== 'function') return finish({ reason: 'provider-unavailable', error: 'provider-unavailable' });

  let createdCount = 0;
  const bootstrapProfiles = new Map();
  if (activeCategories.length === 0) {
    if (typeof discoverSmartCategories !== 'function') return finish({ reason: 'no-categories', needsDiscovery: true });
    const profiles = typeof storage.listSaveTopicProfiles === 'function'
      ? storage.listSaveTopicProfiles({ limit: 120 })
      : safePending.map((row) => getSaveTopicProfile(row.id)).filter(Boolean);
    if (profiles.length === 0 && typeof createSaveTopicProfile === 'function') {
      const profileLimit = Math.max(1, Number(config.batchSize) || 8);
      for (const row of safePending.slice(0, profileLimit)) {
        const save = getSave(row.id) || row;
        const result = await createSaveTopicProfile({
          save,
          manualTags: getTagsForSave(row.id),
          structuredProvider,
          upsertSaveTopicProfile: guardedWrite(signal, storage.upsertSaveTopicProfile),
          signal,
        });
        if (signal?.aborted) return finish({ ok: false, reason: 'aborted' });
        if (result?.ok && result.profile) {
          profiles.push(result.profile);
          bootstrapProfiles.set(row.id, result.profile);
        }
      }
    }
    const discovery = await discoverSmartCategories({
      profiles,
      structuredProvider,
      storage: {
        ...storage,
        upsertSmartCategory: guardedWrite(signal, storage.upsertSmartCategory),
        upsertSmartCategoryAlias: guardedWrite(signal, storage.upsertSmartCategoryAlias),
      },
      now,
      signal,
    });
    if (signal?.aborted) return finish({ ok: false, reason: 'aborted' });
    if (!discovery?.ok) return finish({ reason: discovery?.reason || 'discovery-failed', error: discovery?.detail || null, failedCount: 1 });
    createdCount = Number(discovery.createdCount) || 0;
    activeCategories = typeof storage.listSmartCategories === 'function'
      ? storage.listSmartCategories().filter((category) => category.status === 'visible' || category.status === 'candidate')
      : [];
    if (activeCategories.length === 0) return finish({ reason: 'no-categories', createdCount });
  }

  const limit = Math.max(1, Number(config.batchSize) || 8);
  let processedCount = 0;
  let assignedCount = 0;
  let failedCount = 0;
  for (const row of safePending.slice(0, limit)) {
    if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
    if (!shouldContinue({ processedCount, failedCount, saveId: row?.id })) {
      return finish({ processedCount, assignedCount, failedCount, createdCount, deferred: true, error: 'deferred-active-interaction' });
    }
    try {
      const save = getSave(row.id) || row;
      let profile = getSaveTopicProfile(row.id) || bootstrapProfiles.get(row.id);
      if (!profile) {
        const result = await createSaveTopicProfile({
          save,
          manualTags: getTagsForSave(row.id),
          structuredProvider,
          upsertSaveTopicProfile: guardedWrite(signal, storage.upsertSaveTopicProfile),
          signal,
        });
        if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
        if (!result?.ok) { failedCount += 1; processedCount += 1; continue; }
        profile = result.profile;
      }
      const result = await assignSaveToExistingSmartCategories({
        saveId: row.id,
        profile,
        structuredProvider,
        listSmartCategories: storage.listSmartCategories,
        getSmartCategoryAliases: storage.getSmartCategoryAliases,
        upsertSmartCategoryMembership: guardedWrite(signal, storage.upsertSmartCategoryMembership),
        getSemanticIndexState: storage.getSemanticIndexState,
        getSemanticVector: storage.getSemanticVector,
        getActiveSemanticVectors: storage.getActiveSemanticVectors,
        getSmartCategoryMembers: storage.getSmartCategoryMembers,
        signal,
      });
      if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
      if (!result?.ok) failedCount += 1;
      else assignedCount += Number(result.assignedCount) || 0;
    } catch {
      if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
      failedCount += 1;
    }
    processedCount += 1;
  }
  if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
  return finish({ processedCount, assignedCount, failedCount, createdCount });
}

function createBackgroundSmartCategoryRefresh({
  getPendingSmartCategorySaves,
  listSmartCategories,
  getLastTaxonomyRefreshAt,
  hasProvider,
  runRefresh,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  config = DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
} = {}) {
  const state = createSmartCategoryRefreshState({ now });
  let timer = null;
  let paused = false;
  let activeRun = null;
  let activeController = null;
  const schedule = (delay = 0) => {
    if (paused) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void maybeRun().catch(() => {});
    }, Math.max(0, delay));
  };
  const maybeRun = async () => {
    if (paused) return { ok: false, reason: 'paused' };
    if (state.running) return { ok: false, reason: 'already-running' };
    const pending = getPendingSmartCategorySaves?.({ limit: config.batchSize * 2 }) || [];
    const categories = listSmartCategories?.() || [];
    const providerReady = typeof hasProvider === 'function' ? hasProvider() : !!hasProvider;
    const manual = state.manualRequested;
    const pendingCount = Math.max(pending.length, state.pendingSaveCount);
    const activeCategoryCount = categories.filter((category) => category.status === 'visible' || category.status === 'candidate').length;
    const decision = getSmartCategoryRefreshDecision({ state, pendingSaveCount: pendingCount, categoryCount: activeCategoryCount, hasProvider: providerReady, manual, now: now(), config });
    if (!decision.ok) {
      if (manual || decision.reason === 'user-active') schedule(config.quietWindowMs);
      return decision;
    }
    const lastTaxonomy = Math.max(Number(state.lastTaxonomyRefreshAt) || 0, Number(getLastTaxonomyRefreshAt?.()) || 0);
    const taxonomyRequested = manual
      || pendingCount >= config.taxonomyPendingSaveThreshold
      || (pendingCount >= config.taxonomyIntervalPendingSaveThreshold && (!lastTaxonomy || now() - lastTaxonomy >= config.taxonomyIntervalMs));
    state.running = true;
    state.manualRequested = false;
    const controller = new AbortController();
    const token = {};
    activeController = controller;
    const execution = (async () => {
      try {
        const result = await runRefresh({
          pendingSaves: pending,
          categories,
          manual,
          taxonomyRequested,
          signal: controller.signal,
          shouldContinue: () => !paused && !controller.signal.aborted
            && activeQuietBlockers(state, now(), config).length === 0,
        });
        if (paused || controller.signal.aborted) return { ok: false, reason: 'aborted' };
        state.lastRunFinishedAt = now();
        if (taxonomyRequested) state.lastTaxonomyRefreshAt = state.lastRunFinishedAt;
        state.pendingSaveCount = 0;
        return result;
      } catch (error) {
        if (paused || controller.signal.aborted || error?.name === 'AbortError') {
          return { ok: false, reason: 'aborted' };
        }
        return { ok: false, reason: 'refresh-error', detail: error?.message || String(error) };
      } finally {
        if (activeRun?.token === token) {
          activeRun = null;
          activeController = null;
        }
        state.running = false;
      }
    })();
    activeRun = { token, promise: execution };
    return execution;
  };
  return {
    state,
    noteActivity(event) {
      noteSmartCategoryActivity(state, event, now());
      if (event?.kind === 'capture' || event?.kind === 'import') state.pendingSaveCount += 1;
      schedule(config.quietWindowMs);
    },
    requestRefresh() {
      state.manualRequested = true;
      schedule(0);
      return { ok: true, queued: true, paused };
    },
    pause() {
      paused = true;
      if (timer) clearTimer(timer);
      timer = null;
      activeController?.abort();
      return { ok: true };
    },
    async drain() {
      if (activeRun) await activeRun.promise;
      return { ok: true };
    },
    resume() {
      if (!paused) return { ok: true, resumed: false };
      paused = false;
      schedule(0);
      return { ok: true, resumed: true };
    },
    get paused() { return paused; },
    maybeRun,
  };
}

module.exports = {
  DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
  createSmartCategoryRefreshState,
  noteSmartCategoryActivity,
  activeQuietBlockers,
  getSmartCategoryRefreshDecision,
  runIncrementalSmartCategoryRefresh,
  createBackgroundSmartCategoryRefresh,
};
