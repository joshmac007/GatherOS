const test = require('node:test');
const assert = require('node:assert/strict');

const { createSemanticIndex } = require('../src/main/semantic-index');

function makeRepository() {
  const saves = [
    { id: 'save-a', title: 'Alpha' },
    { id: 'save-b', title: 'Beta' },
  ];
  const jobs = [];
  const calls = {
    manifests: [], enqueued: [], cancelled: [], completed: [], recoveredSemantic: 0,
    genericRecovery: 0, allSaves: 0,
  };
  const state = {
    active_generation_id: 'gen-old',
    building_generation_id: null,
    paused: false,
  };
  return {
    saves,
    jobs,
    calls,
    state,
    repository: {
      recoverSemanticIndexJobs() { calls.recoveredSemantic += 1; return { semantic: 1 }; },
      recoverBackgroundJobs() {
        calls.genericRecovery += 1;
        throw new Error('semantic constructor must not recover video jobs');
      },
      getSemanticIndexState: () => ({ ...state }),
      getSemanticIndexStatus: () => ({
        ...state,
        active_model: 'embeddinggemma',
        active_dimension: 2,
        indexed: 2,
        total: 2,
        waiting: jobs.length,
        running: 0,
        failed: 0,
      }),
      getActiveSemanticIndexIdentity: () => ({
        generation_id: 'gen-old', model: 'embeddinggemma', dimension: 2,
      }),
      listSemanticIndexJobs: () => jobs,
      getAllSaves: () => { calls.allSaves += 1; return saves; },
      getSave: (id) => saves.find((save) => save.id === id),
      getTagsForSave: () => [],
      getSaveTopicProfile: () => undefined,
      getSemanticVector: () => undefined,
      getActiveSemanticVectors() {
        throw new Error('status must not materialize vector BLOBs');
      },
      createSemanticRebuild(input) {
        calls.manifests.push(input);
        state.building_generation_id = input.id;
        for (const job of input.jobs) {
          this.enqueueSemanticIndexJob({
            generationId: input.id,
            saveId: job.saveId,
            kind: 'rebuild',
            sourceHash: job.sourceHash,
            now: input.createdAt,
          });
        }
        return { id: input.id, model: input.model, status: 'building' };
      },
      enqueueSemanticIndexJob(input) {
        calls.enqueued.push(input);
        const existing = jobs.find((job) =>
          job.generation_id === input.generationId
          && job.save_id === input.saveId
          && job.kind === input.kind);
        if (existing) {
          existing.source_hash = input.sourceHash;
          existing.state = 'pending';
          existing.retry_count = 0;
          existing.available_at = input.now;
          return existing;
        }
        const job = {
          id: `job-${jobs.length + 1}`,
          generation_id: input.generationId,
          save_id: input.saveId,
          kind: input.kind,
          source_hash: input.sourceHash,
          state: 'pending',
          retry_count: 0,
          available_at: input.now,
        };
        jobs.push(job);
        return job;
      },
      claimSemanticIndexJob(kind) {
        const job = jobs.find((candidate) => candidate.kind === kind && candidate.state === 'pending');
        if (!job) return undefined;
        job.state = 'running';
        return { ...job };
      },
      completeSemanticIndexJob(input) {
        calls.completed.push(input);
        const stored = jobs.find((job) => job.id === input.id);
        stored.state = 'completed';
        if (jobs.every((job) => job.generation_id !== stored.generation_id || job.state === 'completed')) {
          state.active_generation_id = stored.generation_id;
          state.building_generation_id = null;
        }
        return { ok: true, saveId: stored.save_id, generationId: stored.generation_id };
      },
      failSemanticIndexJob: () => ({ ok: true }),
      pauseSemanticIndex(input) { state.paused = true; state.pause_reason = input.reason; return { ...state }; },
      resumeSemanticIndex() { state.paused = false; state.pause_reason = null; return { ...state }; },
      cancelSemanticGeneration(id) {
        calls.cancelled.push(id);
        if (id !== state.building_generation_id) return { ok: false, reason: 'not_building' };
        state.building_generation_id = null;
        return { ok: true };
      },
      retrySemanticFailures: (ids) => ({ ok: true, count: ids.length }),
      dismissSemanticFailures: (ids) => ({ ok: true, count: ids.length }),
    },
  };
}

