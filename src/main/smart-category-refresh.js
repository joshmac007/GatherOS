'use strict';

const crypto = require('node:crypto');

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

function normalizeTaxonomyText(value, max = 1000) {
  if (value == null) return null;
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase().slice(0, max);
}

function buildSmartCategoryTaxonomyFingerprint(categories = []) {
  const semantics = (Array.isArray(categories) ? categories : [])
    .filter((category) => category?.status === 'visible' || category?.status === 'candidate')
    .map((category) => ({
      id: String(category.id || '').trim(),
      status: String(category.status || '').trim(),
      name: normalizeTaxonomyText(category.name, 160),
      description: normalizeTaxonomyText(category.description, 400),
      aliases: [...new Set((Array.isArray(category.aliases) ? category.aliases : [])
        .map((alias) => typeof alias === 'string' ? alias : alias?.alias)
        .map((alias) => normalizeTaxonomyText(alias, 160))
        .filter(Boolean))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    }))
    .filter((category) => category.id)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return crypto.createHash('sha256').update(JSON.stringify(semantics)).digest('hex');
}

const getSmartCategoryTaxonomyFingerprint = buildSmartCategoryTaxonomyFingerprint;

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
  const finish = (summary = {}) => {
    const failedCount = Number(summary.failedCount) || 0;
    const completedCount = Number(summary.completedCount) || 0;
    const run = {
      runType: 'incremental_assignment', startedAt, finishedAt: now(), inputSaveCount: safePending.length,
      createdCount: summary.createdCount || 0, renamedCount: 0, mergedCount: 0, splitCount: 0,
      failedCount, provider: providerName, error: summary.error || null,
    };
    if (!signal?.aborted) recordSmartCategoryRun?.(run);
    const ok = summary.ok !== false && failedCount === 0;
    return {
      ok,
      reason: summary.reason || (ok ? null : failedCount ? 'item-failures' : 'refresh-failed'),
      retryable: summary.retryable === true,
      processedCount: Number(summary.processedCount) || 0,
      completedCount,
      assignedCount: Number(summary.assignedCount) || 0,
      failedCount,
      ...summary,
      ok,
      retryable: summary.retryable === true,
      processedCount: Number(summary.processedCount) || 0,
      completedCount,
      failedCount,
      run,
    };
  };
  if (signal?.aborted) return finish({ ok: false, reason: 'aborted' });
  if (typeof structuredProvider?.completeJson !== 'function') {
    return finish({ ok: false, reason: 'provider-unavailable', error: 'provider-unavailable' });
  }
  if (safePending.length === 0) return finish({ ok: true, reason: 'no-pending' });

  let createdCount = 0;
  let taxonomyFingerprint = typeof storage.getSmartCategoryTaxonomyFingerprint === 'function'
    ? storage.getSmartCategoryTaxonomyFingerprint({ categories: activeCategories })
    : buildSmartCategoryTaxonomyFingerprint(activeCategories);
  const persistFailure = ({ saveId, profileVersion = null, phase, result, error }) => {
    if (typeof storage.failSmartCategoryAssignment !== 'function') return;
    storage.failSmartCategoryAssignment({
      saveId,
      profileVersion,
      taxonomyFingerprint,
      phase,
      error: error || result?.detail || result?.reason || 'assignment-failed',
      retryable: result?.retryable === true,
      now: now(),
    });
  };
  const bootstrapProfiles = new Map();
  const bootstrapFailedSaveIds = new Set();
  if (activeCategories.length === 0) {
    if (typeof discoverSmartCategories !== 'function') {
      return finish({ ok: false, reason: 'no-categories', needsDiscovery: true, failedCount: 1 });
    }
    const profiles = typeof storage.listSaveTopicProfiles === 'function'
      ? storage.listSaveTopicProfiles({ limit: 120 })
      : safePending.map((row) => getSaveTopicProfile(row.id)).filter(Boolean);
    let bootstrapFailedCount = 0;
    let bootstrapRetryable = false;
    if (profiles.length === 0) {
      const profileLimit = Math.max(1, Number(config.batchSize) || 8);
      for (const row of safePending.slice(0, profileLimit)) {
        const save = getSave(row.id) || row;
        let result;
        try {
          result = typeof createSaveTopicProfile === 'function'
            ? await createSaveTopicProfile({
              save,
              manualTags: getTagsForSave(row.id),
              structuredProvider,
              upsertSaveTopicProfile: guardedWrite(signal, storage.upsertSaveTopicProfile),
              signal,
            })
            : { ok: false, reason: 'profile-unavailable', retryable: false };
        } catch (error) {
          result = { ok: false, reason: 'profile-error', detail: error?.message || String(error), retryable: error?.retryable === true };
        }
        if (signal?.aborted) return finish({ ok: false, reason: 'aborted' });
        if (result?.ok && result.profile) {
          profiles.push(result.profile);
          bootstrapProfiles.set(row.id, result.profile);
        } else {
          persistFailure({ saveId: row.id, phase: 'profile', result });
          bootstrapFailedSaveIds.add(row.id);
          bootstrapFailedCount += 1;
          bootstrapRetryable ||= result?.retryable === true;
        }
      }
    }
    if (profiles.length === 0 && bootstrapFailedCount > 0) {
      return finish({
        ok: false,
        reason: 'profile-failures',
        error: 'profile-failures',
        processedCount: bootstrapFailedCount,
        failedCount: bootstrapFailedCount,
        retryable: bootstrapRetryable,
      });
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
    if (!discovery?.ok) {
      return finish({ ok: false, reason: discovery?.reason || 'discovery-failed', error: discovery?.detail || null, failedCount: 1, retryable: discovery?.retryable === true });
    }
    createdCount = Number(discovery.createdCount) || 0;
    activeCategories = typeof storage.listSmartCategories === 'function'
      ? storage.listSmartCategories().filter((category) => category.status === 'visible' || category.status === 'candidate')
      : [];
    if (activeCategories.length === 0) return finish({ ok: false, reason: 'no-categories', createdCount, failedCount: 1 });
  }
  taxonomyFingerprint = typeof storage.getSmartCategoryTaxonomyFingerprint === 'function'
    ? storage.getSmartCategoryTaxonomyFingerprint({ categories: activeCategories })
    : buildSmartCategoryTaxonomyFingerprint(activeCategories);

  const limit = Math.max(1, Number(config.batchSize) || 8);
  let processedCount = 0;
  let completedCount = 0;
  let assignedCount = 0;
  let failedCount = 0;
  for (const row of safePending.slice(0, limit)) {
    if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
    if (bootstrapFailedSaveIds.has(row.id)) {
      processedCount += 1;
      failedCount += 1;
      continue;
    }
    if (!shouldContinue({ processedCount, failedCount, saveId: row?.id })) {
      return finish({ ok: true, reason: 'deferred-active-interaction', processedCount, completedCount, assignedCount, failedCount, createdCount, deferred: true, error: 'deferred-active-interaction' });
    }
    let profile = null;
    try {
      const save = getSave(row.id) || row;
      profile = getSaveTopicProfile(row.id) || bootstrapProfiles.get(row.id);
      if (!profile) {
        if (typeof createSaveTopicProfile !== 'function') {
          persistFailure({ saveId: row.id, phase: 'profile', result: { reason: 'profile-unavailable' } });
          failedCount += 1;
          processedCount += 1;
          continue;
        }
        const result = await createSaveTopicProfile({
          save,
          manualTags: getTagsForSave(row.id),
          structuredProvider,
          upsertSaveTopicProfile: guardedWrite(signal, storage.upsertSaveTopicProfile),
          signal,
        });
        if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
        if (!result?.ok) {
          persistFailure({ saveId: row.id, phase: 'profile', result });
          failedCount += 1;
          processedCount += 1;
          continue;
        }
        profile = result.profile;
      }
      taxonomyFingerprint = typeof storage.getSmartCategoryTaxonomyFingerprint === 'function'
        ? storage.getSmartCategoryTaxonomyFingerprint({ categories: activeCategories })
        : taxonomyFingerprint;
      if (typeof assignSaveToExistingSmartCategories !== 'function') {
        persistFailure({ saveId: row.id, profileVersion: profile?.updated_at, phase: 'assignment', result: { reason: 'assignment-unavailable' } });
        failedCount += 1;
        processedCount += 1;
        continue;
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
      if (!result?.ok) {
        persistFailure({ saveId: row.id, profileVersion: profile?.updated_at, phase: 'assignment', result });
        failedCount += 1;
      } else {
        const count = Number(result.assignedCount) || 0;
        assignedCount += count;
        completedCount += 1;
        storage.completeSmartCategoryAssignment?.({
          saveId: row.id,
          profileVersion: Number.isFinite(profile?.updated_at) ? profile.updated_at : null,
          taxonomyFingerprint,
          outcome: count > 0 ? 'assigned' : 'unmatched',
          now: now(),
        });
      }
    } catch (error) {
      if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
      persistFailure({ saveId: row.id, profileVersion: profile?.updated_at, phase: profile ? 'assignment' : 'profile', error });
      failedCount += 1;
    }
    processedCount += 1;
  }
  if (signal?.aborted) return finish({ ok: false, reason: 'aborted', processedCount, assignedCount, failedCount, createdCount });
  return finish({ ok: failedCount === 0, processedCount, completedCount, assignedCount, failedCount, createdCount });
}

function createBackgroundSmartCategoryRefresh({
  getPendingSmartCategorySaves,
  getSmartCategoryPendingState,
  getSmartCategoryTaxonomyFingerprint,
  resetSmartCategoryAssignmentFailures,
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
  state.startupRecovery = true;
  let timer = null;
  let timerDueAt = null;
  let paused = false;
  let activeRun = null;
  let activeController = null;
  let continuationRequested = false;

  const clearScheduled = () => {
    if (timer) clearTimer(timer);
    timer = null;
    timerDueAt = null;
  };
  const scheduleAt = (timestamp) => {
    if (paused) return;
    const dueAt = Math.max(now(), Number(timestamp) || now());
    if (timer && timerDueAt != null && timerDueAt <= dueAt) return;
    clearScheduled();
    timerDueAt = dueAt;
    timer = setTimer(() => {
      timer = null;
      timerDueAt = null;
      void maybeRun().catch(() => {});
    }, Math.max(0, dueAt - now()));
    timer?.unref?.();
  };
  const schedule = (delay = 0) => scheduleAt(now() + Math.max(0, Number(delay) || 0));
  const waitWithAbort = (delay, signal) => new Promise((resolve) => {
    const timeout = Math.max(0, Number(delay) || 0);
    if (timeout === 0 || signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timerHandle = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimer(timerHandle);
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    };
    const onAbort = finish;
    timerHandle = setTimer(finish, timeout);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  const taxonomyFingerprint = (categories = []) => {
    if (typeof getSmartCategoryTaxonomyFingerprint === 'function') {
      return getSmartCategoryTaxonomyFingerprint({ categories });
    }
    return buildSmartCategoryTaxonomyFingerprint(categories);
  };
  const pendingSnapshot = ({ limit, at, fingerprint }) => {
    const pending = typeof getPendingSmartCategorySaves === 'function'
      ? getPendingSmartCategorySaves({ limit, now: at, taxonomyFingerprint: fingerprint }) || []
      : [];
    const summary = typeof getSmartCategoryPendingState === 'function'
      ? getSmartCategoryPendingState({ now: at, taxonomyFingerprint: fingerprint }) || {}
      : { eligibleCount: pending.length, nextRetryAt: null };
    return {
      pending: Array.isArray(pending) ? pending : [],
      eligibleCount: Math.max(pending.length, Number(summary.eligibleCount) || 0),
      nextRetryAt: Number.isFinite(summary.nextRetryAt) ? summary.nextRetryAt : null,
    };
  };
  const normalizeRunResult = (result, fallbackProcessed = 0) => ({
    ok: result?.ok !== false,
    reason: result?.reason || null,
    retryable: result?.retryable === true,
    processedCount: Math.max(0, Number(result?.processedCount) || fallbackProcessed),
    completedCount: Math.max(0, Number(result?.completedCount) || 0),
    failedCount: Math.max(0, Number(result?.failedCount) || 0),
    ...result,
  });

  const maybeRun = async () => {
    if (paused) return { ok: false, reason: 'paused', retryable: false, processedCount: 0, completedCount: 0, failedCount: 0 };
    if (state.running) return { ok: false, reason: 'already-running', retryable: false, processedCount: 0, completedCount: 0, failedCount: 0 };
    const at = now();
    const categories = listSmartCategories?.() || [];
    const fingerprint = taxonomyFingerprint(categories);
    const snapshot = pendingSnapshot({ limit: config.batchSize, at, fingerprint });
    const pending = snapshot.pending;
    const providerReady = typeof hasProvider === 'function' ? hasProvider() : !!hasProvider;
    const manual = state.manualRequested;
    // SQLite pending state is source of truth. In-memory activity counters can
    // hint when a cycle is worth checking, never make an empty/stale DB queue
    // look eligible.
    const pendingCount = snapshot.eligibleCount;
    const activeCategoryCount = categories.filter((category) => category.status === 'visible' || category.status === 'candidate').length;
    const blockers = activeQuietBlockers(state, at, config);
    if (blockers.length) {
      schedule(config.quietWindowMs);
      return { ok: false, reason: 'user-active', blockers, retryable: false, processedCount: 0, completedCount: 0, failedCount: 0 };
    }
    // Consume startup recovery after one clean empty reconciliation. New
    // activity after that point must use the normal automatic threshold.
    if (state.startupRecovery && pendingCount === 0 && snapshot.nextRetryAt == null) {
      state.startupRecovery = false;
    }
    if (continuationRequested && pendingCount === 0 && snapshot.nextRetryAt == null) {
      continuationRequested = false;
    }
    const recovery = state.startupRecovery && pendingCount > 0;
    const continuation = continuationRequested && pendingCount > 0;
    const minIntervalAt = (Number(state.lastRunFinishedAt) || 0)
      + Math.max(0, Number(config.minRunIntervalMs) || 0);
    if (continuation && state.lastRunFinishedAt && at < minIntervalAt && !manual) {
      scheduleAt(minIntervalAt);
      return { ok: false, reason: 'rate-limited', retryable: false, processedCount: 0, completedCount: 0, failedCount: 0 };
    }
    const decision = recovery || continuation
      ? { ok: true, reason: recovery ? 'startup-recovery' : 'cycle-continuation' }
      : getSmartCategoryRefreshDecision({ state, pendingSaveCount: pendingCount, categoryCount: activeCategoryCount, hasProvider: providerReady, manual, now: at, config });
    if (!decision.ok) {
      if (manual || decision.reason === 'user-active') schedule(config.quietWindowMs);
      else if (snapshot.nextRetryAt != null) {
        const minIntervalAt = (Number(state.lastRunFinishedAt) || 0) + Math.max(0, Number(config.minRunIntervalMs) || 0);
        scheduleAt(Math.max(snapshot.nextRetryAt || 0, minIntervalAt, at));
      }
      return { ...decision, retryable: false, processedCount: 0, completedCount: 0, failedCount: 0 };
    }
    if (!providerReady) return { ok: false, reason: 'provider-unavailable', retryable: false, processedCount: 0, completedCount: 0, failedCount: 0 };
    state.startupRecovery = false;
    continuationRequested = true;
    const lastTaxonomy = Math.max(Number(state.lastTaxonomyRefreshAt) || 0, Number(getLastTaxonomyRefreshAt?.()) || 0);
    const taxonomyRequested = manual
      || pendingCount >= config.taxonomyPendingSaveThreshold
      || (pendingCount >= config.taxonomyIntervalPendingSaveThreshold && (!lastTaxonomy || at - lastTaxonomy >= config.taxonomyIntervalMs));
    state.running = true;
    state.manualRequested = false;
    const controller = new AbortController();
    const token = {};
    activeController = controller;
    const execution = (async () => {
      let processedCount = 0;
      let completedCount = 0;
      let failedCount = 0;
      let assignedCount = 0;
      let lastResult = null;
      let firstBatch = true;
      let retriedBatch = false;
      let stopReason = null;
      let deferredWake = false;
      try {
        while (!paused && !controller.signal.aborted) {
          const cycleAt = now();
          const cycleCategories = listSmartCategories?.() || [];
          const cycleFingerprint = taxonomyFingerprint(cycleCategories);
          const cycle = pendingSnapshot({ limit: Math.max(1, Number(config.batchSize) || 8), at: cycleAt, fingerprint: cycleFingerprint });
          if (cycle.pending.length === 0) {
            if (cycle.nextRetryAt != null) {
              deferredWake = true;
              scheduleAt(cycle.nextRetryAt);
            }
            else if (cycle.eligibleCount > 0) stopReason = 'no-progress';
            break;
          }
          const taxonomyThisBatch = firstBatch && taxonomyRequested;
          let result = normalizeRunResult(await runRefresh({
            pendingSaves: cycle.pending,
            categories: cycleCategories,
            manual,
            taxonomyRequested: taxonomyThisBatch,
            signal: controller.signal,
            shouldContinue: () => !paused && !controller.signal.aborted
              && activeQuietBlockers(state, now(), config).length === 0,
          }), cycle.pending.length);
          if (result.retryable && !retriedBatch && result.taxonomy?.retryable === true) {
            const initialResult = result;
            retriedBatch = true;
            await waitWithAbort(config.minRunIntervalMs, controller.signal);
            if (paused || controller.signal.aborted) break;
            const taxonomyRetry = normalizeRunResult(await runRefresh({
              pendingSaves: [],
              categories: listSmartCategories?.() || [],
              manual,
              taxonomyRequested: true,
              taxonomyOnly: true,
              signal: controller.signal,
              shouldContinue: () => !paused && !controller.signal.aborted
                && activeQuietBlockers(state, now(), config).length === 0,
            }), 0);
            result = {
              ...taxonomyRetry,
              processedCount: initialResult.processedCount + taxonomyRetry.processedCount,
              completedCount: initialResult.completedCount + taxonomyRetry.completedCount,
              assignedCount: (Number(initialResult.assignedCount) || 0) + (Number(taxonomyRetry.assignedCount) || 0),
              failedCount: taxonomyRetry.failedCount,
              taxonomy: taxonomyRetry.taxonomy || initialResult.taxonomy,
            };
          }
          lastResult = result;
          if (result.retryable && !retriedBatch) {
            retriedBatch = true;
            await waitWithAbort(config.minRunIntervalMs, controller.signal);
            if (paused || controller.signal.aborted) break;
            continue;
          }
          firstBatch = false;
          retriedBatch = false;
          processedCount += result.processedCount;
          completedCount += result.completedCount;
          failedCount += result.failedCount;
          assignedCount += Number(result.assignedCount) || 0;
          if (taxonomyThisBatch && result.taxonomy?.ok === true) state.lastTaxonomyRefreshAt = now();
          if (result.processedCount <= 0 && result.completedCount <= 0) {
            stopReason = result.reason || 'no-progress';
            break;
          }
          if (result.failedCount > 0 && result.ok === false) stopReason = result.reason || 'item-failures';
          const after = pendingSnapshot({ limit: 1, at: now(), fingerprint: taxonomyFingerprint(listSmartCategories?.() || []) });
          if (after.pending.length === 0) {
            if (after.nextRetryAt != null) {
              deferredWake = true;
              scheduleAt(after.nextRetryAt);
            }
            break;
          }
          const currentId = cycle.pending[0]?.id || null;
          const nextId = after.pending[0]?.id || null;
          if (currentId && currentId === nextId && result.processedCount > 0) {
            stopReason = stopReason || 'no-progress';
            break;
          }
          if (Number(config.minRunIntervalMs) > 0) {
            await waitWithAbort(config.minRunIntervalMs, controller.signal);
            if (paused || controller.signal.aborted) break;
          }
        }
        if (paused || controller.signal.aborted) return { ok: false, reason: 'aborted' };
        state.lastRunFinishedAt = now();
        state.pendingSaveCount = 0;
        if (!deferredWake) continuationRequested = false;
        const ok = failedCount === 0 && !stopReason;
        return {
          ok,
          reason: stopReason || (ok ? null : lastResult?.reason || 'refresh-failed'),
          retryable: false,
          processedCount,
          completedCount,
          assignedCount,
          failedCount,
          ...(lastResult?.taxonomy ? { taxonomy: lastResult.taxonomy } : {}),
        };
      } catch (error) {
        if (paused || controller.signal.aborted || error?.name === 'AbortError') {
          return { ok: false, reason: 'aborted' };
        }
        if (error?.retryable === true) schedule(config.minRunIntervalMs);
        else continuationRequested = false;
        return { ok: false, reason: 'refresh-error', retryable: error?.retryable === true, detail: error?.message || String(error), processedCount, completedCount, failedCount };
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
  // Startup reconciliation is intentionally quiet; after that window any
  // eligible backlog is recovery work and bypasses the 25-item auto gate.
  schedule(config.quietWindowMs);
  return {
    state,
    noteActivity(event) {
      noteSmartCategoryActivity(state, event, now());
      if ((event?.kind === 'capture' || event?.kind === 'import') && typeof resetSmartCategoryAssignmentFailures === 'function') {
        resetSmartCategoryAssignmentFailures({ now: now() });
      }
      schedule(config.quietWindowMs);
    },
    requestRefresh() {
      resetSmartCategoryAssignmentFailures?.({ now: now() });
      state.manualRequested = true;
      schedule(0);
      return { ok: true, queued: true, paused };
    },
    pause() {
      paused = true;
      clearScheduled();
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
  buildSmartCategoryTaxonomyFingerprint,
  getSmartCategoryTaxonomyFingerprint,
  getSmartCategoryRefreshDecision,
  runIncrementalSmartCategoryRefresh,
  createBackgroundSmartCategoryRefresh,
};
