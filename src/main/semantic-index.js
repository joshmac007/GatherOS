const crypto = require('node:crypto');

const { validateVector } = require('./ollama-embed-client');
const { buildSemanticSource } = require('./semantic-source');

const RUNTIME_PAUSE_CODES = new Set([
  'ollama_unavailable',
  'ollama_model_missing',
]);

const TRANSIENT_CODES = new Set([
  'ollama_unavailable',
  'ollama_model_missing',
  'ollama_timeout',
]);

function errorCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'semantic_index_failed';
}

function errorMessage(error) {
  return typeof error?.message === 'string' && error.message ? error.message : String(error);
}

function decodeStoredVector(value, dimension) {
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new Error('Stored semantic vector dimension is invalid');
  }
  if (Buffer.isBuffer(value)) {
    if (value.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('Stored semantic vector payload length is invalid');
    }
    return Array.from(
      { length: dimension },
      (_, index) => value.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT),
    );
  }
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    const vector = Array.from(value);
    if (vector.length !== dimension) {
      throw new Error('Stored semantic vector payload length is invalid');
    }
    return vector;
  }
  throw new Error('Stored semantic vector payload is invalid');
}

function createSemanticIndex({
  repository,
  ollama,
  coordinator = null,
  notify = null,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  sourceVersion = 1,
  maxAttempts = 3,
  baseRetryMs = 1_000,
  maxRetryMs = 15 * 60 * 1_000,
} = {}) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('Semantic index requires a repository');
  }
  if (!ollama || typeof ollama.embed !== 'function' || typeof ollama.health !== 'function') {
    throw new TypeError('Semantic index requires an Ollama embedding client');
  }
  if (!ollama.model) throw new TypeError('Semantic index requires an Ollama model');

  const attemptsCap = Math.max(1, Number(maxAttempts) || 1);
  const retryBase = Math.max(0, Number(baseRetryMs) || 0);
  const retryCap = Math.max(retryBase, Number(maxRetryMs) || retryBase);
  let healthVerified = false;

  function wake() {
    coordinator?.wake?.();
  }

  function emit(event, payload) {
    if (typeof notify !== 'function') return;
    try {
      const result = notify(event, payload);
      result?.catch?.(() => {});
    } catch {}
  }

  function sourceFor(saveId) {
    const save = repository.getSave(saveId);
    if (!save) return null;
    return buildSemanticSource({
      save,
      tags: repository.getTagsForSave(saveId) || [],
      topicProfile: repository.getSaveTopicProfile(saveId) || {},
    });
  }

  function queue(filters) {
    return repository.listSemanticIndexJobs(filters);
  }

  function status() {
    const result = repository.getSemanticIndexStatus();
    const running = queue({ state: 'running' })[0];
    const current = running && typeof repository.getSave === 'function'
      ? repository.getSave(running.save_id)
      : null;
    return {
      ...result,
      model: ollama.model,
      current: current ? { id: current.id, title: current.title || '' } : null,
      searchReady: !!result.active_generation_id
        && result.active_model === ollama.model,
    };
  }

  function emitStatus() {
    const snapshot = status();
    emit('semantic-index:status', snapshot);
    return snapshot;
  }

  function enqueue(saveId) {
    const state = repository.getSemanticIndexState();
    const source = sourceFor(saveId);
    if (!source) return { ok: false, reason: 'save_not_found' };

    let rebuildJob = null;
    if (state.building_generation_id) {
      rebuildJob = repository.enqueueSemanticIndexJob({
        generationId: state.building_generation_id,
        saveId,
        kind: 'rebuild',
        sourceHash: source.sourceHash,
        now: now(),
      });
    }

    const current = state.active_generation_id
      ? repository.getSemanticVector(saveId)
      : null;
    const activeIdentity = state.active_generation_id
      ? repository.getActiveSemanticIndexIdentity()
      : null;
    const activeModel = current?.model || activeIdentity?.model || null;
    const unchanged = current
      && current.generation_id === state.active_generation_id
      && current.source_hash === source.sourceHash;
    let job = null;
    if (state.active_generation_id && !unchanged && (!activeModel || activeModel === ollama.model)) {
      job = repository.enqueueSemanticIndexJob({
        generationId: state.active_generation_id,
        saveId,
        kind: 'incremental',
        sourceHash: source.sourceHash,
        now: now(),
      });
    }

    if (!job && !rebuildJob) {
      if (!state.active_generation_id) return { ok: false, reason: 'no_active_generation' };
      if (activeModel && activeModel !== ollama.model) {
        return { ok: false, reason: 'active_model_unavailable', model: activeModel };
      }
      return { ok: true, skipped: 'unchanged' };
    }
    wake();
    emitStatus();
    return {
      ok: true,
      job,
      rebuildJob,
      ...(unchanged ? { skipped: 'unchanged' } : {}),
    };
  }

  function startRebuild({ model = ollama.model } = {}) {
    if (model !== ollama.model) {
      return { ok: false, reason: 'model_client_mismatch', model };
    }
    const timestamp = now();
    const generationId = randomUUID();
    const jobs = [];
    for (const save of repository.getAllSaves({})) {
      const source = sourceFor(save.id);
      if (!source) continue;
      jobs.push({
        saveId: save.id,
        sourceHash: source.sourceHash,
      });
    }
    if (jobs.length === 0) return { ok: false, reason: 'no_saves' };

    let generation;
    try {
      generation = repository.createSemanticRebuild({
        id: generationId,
        model,
        sourceVersion,
        createdAt: timestamp,
        jobs,
      });
    } catch (error) {
      return { ok: false, reason: 'manifest_failed', error: errorMessage(error) };
    }
    if (generation?.ok === false) return generation;

    healthVerified = false;
    wake();
    emitStatus();
    return { ok: true, generation, count: jobs.length };
  }

  function pause(reason = 'user') {
    const result = repository.pauseSemanticIndex({ reason, now: now() });
    emitStatus();
    return result;
  }

  function resume() {
    healthVerified = false;
    const result = repository.resumeSemanticIndex(now());
    wake();
    emitStatus();
    return result;
  }

  function cancelRebuild(generationId) {
    const target = generationId || repository.getSemanticIndexState().building_generation_id;
    if (!target) return { ok: false, reason: 'no_building_generation' };
    const result = repository.cancelSemanticGeneration(target, now());
    emitStatus();
    return result;
  }

  function retryFailed(ids) {
    const result = repository.retrySemanticFailures(ids, now());
    if (result?.count) wake();
    emitStatus();
    return result;
  }

  function dismissFailed(ids) {
    const result = repository.dismissSemanticFailures(ids, now());
    emitStatus();
    return result;
  }

  async function ensureHealth() {
    if (healthVerified) return;
    await ollama.health();
    healthVerified = true;
  }

  function retryDelay(retryCount) {
    return Math.min(retryCap, retryBase * (2 ** Math.max(0, retryCount)));
  }

  function failJob(job, error) {
    const timestamp = now();
    const code = errorCode(error);
    const attempt = (Number(job.retry_count) || 0) + 1;
    const retryableError = error?.retryable === true || TRANSIENT_CODES.has(code);
    const retryable = retryableError && attempt < attemptsCap;
    repository.failSemanticIndexJob({
      id: job.id,
      error: errorMessage(error),
      retryable,
      retryAt: retryable ? timestamp + retryDelay(job.retry_count) : undefined,
      now: timestamp,
    });
    if (RUNTIME_PAUSE_CODES.has(code)) {
      healthVerified = false;
      repository.pauseSemanticIndex({ reason: code, now: timestamp });
      emit('semantic-index:notice', {
        type: 'paused',
        reason: code,
        message: errorMessage(error),
        setupAction: error?.setupAction || null,
      });
    }
    emitStatus();
    return { ok: false, reason: code, retryable };
  }

  function completeJob(job, vector, dimension) {
    const stored = repository.completeSemanticIndexJob({
      id: job.id,
      sourceHash: job.source_hash,
      model: ollama.model,
      dimension,
      vector,
      now: now(),
    });
    if (stored?.ok === false) {
      if (stored.reason === 'stale' || stored.reason === 'not_running') {
        return { ok: true, stale: true, requeued: stored.reason === 'stale' };
      }
      const storageError = Object.assign(
        new Error(`Semantic vector rejected: ${stored.reason || 'unknown'}`),
        { code: stored.reason || 'semantic_vector_rejected' },
      );
      return failJob(job, storageError);
    }

    const snapshot = emitStatus();
    emit('semantic-index:progress', snapshot);
    if (job.kind === 'rebuild' && !snapshot.building_generation_id) {
      emit('semantic-index:notice', { type: 'rebuild-complete', generationId: job.generation_id });
    }
    return stored;
  }

  async function runJob(job) {
    if (!job) return { ok: false, reason: 'no_job' };
    const before = sourceFor(job.save_id);
    if (!before) return failJob(job, new Error('Semantic source save was not found'));
    if (before.sourceHash !== job.source_hash) {
      repository.enqueueSemanticIndexJob({
        generationId: job.generation_id,
        saveId: job.save_id,
        kind: job.kind,
        sourceHash: before.sourceHash,
        now: now(),
      });
      wake();
      emitStatus();
      return { ok: true, stale: true, requeued: true };
    }

    try {
      const existing = job.kind === 'incremental'
        ? repository.getSemanticVector(job.save_id)
        : null;
      if (
        existing
        && existing.generation_id === job.generation_id
        && existing.source_hash === job.source_hash
        && existing.model === ollama.model
        && Number.isInteger(existing.dimension)
        && existing.dimension > 0
      ) {
        try {
          validateVector(decodeStoredVector(existing.vector, existing.dimension), existing.dimension);
          return completeJob(job, existing.vector, existing.dimension);
        } catch {}
      }

      await ensureHealth();
      const expectedDimension = existing?.model === ollama.model
        ? existing.dimension
        : null;
      const vector = await ollama.embed(before.text, { expectedDimension });
      validateVector(vector, expectedDimension);

      const after = sourceFor(job.save_id);
      if (!after) {
        return failJob(
          job,
          Object.assign(new Error('Semantic source save was removed during indexing'), {
            code: 'save_not_found',
          }),
        );
      }
      if (after.sourceHash !== job.source_hash) {
        repository.enqueueSemanticIndexJob({
          generationId: job.generation_id,
          saveId: job.save_id,
          kind: job.kind,
          sourceHash: after.sourceHash,
          now: now(),
        });
        wake();
        emitStatus();
        return { ok: true, stale: true, requeued: true };
      }

      return completeJob(job, Buffer.from(new Float32Array(vector).buffer), vector.length);
    } catch (error) {
      return failJob(job, error);
    }
  }

  function nextReadyAt(kind) {
    const state = repository.getSemanticIndexState();
    if (state.paused) return null;
    const generationId = kind === 'incremental'
      ? state.active_generation_id
      : state.building_generation_id;
    if (!generationId) return null;
    let readyAt = null;
    for (const job of queue({ generationId, kind, state: 'pending' })) {
      if (!Number.isFinite(job.available_at)) continue;
      if (readyAt === null || job.available_at < readyAt) readyAt = job.available_at;
    }
    return readyAt;
  }

  function createLane(kind) {
    return {
      name: `semantic-${kind}`,
      claimReady(timestamp) {
        return repository.claimSemanticIndexJob(kind, timestamp);
      },
      run: runJob,
      nextReadyAt() {
        return nextReadyAt(kind);
      },
    };
  }

  function createLanes() {
    return [createLane('incremental'), createLane('rebuild')];
  }

  if (typeof repository.recoverSemanticIndexJobs === 'function') {
    const recovered = repository.recoverSemanticIndexJobs(now());
    if ((recovered?.semantic || 0) > 0) wake();
  }

  return {
    enqueue,
    startRebuild,
    pause,
    resume,
    cancelRebuild,
    retryFailed,
    dismissFailed,
    status,
    queue,
    createLanes,
  };
}

module.exports = { createSemanticIndex };
