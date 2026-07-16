'use strict';

const crypto = require('node:crypto');
const { buildSemanticSource } = require('./semantic-source');
const { validateVector, vectorToBuffer } = require('./smart-category-vectors');

function errorCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'semantic_index_failed';
}

function isRuntimePause(error) {
  return error?.pauseProvider === true || /(?:unavailable|model_missing)$/.test(errorCode(error));
}

function decodeStoredVector(value, dimension) {
  if (!Number.isInteger(dimension) || dimension < 1) throw new Error('Stored semantic vector dimension is invalid');
  if (Buffer.isBuffer(value)) {
    if (value.byteLength !== dimension * 4) throw new Error('Stored semantic vector payload length is invalid');
    return Array.from({ length: dimension }, (_, index) => value.readFloatLE(index * 4));
  }
  return validateVector(value, dimension);
}

function createSemanticIndex({
  repository,
  embeddingProvider,
  coordinator = null,
  notify = null,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  sourceVersion = 1,
  maxAttempts = 3,
  baseRetryMs = 1_000,
  maxRetryMs = 15 * 60 * 1_000,
} = {}) {
  if (!repository || typeof repository !== 'object') throw new TypeError('Semantic index requires a repository');
  if (typeof embeddingProvider?.embed !== 'function' || !embeddingProvider.model) {
    throw new TypeError('Semantic index requires an embedding provider with a model');
  }
  const attemptsCap = Math.max(1, Number(maxAttempts) || 1);
  const retryBase = Math.max(0, Number(baseRetryMs) || 0);
  const retryCap = Math.max(retryBase, Number(maxRetryMs) || retryBase);
  let healthVerified = false;

  function wake() { coordinator?.wake?.(); }
  function emit(event, payload) {
    if (typeof notify !== 'function') return;
    try { notify(event, payload)?.catch?.(() => {}); } catch {}
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
  function queue(filters) { return repository.listSemanticIndexJobs(filters); }
  function status() {
    const result = repository.getSemanticIndexStatus();
    const running = queue({ state: 'running' })[0];
    const current = running ? repository.getSave(running.save_id) : null;
    return {
      ...result,
      model: embeddingProvider.model,
      current: current ? { id: current.id, title: current.title || '' } : null,
      searchReady: !!result.active_generation_id && result.active_model === embeddingProvider.model,
    };
  }
  function emitStatus() { const snapshot = status(); emit('semantic-index:status', snapshot); return snapshot; }

  function enqueue(saveId) {
    const state = repository.getSemanticIndexState();
    const source = sourceFor(saveId);
    if (!source) return { ok: false, reason: 'save_not_found' };
    let rebuildJob = null;
    if (state.building_generation_id) {
      rebuildJob = repository.enqueueSemanticIndexJob({ generationId: state.building_generation_id, saveId, kind: 'rebuild', sourceHash: source.sourceHash, now: now() });
    }
    const current = state.active_generation_id ? repository.getSemanticVector(saveId) : null;
    const activeModel = current?.model || repository.getActiveSemanticIndexIdentity?.()?.model || null;
    const unchanged = current && current.generation_id === state.active_generation_id && current.source_hash === source.sourceHash;
    let job = null;
    if (state.active_generation_id && !unchanged && (!activeModel || activeModel === embeddingProvider.model)) {
      job = repository.enqueueSemanticIndexJob({ generationId: state.active_generation_id, saveId, kind: 'incremental', sourceHash: source.sourceHash, now: now() });
    }
    if (!job && !rebuildJob) {
      if (!state.active_generation_id) return { ok: false, reason: 'no_active_generation' };
      if (activeModel && activeModel !== embeddingProvider.model) return { ok: false, reason: 'active_model_unavailable', model: activeModel };
      return { ok: true, skipped: 'unchanged' };
    }
    wake(); emitStatus();
    return { ok: true, job, rebuildJob, ...(unchanged ? { skipped: 'unchanged' } : {}) };
  }

  function startRebuild({ model = embeddingProvider.model } = {}) {
    if (model !== embeddingProvider.model) return { ok: false, reason: 'model_client_mismatch', model };
    const jobs = repository.getAllSaves({}).map((save) => {
      const source = sourceFor(save.id);
      return source && { saveId: save.id, sourceHash: source.sourceHash };
    }).filter(Boolean);
    if (jobs.length === 0) return { ok: false, reason: 'no_saves' };
    let generation;
    try {
      generation = repository.createSemanticRebuild({ id: randomUUID(), model, sourceVersion, createdAt: now(), jobs });
    } catch (error) {
      return { ok: false, reason: 'manifest_failed', error: error?.message || String(error) };
    }
    if (generation?.ok === false) return generation;
    healthVerified = false; wake(); emitStatus();
    return { ok: true, generation, count: jobs.length };
  }

  function pause(reason = 'user') { const result = repository.pauseSemanticIndex({ reason, now: now() }); emitStatus(); return result; }
  function resume() { healthVerified = false; const result = repository.resumeSemanticIndex(now()); wake(); emitStatus(); return result; }
  function cancelRebuild(generationId) {
    const target = generationId || repository.getSemanticIndexState().building_generation_id;
    if (!target) return { ok: false, reason: 'no_building_generation' };
    const result = repository.cancelSemanticGeneration(target, now()); emitStatus(); return result;
  }
  function retryFailed(ids) { const result = repository.retrySemanticFailures(ids, now()); if (result?.count) wake(); emitStatus(); return result; }
  function dismissFailed(ids) { const result = repository.dismissSemanticFailures(ids, now()); emitStatus(); return result; }
  async function ensureHealth() {
    if (healthVerified) return;
    if (typeof embeddingProvider.health === 'function') await embeddingProvider.health();
    healthVerified = true;
  }
  function retryDelay(retryCount) { return Math.min(retryCap, retryBase * (2 ** Math.max(0, retryCount))); }
  function failJob(job, error) {
    const timestamp = now();
    const code = errorCode(error);
    const attempt = (Number(job.retry_count) || 0) + 1;
    const retryable = error?.retryable === true && attempt < attemptsCap;
    repository.failSemanticIndexJob({
      id: job.id,
      error: error?.message || String(error),
      retryable,
      retryAt: retryable ? timestamp + retryDelay(job.retry_count) : undefined,
      now: timestamp,
    });
    if (isRuntimePause(error)) {
      healthVerified = false;
      repository.pauseSemanticIndex({ reason: code, now: timestamp });
      emit('semantic-index:notice', {
        type: 'paused',
        reason: code,
        message: `Semantic indexing paused because embedding provider is unavailable for model "${embeddingProvider.model}".`,
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
      model: embeddingProvider.model,
      dimension,
      vector,
      now: now(),
    });
    if (stored?.ok === false) {
      if (stored.reason === 'stale' || stored.reason === 'not_running') return { ok: true, stale: true, requeued: stored.reason === 'stale' };
      return failJob(job, Object.assign(new Error(`Semantic vector rejected: ${stored.reason || 'unknown'}`), { code: stored.reason || 'semantic_vector_rejected' }));
    }
    const snapshot = emitStatus();
    emit('semantic-index:progress', snapshot);
    if (job.kind === 'rebuild' && !snapshot.building_generation_id) {
      emit('semantic-index:notice', { type: 'rebuild-complete', generationId: job.generation_id, message: 'Semantic index rebuild complete.' });
    }
    return stored;
  }
  async function runJob(job) {
    if (!job) return { ok: false, reason: 'no_job' };
    const before = sourceFor(job.save_id);
    if (!before) return failJob(job, Object.assign(new Error('Semantic source save was not found'), { code: 'save_not_found' }));
    if (before.sourceHash !== job.source_hash) {
      repository.enqueueSemanticIndexJob({ generationId: job.generation_id, saveId: job.save_id, kind: job.kind, sourceHash: before.sourceHash, now: now() });
      wake(); emitStatus(); return { ok: true, stale: true, requeued: true };
    }
    try {
      const existing = job.kind === 'incremental' ? repository.getSemanticVector(job.save_id) : null;
      if (existing && existing.generation_id === job.generation_id && existing.source_hash === job.source_hash && existing.model === embeddingProvider.model) {
        try { return completeJob(job, existing.vector, validateVector(decodeStoredVector(existing.vector, existing.dimension), existing.dimension).length); } catch {}
      }
      await ensureHealth();
      const result = await embeddingProvider.embed({
        text: before.text,
        expectedDimension: existing?.model === embeddingProvider.model ? existing.dimension : null,
      });
      const vector = validateVector(result?.vector, existing?.model === embeddingProvider.model ? existing.dimension : null);
      const after = sourceFor(job.save_id);
      if (!after || after.sourceHash !== job.source_hash) {
        if (after) repository.enqueueSemanticIndexJob({ generationId: job.generation_id, saveId: job.save_id, kind: job.kind, sourceHash: after.sourceHash, now: now() });
        wake(); emitStatus(); return { ok: true, stale: true, requeued: !!after };
      }
      return completeJob(job, vectorToBuffer(vector), vector.length);
    } catch (error) {
      return failJob(job, error);
    }
  }
  function nextReadyAt(kind) {
    const state = repository.getSemanticIndexState();
    if (state.paused) return null;
    const generationId = kind === 'incremental' ? state.active_generation_id : state.building_generation_id;
    if (!generationId) return null;
    let readyAt = null;
    for (const job of queue({ generationId, kind, state: 'pending' })) {
      if (Number.isFinite(job.available_at) && (readyAt === null || job.available_at < readyAt)) readyAt = job.available_at;
    }
    return readyAt;
  }
  function createLane(kind) {
    return { name: `semantic-${kind}`, claimReady: (timestamp) => repository.claimSemanticIndexJob(kind, timestamp), run: runJob, nextReadyAt: () => nextReadyAt(kind) };
  }
  function createLanes() { return [createLane('incremental'), createLane('rebuild')]; }

  if (typeof repository.recoverSemanticIndexJobs === 'function') {
    const recovered = repository.recoverSemanticIndexJobs(now());
    if ((recovered?.semantic || 0) > 0) wake();
  }
  return { enqueue, startRebuild, pause, resume, cancelRebuild, retryFailed, dismissFailed, status, queue, createLanes };
}

module.exports = { createSemanticIndex };
