import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import styles from './SemanticIndexSettings.module.css';

const DEFAULT_MODEL = 'embeddinggemma';
const QUEUE_PAGE_SIZE = 100;
const SEMANTIC_EVENTS = [
  'semantic-index:status',
  'semantic-index:progress',
  'semantic-index:notice',
];

const SEMANTIC_NOTICE_FALLBACKS = {
  paused: 'Semantic indexing paused. Check Settings for details.',
  'rebuild-complete': 'Semantic index rebuild complete.',
};

export function semanticNoticeMessage(payload) {
  if (typeof payload === 'string') return payload.trim() || null;
  if (!payload || typeof payload !== 'object') return null;
  const supplied = [payload.message, payload.notice]
    .find((value) => typeof value === 'string' && value.trim());
  return supplied?.trim() || SEMANTIC_NOTICE_FALLBACKS[payload.type] || null;
}

export function subscribeSemanticNotices(moodmark, onNotice) {
  if (typeof moodmark?.on !== 'function' || typeof onNotice !== 'function') return () => {};
  let unsubscribe;
  try {
    unsubscribe = moodmark.on('semantic-index:notice', (payload) => {
      const message = semanticNoticeMessage(payload);
      if (message) onNotice(message, payload);
    });
  } catch {
    return () => {};
  }
  return () => {
    try { unsubscribe?.(); } catch { /* best-effort event cleanup */ }
  };
}

function asCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function sentenceCase(value) {
  const normalized = String(value || '').replaceAll('_', ' ').trim();
  if (!normalized) return 'Waiting';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function unwrapStatus(input) {
  if (!input || typeof input !== 'object') return {};
  if (input.status && typeof input.status === 'object') {
    return { ...input, ...input.status };
  }
  return input;
}

export function deriveSemanticIndexView(input) {
  const status = unwrapStatus(input);
  const ollama = status.ollama && typeof status.ollama === 'object' ? status.ollama : {};
  const health = status.health && typeof status.health === 'object' ? status.health : {};
  const connected = Boolean(
    ollama.connected
      ?? ollama.ok
      ?? health.connected
      ?? health.ok
      ?? status.connected
      ?? status.healthy
      ?? false,
  );
  const model = status.model
    || ollama.model
    || status.activeGeneration?.model
    || status.active_generation?.model
    || DEFAULT_MODEL;
  const modelInstalledValue = ollama.modelInstalled
    ?? ollama.model_installed
    ?? ollama.modelAvailable
    ?? ollama.model_available
    ?? status.modelInstalled
    ?? status.model_installed
    ?? status.modelAvailable
    ?? status.model_available;
  const modelInstalled = modelInstalledValue === true
    ? true
    : modelInstalledValue === false
      ? false
      : null;
  const indexed = asCount(
    status.indexed
      ?? status.indexedCount
      ?? status.indexed_count
      ?? status.completed,
  );
  const total = asCount(
    status.total
      ?? status.totalCount
      ?? status.total_count
      ?? status.saveCount
      ?? status.save_count,
  );
  const waiting = asCount(status.waiting ?? status.pending);
  const indexing = asCount(status.indexing ?? status.running);
  const failed = asCount(status.failed ?? status.failureCount ?? status.failure_count);
  const explicitProgress = Number(status.percentage ?? status.percent ?? status.progress);
  const percent = Number.isFinite(explicitProgress)
    ? Math.max(0, Math.min(100, Math.round(explicitProgress)))
    : total > 0
      ? Math.max(0, Math.min(100, Math.round((indexed / total) * 100)))
      : 0;
  const paused = Boolean(status.paused);
  const rebuilding = Boolean(
    status.rebuilding
      ?? status.buildingGenerationId
      ?? status.building_generation_id
      ?? status.buildingGeneration,
  );

  return {
    connected,
    healthLabel: connected ? 'Connected' : 'Not connected',
    model,
    modelInstalled,
    modelStatusLabel: modelInstalled === true
      ? 'Installed'
      : modelInstalled === false
        ? 'Not installed'
        : 'Checking',
    installCommand: modelInstalled === false ? `ollama pull ${model}` : null,
    indexed,
    total,
    percent,
    indexLabel: `${indexed.toLocaleString()} / ${total.toLocaleString()} saves`,
    progressLabel: `${percent}%`,
    waiting,
    indexing,
    failed,
    queueLabel: `${waiting.toLocaleString()} waiting · ${indexing.toLocaleString()} indexing · ${failed.toLocaleString()} failed`,
    currentTitle: status.currentTitle
      || status.current_title
      || status.current?.title
      || status.currentJob?.title
      || null,
    paused,
    pauseReason: status.pauseReason || status.pause_reason || null,
    queueActionLabel: paused ? 'Resume' : 'Pause',
    rebuilding,
    rebuildActionLabel: rebuilding ? 'Cancel rebuild' : 'Rebuild index',
    canRetryFailed: failed > 0,
  };
}

export function deriveSemanticActionAvailability(api) {
  const methods = [
    'status',
    'queue',
    'pause',
    'resume',
    'retryFailed',
    'dismissFailed',
    'startRebuild',
    'cancelRebuild',
  ];
  return Object.fromEntries(methods.map((method) => [method, typeof api?.[method] === 'function']));
}

export function semanticActionFailure(result) {
  if (!result || result.ok !== false) return null;
  const detail = [result.detail, result.message, result.error]
    .find((value) => typeof value === 'string' && value.trim());
  if (detail) return detail.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240);
  return sentenceCase(result.reason || 'Action failed');
}

