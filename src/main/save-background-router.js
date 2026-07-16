'use strict';

const { shouldUseImageAi } = require('./video-semantic-workflows');

const DEFERRED_SEMANTIC_REASONS = new Set(['no_active_generation', 'model_rebuild_required']);

function createSaveBackgroundRouter({
  backgroundRuntime,
  repository,
  getSave = null,
  enrichImageSave = async () => {},
  isImageSave = shouldUseImageAi,
  noteActivity = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  if (typeof backgroundRuntime?.routeSave !== 'function') {
    throw new TypeError('Save background router requires backgroundRuntime.routeSave');
  }
  if (typeof repository?.claimSaveBackgroundRoute !== 'function') {
    throw new TypeError('Save background router requires a durable route outbox');
  }
  if (typeof repository.getSaveBackgroundRoute !== 'function') {
    throw new TypeError('Save background router requires route lookup');
  }
  let retryTimer = null;
  let retryDueAt = null;
  let paused = false;
  const scheduledSaveIds = new Set();

  function clearRetryTimer() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    retryDueAt = null;
  }

  function scheduleRecovery(availableAt) {
    if (paused || !Number.isFinite(availableAt)) return;
    if (retryDueAt !== null && retryDueAt <= availableAt) return;
    clearRetryTimer();
    retryDueAt = availableAt;
    retryTimer = setTimer(() => {
      retryTimer = null;
      retryDueAt = null;
      recover().catch((error) => logger?.error?.('[background] outbox recovery failed:', error));
    }, Math.max(0, availableAt - now()));
    retryTimer?.unref?.();
  }

  async function finishClaim(record, { enrich = false, taskRouteSave = null } = {}) {
    try {
      if (enrich) {
        try { await enrichImageSave(record); } catch (error) {
          logger?.error?.('[background] image enrichment failed:', error?.message || error);
        }
      }
      const current = typeof getSave === 'function' ? getSave(record.id) || record : record;
      const routeSave = taskRouteSave || backgroundRuntime.routeSave.bind(backgroundRuntime);
      const routed = await routeSave(current, { changed: enrich });
      const semanticReason = routed?.semanticWarning?.detail || routed?.semanticWarning?.reason;
      if (routed?.ok === false) throw new Error(routed.reason || 'background-route-failed');
      if (routed?.semanticWarning && !DEFERRED_SEMANTIC_REASONS.has(semanticReason)) {
        throw new Error(semanticReason || 'semantic-enqueue-failed');
      }
      repository.completeSaveBackgroundRoute(record.id, now());
      return routed;
    } catch (error) {
      const failed = repository.failSaveBackgroundRoute({
        saveId: record.id,
        error: error?.message || String(error),
        now: now(),
      });
      scheduleRecovery(failed?.availableAt);
      throw error;
    }
  }

  function enqueue(record, { duplicate = false } = {}) {
    if (!record?.id) return { ok: false, reason: 'save_not_found' };
    noteActivity?.({ kind: duplicate ? 'duplicate' : 'save', saveId: record.id });
    const route = repository.getSaveBackgroundRoute(record.id);
    if (!route || route.state !== 'pending' || scheduledSaveIds.has(record.id)) {
      return { ok: true, skipped: 'duplicate' };
    }
    const image = isImageSave(record);
    scheduledSaveIds.add(record.id);
    const scheduled = backgroundRuntime.scheduleForegroundTask(async ({ isCurrent, routeSave }) => {
      try {
        if (!isCurrent()) return { ok: false, reason: 'library_epoch_stale' };
        const claim = repository.claimSaveBackgroundRoute(record.id, now());
        if (!claim) return { ok: true, skipped: 'duplicate' };
        return finishClaim(record, { enrich: image, taskRouteSave: routeSave });
      } finally {
        scheduledSaveIds.delete(record.id);
      }
    });
    if (scheduled?.ok === false) {
      scheduledSaveIds.delete(record.id);
      scheduleRecovery(repository.getNextSaveBackgroundRouteReadyAt?.());
    }
    return scheduled;
  }

  async function recover() {
    if (paused) return { ok: false, reason: 'paused' };
    const backfill = repository.backfillSaveBackgroundRoutes?.(now()) || { count: 0 };
    const rows = repository.listPendingSaveBackgroundRoutes(now());
    for (const row of rows) {
      const record = typeof getSave === 'function' ? getSave(row.save_id) : null;
      if (record) enqueue(record, { duplicate: true });
    }
    scheduleRecovery(repository.getNextSaveBackgroundRouteReadyAt?.());
    return { ok: true, count: rows.length, backfilled: Number(backfill.count) || 0 };
  }

  function notify(record, { backgroundRouted = false, duplicate = false } = {}) {
    if (backgroundRouted) return null;
    return enqueue(record, { duplicate });
  }

  function pause() { paused = true; clearRetryTimer(); }
  function resume() { paused = false; return recover(); }

  return { enqueue, notify, recover, pause, resume };
}

module.exports = { createSaveBackgroundRouter };