test('construction recovers only semantic jobs and wakes coordinator', () => {
  const fixture = makeRepository();
  let wakes = 0;
  createSemanticIndex({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', health: async () => ({ ok: true }), embed: async () => [1] },
    coordinator: { wake: () => { wakes += 1; } },
    now: () => 10,
  });

  assert.equal(fixture.calls.recoveredSemantic, 1);
  assert.equal(fixture.calls.genericRecovery, 0);
  assert.equal(wakes, 1);
});

test('explicit rebuild creates isolated generation and enqueues every canonical save', () => {
  const fixture = makeRepository();
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', health: async () => ({ ok: true }), embed: async () => [1, 0] },
    now: () => 20,
    randomUUID: () => 'gen-new',
    sourceVersion: 7,
  });

  const result = index.startRebuild();

  assert.equal(result.ok, true);
  assert.equal(fixture.calls.manifests.length, 1);
  assert.deepEqual(fixture.calls.manifests[0], {
    id: 'gen-new',
    model: 'embeddinggemma',
    sourceVersion: 7,
    createdAt: 20,
    jobs: fixture.calls.manifests[0].jobs,
  });
  assert.deepEqual(fixture.calls.manifests[0].jobs.map(({ saveId }) => saveId), ['save-a', 'save-b']);
  assert.equal(fixture.calls.enqueued.length, 2);
  assert.deepEqual(fixture.calls.enqueued.map((job) => job.kind), ['rebuild', 'rebuild']);
  assert.deepEqual(new Set(fixture.calls.enqueued.map((job) => job.generationId)), new Set(['gen-new']));
  assert.equal(fixture.state.active_generation_id, 'gen-old');
  assert.equal(fixture.state.building_generation_id, 'gen-new');
});

test('rebuild activation is delegated to repository only after final completed save', async () => {
  const fixture = makeRepository();
  const notices = [];
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async (text) => text.includes('Alpha') ? [1, 0] : [0, 1],
    },
    now: () => 30,
    randomUUID: () => 'gen-complete',
    notify: (event, payload) => notices.push({ event, payload }),
  });
  index.startRebuild();
  const rebuildLane = index.createLanes()[1];

  await rebuildLane.run(rebuildLane.claimReady(30));
  assert.equal(fixture.state.active_generation_id, 'gen-old');
  assert.equal(fixture.state.building_generation_id, 'gen-complete');

  await rebuildLane.run(rebuildLane.claimReady(30));
  assert.equal(fixture.state.active_generation_id, 'gen-complete');
  assert.equal(fixture.state.building_generation_id, null);
  assert.equal(fixture.calls.completed.length, 2);
  assert.equal('activate' in fixture.calls.completed[0], false);
  assert.deepEqual(
    notices.filter(({ event }) => event === 'semantic-index:notice'),
    [{
      event: 'semantic-index:notice',
      payload: {
        type: 'rebuild-complete',
        generationId: 'gen-complete',
        message: 'Semantic index rebuild complete.',
      },
    }],
  );
});