export function claimSemanticAction(busyRef, api, method) {
  if (!busyRef || busyRef.current || typeof api?.[method] !== 'function') return false;
  busyRef.current = true;
  return true;
}

export function createSemanticRefreshController({
  load,
  apply,
  onError = () => {},
  schedule = (callback) => queueMicrotask(callback),
} = {}) {
  let mounted = true;
  let generation = 0;
  let scheduled = false;

  async function refresh() {
    if (!mounted) return { applied: false, reason: 'disposed' };
    const requestGeneration = ++generation;
    try {
      const value = await load();
      if (!mounted || requestGeneration !== generation) {
        return { applied: false, reason: mounted ? 'stale' : 'disposed' };
      }
      apply(value);
      return { applied: true };
    } catch (error) {
      if (mounted && requestGeneration === generation) onError(error);
      return { applied: false, reason: 'failed', error };
    }
  }

  function scheduleRefresh() {
    if (!mounted || scheduled) return false;
    scheduled = true;
    schedule(async () => {
      scheduled = false;
      if (!mounted) return { applied: false, reason: 'disposed' };
      return refresh();
    });
    return true;
  }

  return {
    refresh,
    scheduleRefresh,
    isActive: () => mounted,
    dispose() {
      mounted = false;
      generation += 1;
      scheduled = false;
    },
  };
}

export function deriveSemanticQueuePage(queue, requestedCount = QUEUE_PAGE_SIZE, apiAvailable = true) {
  const items = Array.isArray(queue) ? queue : [];
  const normalizedCount = Math.max(
    QUEUE_PAGE_SIZE,
    Number.isFinite(Number(requestedCount)) ? Math.floor(Number(requestedCount)) : QUEUE_PAGE_SIZE,
  );
  const visibleCount = Math.min(items.length, normalizedCount);
  const remaining = Math.max(0, items.length - visibleCount);
  return {
    showToggle: Boolean(apiAvailable),
    items: apiAvailable ? items.slice(0, visibleCount) : [],
    visibleCount,
    remaining,
    nextVisibleCount: Math.min(items.length, normalizedCount + QUEUE_PAGE_SIZE),
  };
}

export function deriveSemanticQueueView(input) {
  const jobs = Array.isArray(input)
    ? input
    : Array.isArray(input?.jobs)
      ? input.jobs
      : Array.isArray(input?.items)
        ? input.items
        : Array.isArray(input?.queue)
          ? input.queue
          : [];

  return jobs
    .filter((job) => {
      const domain = String(job?.domain || job?.queue || '').toLowerCase().replaceAll('_', '-');
      const kind = String(job?.kind || '').toLowerCase().replaceAll('_', '-');
      const state = String(job?.state || job?.status || 'pending').toLowerCase();
      const semanticDomain = ['semantic', 'semantic-index'].includes(domain);
      const semanticKind = ['incremental', 'rebuild', 'semantic', 'semantic-index'].includes(kind);
      return !domain.includes('video')
        && !kind.includes('video')
        && (semanticDomain || (!domain && semanticKind))
        && !['completed', 'dismissed', 'cancelled'].includes(state);
    })
    .map((job) => {
      const stateValue = String(job.state || job.status || 'pending').toLowerCase();
      const state = stateValue === 'pending'
        ? 'Waiting'
        : stateValue === 'running'
          ? 'Indexing'
          : sentenceCase(stateValue);
      return {
        id: job.id || job.jobId || job.job_id || job.saveId || job.save_id,
        title: job.title || job.saveTitle || job.save_title || 'Untitled save',
        state,
        stateValue,
        retryCount: asCount(job.retryCount ?? job.retry_count),
        failureReason: job.failureReason || job.failure_reason || job.error || null,
      };
    });
}

