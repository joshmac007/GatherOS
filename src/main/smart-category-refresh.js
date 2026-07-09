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

function createSmartCategoryRefreshState({ now = Date.now } = {}) {
  return {
    lastActivityAt: new Map(),
    active: new Set(),
    lastRunFinishedAt: 0,
    running: false,
    pendingSaveCount: 0,
    manualRequested: false,
    lastTaxonomyRefreshAt: 0,
    createdAt: now(),
  };
}

function noteSmartCategoryActivity(state, event = {}, at = Date.now()) {
  if (!state || !event?.kind) return state;
  const kind = event.kind;
  if (ACTIVE_ACTIVITY_KINDS.has(kind)) {
    if (event.active === false) {
      state.active.delete(kind);
      state.lastActivityAt.set(kind, at);
    } else {
      state.active.add(kind);
      state.lastActivityAt.set(kind, at);
    }
    return state;
  }
  if (QUIET_ACTIVITY_KINDS.has(kind)) {
    state.lastActivityAt.set(kind, at);
  }
  return state;
}

function activeQuietBlockers(state, now, config = DEFAULT_SMART_CATEGORY_REFRESH_CONFIG) {
  const blockers = [];
  for (const kind of ['modal', 'dragDrop']) {
    if (state?.active?.has(kind)) blockers.push(kind);
  }
  for (const kind of ['capture', 'import', 'search', 'edit']) {
    const last = Number(state?.lastActivityAt?.get(kind)) || 0;
    if (last > 0 && now - last < config.quietWindowMs) blockers.push(kind);
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
  if (categoryCount <= 0) return { ok: false, reason: 'no-categories' };

  const blockers = activeQuietBlockers(state, now, config);
  if (blockers.length > 0) return { ok: false, reason: 'user-active', blockers };

  if (state?.lastRunFinishedAt && now - state.lastRunFinishedAt < config.minRunIntervalMs && !manual) {
    return { ok: false, reason: 'rate-limited' };
  }

  if (manual) return { ok: true, reason: 'manual' };
  const threshold = Math.max(1, Number(config.pendingSaveThreshold) || DEFAULT_SMART_CATEGORY_REFRESH_CONFIG.pendingSaveThreshold);
  if (pendingSaveCount < threshold) {
    return { ok: false, reason: 'below-threshold', pendingSaveCount, threshold };
  }
  return { ok: true, reason: 'threshold' };
}

async function runIncrementalSmartCategoryRefresh({
  pendingSaves = [],
  categories = [],
  hasProvider = false,
  providerName = null,
  getSave = () => null,
  getTagsForSave = () => [],
  getSaveTopicProfile = () => null,
  createSaveTopicProfile,
  assignSaveToExistingSmartCategories,
  shouldContinue = () => true,
  recordSmartCategoryRun,
  now = Date.now,
  config = DEFAULT_SMART_CATEGORY_REFRESH_CONFIG,
  provider = {},
  storage = {},
} = {}) {
  const startedAt = now();
  const runType = 'incremental_assignment';
  const safePending = Array.isArray(pendingSaves) ? pendingSaves : [];
  const visibleCategories = Array.isArray(categories)
    ? categories.filter((category) => category?.status === 'visible' || category?.status === 'candidate')
    : [];

  const finish = (summary) => {
    const finishedAt = now();
    const record = {
      runType,
      startedAt,
      finishedAt,
      inputSaveCount: safePending.length,
      createdCount: 0,
      renamedCount: 0,
      mergedCount: 0,
      splitCount: 0,
      failedCount: summary.failedCount || 0,
      provider: providerName,
      error: summary.error || null,
    };
    if (typeof recordSmartCategoryRun === 'function') recordSmartCategoryRun(record);
    return {
      ok: true,
      processedCount: summary.processedCount || 0,
      assignedCount: summary.assignedCount || 0,
      failedCount: summary.failedCount || 0,
      deferred: !!summary.deferred,
      reason: summary.reason || null,
      run: record,
    };
  };

  if (!hasProvider) {
    return finish({ reason: 'provider-unavailable', error: 'provider-unavailable' });
  }
  if (visibleCategories.length === 0) {
    return finish({ reason: 'no-categories' });
  }

  const limit = Math.max(1, Number(config.batchSize) || DEFAULT_SMART_CATEGORY_REFRESH_CONFIG.batchSize);
  let processedCount = 0;
  let assignedCount = 0;
  let failedCount = 0;

  for (const row of safePending.slice(0, limit)) {
    if (!shouldContinue({ processedCount, failedCount, saveId: row?.id })) {
      return finish({
        processedCount,
        assignedCount,
        failedCount,
        deferred: true,
        error: 'deferred-active-interaction',
      });
    }

    try {
      const save = getSave(row.id) || row;
      let profile = getSaveTopicProfile(row.id);
      if (!profile) {
        const profileResult = await createSaveTopicProfile({
          save,
          manualTags: getTagsForSave(row.id),
          provider,
          upsertSaveTopicProfile: storage.upsertSaveTopicProfile,
        });
        if (!profileResult?.ok) {
          failedCount += 1;
          continue;
        }
        profile = profileResult.profile;
      }

      const membershipResult = await assignSaveToExistingSmartCategories({
        saveId: row.id,
        profile,
        provider,
        listSmartCategories: storage.listSmartCategories,
        getSmartCategoryAliases: storage.getSmartCategoryAliases,
        upsertSmartCategoryMembership: storage.upsertSmartCategoryMembership,
      });
      if (!membershipResult?.ok) {
        failedCount += 1;
      } else {
        assignedCount += Number(membershipResult.assignedCount) || 0;
      }
    } catch {
      failedCount += 1;
    }
    processedCount += 1;
  }

  return finish({ processedCount, assignedCount, failedCount });
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

  const schedule = (delayMs = 0) => {
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void maybeRun();
    }, Math.max(0, delayMs));
  };

  const maybeRun = async () => {
    if (state.running) return { ok: false, reason: 'already-running' };
    const pending = typeof getPendingSmartCategorySaves === 'function'
      ? getPendingSmartCategorySaves({ limit: config.batchSize * 2 })
      : [];
    const categories = typeof listSmartCategories === 'function' ? listSmartCategories() : [];
    const hasUsableProvider = typeof hasProvider === 'function' ? hasProvider() : !!hasProvider;
    const activeCategoryCount = categories.filter((c) => c.status === 'visible' || c.status === 'candidate').length;
    const pendingCount = Math.max(pending.length, state.pendingSaveCount);
    const manual = state.manualRequested;
    const taxonomyThreshold = Math.max(
      1,
      Number(config.taxonomyPendingSaveThreshold) || DEFAULT_SMART_CATEGORY_REFRESH_CONFIG.taxonomyPendingSaveThreshold,
    );
    const taxonomyInterval = Math.max(
      1,
      Number(config.taxonomyIntervalMs) || DEFAULT_SMART_CATEGORY_REFRESH_CONFIG.taxonomyIntervalMs,
    );
    const taxonomyIntervalPendingThreshold = Math.max(
      1,
      Number(config.taxonomyIntervalPendingSaveThreshold)
        || DEFAULT_SMART_CATEGORY_REFRESH_CONFIG.taxonomyIntervalPendingSaveThreshold,
    );
    const storedLastTaxonomyAt = typeof getLastTaxonomyRefreshAt === 'function'
      ? Number(getLastTaxonomyRefreshAt()) || 0
      : 0;
    const lastTaxonomyAt = Math.max(Number(state.lastTaxonomyRefreshAt) || 0, storedLastTaxonomyAt);
    const taxonomyIntervalDue = !lastTaxonomyAt || now() - lastTaxonomyAt >= taxonomyInterval;
    const taxonomyRequested = manual
      || pendingCount >= taxonomyThreshold
      || (pendingCount >= taxonomyIntervalPendingThreshold && taxonomyIntervalDue);
    const blockers = activeQuietBlockers(state, now(), config);
    const threshold = Math.max(1, Number(config.pendingSaveThreshold) || DEFAULT_SMART_CATEGORY_REFRESH_CONFIG.pendingSaveThreshold);
    if (hasUsableProvider && activeCategoryCount === 0 && blockers.length === 0 && (manual || pendingCount >= threshold)) {
      state.running = true;
      state.manualRequested = false;
      try {
        const result = await runRefresh({
          pendingSaves: pending,
          categories,
          manual,
          taxonomyRequested,
          shouldContinue: () => activeQuietBlockers(state, now(), config).length === 0,
        });
        state.lastRunFinishedAt = now();
        if (taxonomyRequested) state.lastTaxonomyRefreshAt = state.lastRunFinishedAt;
        state.pendingSaveCount = 0;
        return result;
      } finally {
        state.running = false;
      }
    }
    const decision = getSmartCategoryRefreshDecision({
      state,
      pendingSaveCount: pendingCount,
      categoryCount: activeCategoryCount,
      hasProvider: hasUsableProvider,
      manual,
      now: now(),
      config,
    });
    if (!decision.ok) {
      if (state.manualRequested || decision.reason === 'user-active') schedule(config.quietWindowMs);
      return decision;
    }

    state.running = true;
    state.manualRequested = false;
    try {
      const result = await runRefresh({
        pendingSaves: pending,
        categories,
        manual,
        taxonomyRequested,
        shouldContinue: () => activeQuietBlockers(state, now(), config).length === 0,
      });
      state.lastRunFinishedAt = now();
      if (taxonomyRequested) state.lastTaxonomyRefreshAt = state.lastRunFinishedAt;
      state.pendingSaveCount = 0;
      return result;
    } finally {
      state.running = false;
    }
  };

  return {
    state,
    noteActivity(event) {
      noteSmartCategoryActivity(state, event, now());
      if (event?.kind === 'capture' || event?.kind === 'import') {
        state.pendingSaveCount += 1;
      }
      schedule(config.quietWindowMs);
    },
    requestRefresh() {
      state.manualRequested = true;
      schedule(0);
      return { ok: true, queued: true };
    },
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