test('save mutation reopens completed building job before generation can activate', async () => {
  const fixture = makeRepository();
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async (text) => text.includes('Alpha changed') ? [0.5, 0.5] : [1, 0],
    },
    now: () => 35,
    randomUUID: () => 'gen-refresh',
  });
  index.startRebuild();
  const rebuildLane = index.createLanes()[1];
  const firstA = fixture.jobs.find((job) => job.kind === 'rebuild' && job.save_id === 'save-a');
  const originalHash = firstA.source_hash;
  firstA.state = 'running';
  await rebuildLane.run({ ...firstA });
  assert.equal(firstA.state, 'completed');

  fixture.saves[0].title = 'Alpha changed';
  index.enqueue('save-a');
  const refreshedA = fixture.jobs.find((job) => job.kind === 'rebuild' && job.save_id === 'save-a');
  assert.equal(refreshedA.state, 'pending');
  assert.notEqual(refreshedA.source_hash, originalHash);

  const saveB = fixture.jobs.find((job) => job.kind === 'rebuild' && job.save_id === 'save-b');
  saveB.state = 'running';
  await rebuildLane.run({ ...saveB });
  assert.equal(fixture.state.active_generation_id, 'gen-old');
  assert.equal(fixture.state.building_generation_id, 'gen-refresh');

  refreshedA.state = 'running';
  await rebuildLane.run({ ...refreshedA });
  assert.equal(fixture.state.active_generation_id, 'gen-refresh');
  assert.equal(fixture.state.building_generation_id, null);
});

test('post-embed revision change discards stale result and queues latest hash', async () => {
  const fixture = makeRepository();
  let changed = false;
  fixture.repository.getTagsForSave = () => changed ? [{ name: 'new-tag' }] : [];
  const originalEnqueue = fixture.repository.enqueueSemanticIndexJob;
  fixture.repository.enqueueSemanticIndexJob = (input) => {
    const existing = fixture.jobs.find((job) =>
      job.generation_id === input.generationId && job.save_id === input.saveId && job.kind === input.kind);
    if (existing) {
      fixture.calls.enqueued.push(input);
      existing.source_hash = input.sourceHash;
      existing.state = 'pending';
      return existing;
    }
    return originalEnqueue(input);
  };
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async () => { changed = true; return [1, 0]; },
    },
    now: () => 40,
  });
  index.enqueue('save-a');
  const lane = index.createLanes()[0];

  const result = await lane.run(lane.claimReady(40));

  assert.deepEqual(result, { ok: true, stale: true, requeued: true });
  assert.equal(fixture.calls.completed.length, 0);
  assert.equal(fixture.jobs[0].state, 'pending');
});

test('pause, resume, cancel, retry, dismiss, status, and queue delegate durably', () => {
  const fixture = makeRepository();
  const notices = [];
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', health: async () => ({ ok: true }), embed: async () => [1] },
    notify: (event, payload) => notices.push({ event, payload }),
    now: () => 50,
  });
  index.startRebuild();

  assert.equal(index.pause('user').paused, true);
  assert.equal(index.resume().paused, false);
  assert.deepEqual(index.retryFailed(['failed-1']), { ok: true, count: 1 });
  assert.deepEqual(index.dismissFailed(['failed-2']), { ok: true, count: 1 });
  assert.equal(index.queue().length, 2);
  const allSavesBeforeStatus = fixture.calls.allSaves;
  const status = index.status();
  assert.equal(status.building_generation_id, fixture.state.building_generation_id);
  assert.equal(status.searchReady, true);
  assert.equal(status.active_model, 'embeddinggemma');
  assert.equal(status.indexed, 2);
  assert.equal(fixture.calls.allSaves, allSavesBeforeStatus);

  const changedModelIndex = createSemanticIndex({
    repository: fixture.repository,
    ollama: { model: 'nomic-embed-text', health: async () => ({ ok: true }), embed: async () => [1] },
    now: () => 50,
  });
  const changedModelStatus = changedModelIndex.status();
  assert.equal(changedModelStatus.searchReady, false);
  assert.equal(changedModelStatus.active_model, 'embeddinggemma');
  assert.equal(fixture.calls.allSaves, allSavesBeforeStatus);
  assert.deepEqual(index.cancelRebuild(), { ok: true });
  assert.equal(fixture.state.active_generation_id, 'gen-old');
  assert.equal(fixture.state.building_generation_id, null);
  assert.equal(notices.some(({ event }) => event === 'semantic-index:status'), true);
});