function getSemanticApi() {
  return typeof window !== 'undefined' ? window.moodmark?.semanticIndex : null;
}

export default function SemanticIndexSettings() {
  const [status, setStatus] = React.useState(null);
  const [queue, setQueue] = React.useState([]);
  const [expanded, setExpanded] = React.useState(false);
  const [visibleQueueCount, setVisibleQueueCount] = React.useState(QUEUE_PAGE_SIZE);
  const [busyAction, setBusyAction] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const refreshControllerRef = React.useRef(null);
  const busyRef = React.useRef(false);

  React.useEffect(() => {
    const moodmark = typeof window !== 'undefined' ? window.moodmark : null;
    const controller = createSemanticRefreshController({
      async load() {
        const api = getSemanticApi();
        if (typeof api?.status !== 'function' || typeof api?.queue !== 'function') {
          return { status: null, queue: [] };
        }
        const [nextStatus, nextQueue] = await Promise.all([api.status(), api.queue()]);
        return { status: nextStatus, queue: deriveSemanticQueueView(nextQueue) };
      },
      apply(snapshot) {
        setStatus(snapshot.status);
        setQueue(snapshot.queue);
        setError(null);
      },
      onError(nextError) {
        setError(nextError?.message || 'Could not load semantic index status');
      },
    });
    refreshControllerRef.current = controller;
    controller.refresh();

    const unsubscribers = SEMANTIC_EVENTS.map((eventName) => {
      if (!moodmark?.on) return null;
      try {
        return moodmark.on(eventName, (payload) => {
          if (!controller.isActive()) return;
          if (eventName === 'semantic-index:notice') {
            setNotice(semanticNoticeMessage(payload));
          }
          controller.scheduleRefresh();
        });
      } catch {
        return null;
      }
    });

    return () => {
      controller.dispose();
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
      unsubscribers.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') unsubscribe();
      });
    };
  }, []);

  React.useEffect(() => {
    setVisibleQueueCount((current) => {
      if (queue.length <= QUEUE_PAGE_SIZE) return QUEUE_PAGE_SIZE;
      return Math.max(QUEUE_PAGE_SIZE, Math.min(current, Math.ceil(queue.length / QUEUE_PAGE_SIZE) * QUEUE_PAGE_SIZE));
    });
  }, [queue.length]);

  async function runAction(name, method, ids) {
    const api = getSemanticApi();
    if (!claimSemanticAction(busyRef, api, method)) return;
    setBusyAction(name);
    setError(null);
    try {
      const result = await api[method](...(ids ? [ids] : []));
      const failure = semanticActionFailure(result);
      if (failure) {
        setError(failure);
        return;
      }
      await refreshControllerRef.current?.refresh();
    } catch (nextError) {
      if (refreshControllerRef.current?.isActive()) {
        setError(nextError?.message || `Could not ${name}`);
      }
    } finally {
      busyRef.current = false;
      if (refreshControllerRef.current?.isActive()) setBusyAction(null);
    }
  }

  const view = deriveSemanticIndexView(status);
  const actions = deriveSemanticActionAvailability(getSemanticApi());
  const apiAvailable = actions.status && actions.queue;
  const failedIds = queue.filter((job) => job.stateValue === 'failed').map((job) => job.id).filter(Boolean);
  const queueAction = view.paused ? 'resume' : 'pause';
  const rebuildAction = view.rebuilding ? 'cancelRebuild' : 'startRebuild';
  const queuePage = deriveSemanticQueuePage(queue, visibleQueueCount, apiAvailable);

  function toggleQueue() {
    if (expanded) setVisibleQueueCount(QUEUE_PAGE_SIZE);
    setExpanded((value) => !value);
  }

  return (
    <section className={styles.root} aria-labelledby="semantic-index-heading">
      <div className={styles.headingRow}>
        <div>
          <h3 id="semantic-index-heading" className={styles.heading}>Semantic index</h3>
          <p className={styles.hint}>
            Ollama indexes saved text locally so search can match by meaning.
          </p>
        </div>
        <span className={`${styles.health} ${view.connected ? styles.healthConnected : ''}`}>
          {view.connected
            ? <CheckCircle2 size={14} aria-hidden="true" />
            : <AlertCircle size={14} aria-hidden="true" />}
          {view.healthLabel}
        </span>
      </div>

      <div className={styles.statusCard}>
        <dl className={styles.statusGrid}>
          <div>
            <dt>Ollama</dt>
            <dd>{view.healthLabel}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{view.model} · {view.modelStatusLabel}</dd>
          </div>
          <div>
            <dt>Index</dt>
            <dd>{view.indexLabel}</dd>
          </div>
          <div>
            <dt>Queue</dt>
            <dd>{view.queueLabel}</dd>
          </div>
        </dl>

        <div className={styles.progressHeader}>
          <span>Progress</span>
          <span>{view.progressLabel}</span>
        </div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label="Semantic index progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={view.percent}
        >
          <span className={styles.progressFill} style={{ width: `${view.percent}%` }} />
        </div>

        {view.currentTitle && (
          <div className={styles.current}>
            <span>Current</span>
            <strong>{view.currentTitle}</strong>
          </div>
        )}

        {view.pauseReason && (
          <div className={styles.warning}>
            <AlertCircle size={14} aria-hidden="true" />
            {view.pauseReason}
          </div>
        )}

        {view.installCommand && (
          <div className={styles.installNote}>
            <span>Install model</span>
            <code>{view.installCommand}</code>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          disabled={!actions[queueAction] || !!busyAction}
          onClick={() => runAction(
            view.paused ? 'resume indexing' : 'pause indexing',
            queueAction,
          )}
        >
          {view.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {view.queueActionLabel}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!actions[rebuildAction] || !!busyAction}
          onClick={() => runAction(
            view.rebuilding ? 'cancel rebuild' : 'start rebuild',
            rebuildAction,
          )}
        >
          {view.rebuilding ? <XCircle size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {view.rebuildActionLabel}
        </button>
        {failedIds.length > 0 && (
          <>
            <button
              type="button"
              className={styles.button}
              disabled={!actions.retryFailed || !!busyAction}
              onClick={() => runAction('retry failures', 'retryFailed', failedIds)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Retry failed
            </button>
            <button
              type="button"
              className={styles.textButton}
              disabled={!actions.dismissFailed || !!busyAction}
              onClick={() => runAction('dismiss failures', 'dismissFailed', failedIds)}
            >
              Dismiss failed
            </button>
          </>
        )}
      </div>

      {!apiAvailable && (
        <p className={styles.empty}>Semantic index controls are not available in this build.</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      {queuePage.showToggle && <div className={styles.queueSection}>
        <button
          type="button"
          className={styles.queueToggle}
          aria-expanded={expanded}
          onClick={toggleQueue}
        >
          {expanded
            ? <ChevronDown size={15} aria-hidden="true" />
            : <ChevronRight size={15} aria-hidden="true" />}
          Queue details
          <span>{queue.length}</span>
        </button>

        {expanded && (
          <div className={styles.queueList}>
            {queue.length === 0 ? (
              <p className={styles.empty}>No semantic index jobs.</p>
            ) : queuePage.items.map((job) => (
              <article key={job.id} className={styles.queueRow}>
                <div className={styles.queueRowTop}>
                  <strong>{job.title}</strong>
                  <span className={`${styles.state} ${job.stateValue === 'failed' ? styles.stateFailed : ''}`}>
                    {job.state}
                  </span>
                </div>
                <div className={styles.queueMeta}>
                  <span>{job.retryCount === 1 ? '1 retry' : `${job.retryCount} retries`}</span>
                  {job.failureReason && (
                    <span
                      className={styles.failure}
                      aria-label={`Failure: ${job.failureReason}`}
                    >
                      {job.failureReason}
                    </span>
                  )}
                </div>
              </article>
            ))}
            {queuePage.remaining > 0 && (
              <button
                type="button"
                className={styles.showMore}
                onClick={() => setVisibleQueueCount(queuePage.nextVisibleCount)}
              >
                Show more
                <span>{queuePage.remaining.toLocaleString()} remaining</span>
              </button>
            )}
          </div>
        )}
      </div>}
    </section>
  );
}
