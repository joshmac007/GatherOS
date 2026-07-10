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
const SEMANTIC_EVENTS = [
  'semantic-index:status',
  'semantic-index:progress',
  'semantic-index:notice',
];

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
  const modelInstalled = Boolean(
    ollama.modelInstalled
      ?? ollama.model_installed
      ?? ollama.modelAvailable
      ?? ollama.model_available
      ?? status.modelInstalled
      ?? status.model_installed
      ?? status.modelAvailable
      ?? status.model_available
      ?? connected,
  );
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
    installCommand: `ollama pull ${model}`,
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
      const domain = String(job?.domain || job?.queue || '').toLowerCase();
      const kind = String(job?.kind || '').toLowerCase();
      const state = String(job?.state || job?.status || 'pending').toLowerCase();
      return !domain.includes('video')
        && kind !== 'video'
        && kind !== 'video-analysis'
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
  const [busyAction, setBusyAction] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);

  const refresh = React.useCallback(async () => {
    const api = getSemanticApi();
    if (!api?.status || !api?.queue) {
      setStatus(null);
      setQueue([]);
      return;
    }

    try {
      const [nextStatus, nextQueue] = await Promise.all([api.status(), api.queue()]);
      setStatus(nextStatus);
      setQueue(deriveSemanticQueueView(nextQueue));
      setError(null);
    } catch (nextError) {
      setError(nextError?.message || 'Could not load semantic index status');
    }
  }, []);

  React.useEffect(() => {
    let active = true;
    const guardedRefresh = async () => {
      if (!active) return;
      await refresh();
    };
    guardedRefresh();

    const moodmark = typeof window !== 'undefined' ? window.moodmark : null;
    const unsubscribers = SEMANTIC_EVENTS.map((eventName) => {
      if (!moodmark?.on) return null;
      try {
        return moodmark.on(eventName, (payload) => {
          if (!active) return;
          if (eventName === 'semantic-index:notice') {
            setNotice(
              typeof payload === 'string'
                ? payload
                : payload?.message || payload?.notice || null,
            );
          }
          guardedRefresh();
        });
      } catch {
        return null;
      }
    });

    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') unsubscribe();
      });
    };
  }, [refresh]);

  async function runAction(name, method, ids) {
    const api = getSemanticApi();
    if (typeof api?.[method] !== 'function' || busyAction) return;
    setBusyAction(name);
    setError(null);
    try {
      await api[method](...(ids ? [ids] : []));
      await refresh();
    } catch (nextError) {
      setError(nextError?.message || `Could not ${name}`);
    } finally {
      setBusyAction(null);
    }
  }

  const view = deriveSemanticIndexView(status);
  const apiAvailable = Boolean(getSemanticApi()?.status && getSemanticApi()?.queue);
  const failedIds = queue.filter((job) => job.stateValue === 'failed').map((job) => job.id).filter(Boolean);

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
            <dd>{view.model}</dd>
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

        {!view.modelInstalled && (
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
          disabled={!apiAvailable || !!busyAction}
          onClick={() => runAction(
            view.paused ? 'resume indexing' : 'pause indexing',
            view.paused ? 'resume' : 'pause',
          )}
        >
          {view.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {view.queueActionLabel}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!apiAvailable || !!busyAction}
          onClick={() => runAction(
            view.rebuilding ? 'cancel rebuild' : 'start rebuild',
            view.rebuilding ? 'cancelRebuild' : 'startRebuild',
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
              disabled={!!busyAction}
              onClick={() => runAction('retry failures', 'retryFailed', failedIds)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Retry failed
            </button>
            <button
              type="button"
              className={styles.textButton}
              disabled={!!busyAction}
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

      <div className={styles.queueSection}>
        <button
          type="button"
          className={styles.queueToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
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
            ) : queue.map((job) => (
              <article key={job.id} className={styles.queueRow}>
                <div className={styles.queueRowTop}>
                  <strong>{job.title}</strong>
                  <span className={`${styles.state} ${job.stateValue === 'failed' ? styles.stateFailed : ''}`}>
                    {job.state}
                  </span>
                </div>
                <div className={styles.queueMeta}>
                  <span>{job.retryCount === 1 ? '1 retry' : `${job.retryCount} retries`}</span>
                  {job.failureReason && <span className={styles.failure}>{job.failureReason}</span>}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
