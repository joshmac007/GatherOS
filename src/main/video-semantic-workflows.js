const path = require('node:path');

const { createBackgroundWorkCoordinator } = require('./background-work-coordinator');
const { createSemanticIndex } = require('./semantic-index');
const { createSemanticSearch } = require('./semantic-search');
const { createVideoAnalysisService } = require('./video-analysis');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const VIDEO_RETRY_CODES = new Set([
  'codex_session_unavailable',
  'codex_video_unavailable',
  'invalid_video_suggestions',
]);

function isVideoSave(save = {}) {
  if (String(save.kind || '').toLowerCase() === 'video') return true;
  const filePath = save.file_path ?? save.filePath;
  return typeof filePath === 'string' && VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function shouldUseImageAi(save = {}) {
  const filePath = save.file_path ?? save.filePath;
  return !!filePath && !isVideoSave(save);
}

async function cleanupPurgedSaveDerived({ saveIds = [], cleanupSaveDerived, onError = null } = {}) {
  if (typeof cleanupSaveDerived !== 'function') {
    throw new TypeError('Purged-save cleanup requires cleanupSaveDerived');
  }
  const results = await Promise.all(saveIds.map(async (saveId) => {
    try {
      await cleanupSaveDerived(saveId);
      return true;
    } catch (error) {
      if (typeof onError === 'function') onError(error, saveId);
      return false;
    }
  }));
  return { attempted: results.length, failed: results.filter((ok) => !ok).length };
}

function staleEpochError() {
  const error = new Error('Background library epoch is stale');
  error.code = 'library_epoch_stale';
  return error;
}

function createVideoSemanticWorkflows({
  repository,
  ollama,
  codex,
  frameExtractor,
  createSemanticIndexService = createSemanticIndex,
  createSemanticSearchService = createSemanticSearch,
  createVideoAnalysisService: createVideoService = createVideoAnalysisService,
  createCoordinator = createBackgroundWorkCoordinator,
  isForegroundBusy = () => false,
  notify = null,
  getDerivedDirectory = () => null,
  cleanupDerivedSave = async () => {},
  cleanupDerivedAll = async () => {},
  restoreBackupImpl = null,
  now = Date.now,
  maxVideoAttempts = 3,
  baseVideoRetryMs = 5_000,
  maxVideoRetryMs = 15 * 60 * 1_000,
  logger = console,
} = {}) {
  if (!repository || typeof repository.recoverBackgroundJobs !== 'function') {
    throw new TypeError('Video-semantic workflows require a durable repository');
  }
  if (!ollama || typeof ollama.health !== 'function' || typeof ollama.embed !== 'function') {
    throw new TypeError('Video-semantic workflows require an Ollama embedding client');
  }
  if (!codex || typeof codex.hasCodexSession !== 'function') {
    throw new TypeError('Video-semantic workflows require a dedicated Codex facade');
  }

  let epoch = 0;
  let active = null;
  let healthPromise = null;
  let healthPromiseEpoch = null;
  let semanticHealth = {
    ok: null,
    status: 'checking',
    model: ollama.model,
    reason: null,
    setupAction: null,
  };

  function emit(event, payload) {
    if (typeof notify !== 'function') return;
    try {
      const result = notify(event, payload);
      result?.catch?.(() => {});
    } catch {}
  }

  function guardedRepository(boundEpoch) {
    return new Proxy(repository, {
      get(target, property) {
        if (property === 'recoverSemanticIndexJobs') return undefined;
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (boundEpoch !== epoch) throw staleEpochError();
          return Reflect.apply(value, target, args);
        };
      },
    });
  }

  function videoRetryDelay(retryCount) {
    return Math.min(
      maxVideoRetryMs,
      baseVideoRetryMs * (2 ** Math.max(0, Number(retryCount) || 0)),
    );
  }

  function createVideoLane({ boundRepository, videoAnalysis, boundEpoch }) {
    return {
      name: 'video-analysis',
      claimReady(timestamp) {
        return boundRepository.claimVideoAnalysis(timestamp);
      },
      async run(job) {
        try {
          if (!codex.hasCodexSession()) {
            const error = new Error('Codex session is unavailable for video suggestions');
            error.code = 'codex_session_unavailable';
            error.retryable = true;
            throw error;
          }
          const save = boundRepository.getSave(job.save_id);
          if (!save) {
            const error = new Error('Video save no longer exists');
            error.code = 'video_save_missing';
            throw error;
          }
          const result = await videoAnalysis.run({
            job,
            save,
            acceptedTags: boundRepository.getTagsForSave(job.save_id) || [],
          });
          if (result?.status === 'stale') {
            await videoAnalysis.prepare({ save });
          }
          if (boundEpoch !== epoch) return { ok: false, reason: 'library_epoch_stale' };
          emit('video-analysis:status', { saveId: job.save_id, ...result });
          return result;
        } catch (error) {
          if (error?.code === 'library_epoch_stale' || boundEpoch !== epoch) {
            return { ok: false, reason: 'library_epoch_stale' };
          }
          const attempt = (Number(job.retry_count) || 0) + 1;
          const retryableError = error?.retryable === true || VIDEO_RETRY_CODES.has(error?.code);
          const retryable = retryableError && attempt < maxVideoAttempts;
          const timestamp = now();
          boundRepository.failVideoAnalysis({
            id: job.id,
            error: error?.message || String(error),
            retryable,
            retryAt: retryable ? timestamp + videoRetryDelay(job.retry_count) : undefined,
            now: timestamp,
          });
          const failure = {
            saveId: job.save_id,
            state: retryable ? 'pending' : 'failed',
            retryable,
            reason: error?.code || 'video_analysis_failed',
            error: error?.message || String(error),
          };
          emit('video-analysis:status', failure);
          return { ok: false, ...failure };
        }
      },
      nextReadyAt() {
        if (typeof boundRepository.getNextVideoAnalysisReadyAt !== 'function') return null;
        return boundRepository.getNextVideoAnalysisReadyAt();
      },
    };
  }

  function bind() {
    const boundEpoch = epoch;
    repository.recoverBackgroundJobs(now());
    const boundRepository = guardedRepository(boundEpoch);
    let coordinator = null;
    const coordinatorBridge = { wake: () => coordinator?.wake() };
    const semanticIndex = createSemanticIndexService({
      repository: boundRepository,
      ollama,
      coordinator: coordinatorBridge,
      notify: emit,
      now,
    });
    const semanticSearch = createSemanticSearchService({ repository: boundRepository, ollama });
    const videoAnalysis = createVideoService({
      repository: boundRepository,
      frameExtractor,
      codex,
      derivedDir: getDerivedDirectory(),
      now,
    });
    const semanticLanes = semanticIndex.createLanes();
    const videoLane = createVideoLane({ boundRepository, videoAnalysis, boundEpoch });
    coordinator = createCoordinator({
      lanes: [videoLane, ...semanticLanes],
      isForegroundBusy,
      now,
      onError(error, context) {
        if (error?.code === 'library_epoch_stale') return;
        try { logger?.error?.('Background workflow failed', error, context); } catch {}
      },
    });
    active = {
      epoch: boundEpoch,
      repository: boundRepository,
      coordinator,
      semanticIndex,
      semanticSearch,
      videoAnalysis,
    };
    semanticHealth = {
      ok: null,
      status: 'checking',
      model: ollama.model,
      reason: null,
      setupAction: null,
    };
    coordinator.start();
    refreshSemanticHealth().catch(() => {});
  }

  function start() {
    if (active) return active;
    epoch += 1;
    bind();
    return active;
  }

  async function deactivate() {
    const previous = active;
    epoch += 1;
    if (!previous) return;
    previous.coordinator.stop();
    await previous.coordinator.whenIdle();
    if (active === previous) active = null;
  }

  async function rebind(action) {
    await deactivate();
    let result;
    let error;
    try {
      result = typeof action === 'function' ? await action() : undefined;
    } catch (cause) {
      error = cause;
    }
    bind();
    if (error) throw error;
    return result;
  }

  async function stopAndDrain() {
    await deactivate();
  }

  async function routeSave(save, { duplicate = false, changed = false } = {}) {
    if (duplicate) return { ok: true, skipped: 'duplicate' };
    if (!active) return { ok: false, reason: 'runtime_not_started' };
    const current = active;
    const persisted = current.repository.getSave(save?.id) || save;
    if (!persisted?.id) return { ok: false, reason: 'save_not_found' };
    let semantic = null;
    let semanticWarning = null;
    try {
      semantic = await current.semanticIndex.enqueue(persisted.id);
      if (semantic?.ok === false) {
        semanticWarning = {
          reason: 'semantic-enqueue-failed',
          detail: semantic.detail || semantic.reason || 'Semantic indexing could not be queued',
        };
      }
    } catch (error) {
      semanticWarning = {
        reason: 'semantic-enqueue-failed',
        detail: error?.message || String(error),
      };
    }
    let video = null;
    if (!changed && isVideoSave(persisted)) {
      try {
        video = await current.videoAnalysis.prepare({ save: persisted });
      } catch (error) {
        if (error?.code !== 'library_epoch_stale') {
          emit('video-analysis:status', {
            saveId: persisted.id,
            state: 'failed',
            reason: error?.code || 'video_prepare_failed',
            error: error?.message || String(error),
          });
        }
        throw error;
      }
    }
    if (current.epoch === epoch) current.coordinator.wake();
    return semanticWarning
      ? { ok: true, semantic, video, semanticWarning }
      : { ok: true, semantic, video };
  }

  function noteActivity() {
    active?.coordinator.noteActivity();
  }

  function whenIdle() {
    return active?.coordinator.whenIdle() || Promise.resolve();
  }

  function serviceFacade(key) {
    return new Proxy({}, {
      get(_target, property) {
        const value = active?.[key]?.[property];
        if (typeof value !== 'function') return value;
        return (...args) => {
          const current = active?.[key]?.[property];
          if (typeof current !== 'function') throw new Error(`${key} service is unavailable`);
          return current.apply(active[key], args);
        };
      },
    });
  }

  const semanticIndexFacade = serviceFacade('semanticIndex');
  const semanticSearchFacade = serviceFacade('semanticSearch');

  function getSemanticIndex() {
    return semanticIndexFacade;
  }

  function getSemanticSearch() {
    return semanticSearchFacade;
  }

  function getSemanticHealth() {
    return { ...semanticHealth };
  }

  function refreshSemanticHealth() {
    if (healthPromise && healthPromiseEpoch === epoch) return healthPromise;
    const healthEpoch = epoch;
    const pending = Promise.resolve()
      .then(() => ollama.health())
      .then((result) => {
        if (healthEpoch === epoch) {
          semanticHealth = {
            ok: true,
            status: 'connected',
            model: result?.model || ollama.model,
            reason: null,
            setupAction: null,
          };
          emit('semantic-index:status', semanticHealth);
        }
        return getSemanticHealth();
      })
      .catch((error) => {
        if (healthEpoch === epoch) {
          semanticHealth = {
            ok: false,
            status: error?.code === 'ollama_model_missing' ? 'model-missing' : 'unavailable',
            model: ollama.model,
            reason: error?.code || 'ollama_unavailable',
            setupAction: error?.setupAction || null,
          };
          emit('semantic-index:status', semanticHealth);
        }
        return getSemanticHealth();
      })
      .finally(() => {
        if (healthPromise === pending) {
          healthPromise = null;
          healthPromiseEpoch = null;
        }
      });
    healthPromise = pending;
    healthPromiseEpoch = healthEpoch;
    return healthPromise;
  }

  async function cleanupSaveDerived(saveId) {
    await cleanupDerivedSave(getDerivedDirectory(), saveId);
  }

  async function cleanupAllDerived() {
    await cleanupDerivedAll(getDerivedDirectory());
  }

  async function restoreBackup(snapshotPath) {
    if (typeof restoreBackupImpl !== 'function') {
      return { ok: false, reason: 'restore_unavailable' };
    }
    const result = await rebind(() => restoreBackupImpl(snapshotPath));
    if (result?.ok) emit('library:switched', { reason: 'restore' });
    return result;
  }

  return {
    start,
    rebind,
    stopAndDrain,
    routeSave,
    noteActivity,
    whenIdle,
    getSemanticIndex,
    getSemanticSearch,
    getSemanticHealth,
    refreshSemanticHealth,
    cleanupSaveDerived,
    cleanupAllDerived,
    restoreBackup,
    get epoch() { return epoch; },
  };
}

module.exports = {
  createVideoSemanticWorkflows,
  cleanupPurgedSaveDerived,
  isVideoSave,
  shouldUseImageAi,
};
