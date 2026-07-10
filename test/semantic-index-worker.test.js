const test = require('node:test');
const assert = require('node:assert/strict');

const { createSemanticIndex } = require('../src/main/semantic-index');
const { buildSemanticSource } = require('../src/main/semantic-source');

function makeRepository(overrides = {}) {
  const save = { id: 'save-1', title: 'Aviation dashboard', notes: 'Dark interface' };
  const tags = [{ name: 'aviation' }];
  const jobs = [];
  const calls = { enqueued: [], completed: [], failed: [], paused: [], resumed: 0 };
  const repository = {
    getSemanticIndexState: () => ({
      active_generation_id: 'gen-active',
      building_generation_id: null,
      paused: false,
    }),
    getSemanticIndexStatus: () => ({
      active_generation_id: 'gen-active',
      building_generation_id: null,
      active_model: 'embeddinggemma',
      active_dimension: 3,
      indexed: 1,
      total: 1,
      waiting: jobs.length,
      running: 0,
      failed: 0,
    }),
    getActiveSemanticIndexIdentity: () => ({
      generation_id: 'gen-active', model: 'embeddinggemma', dimension: 3,
    }),
    getActiveSemanticVectors() {
      throw new Error('worker status must not materialize vector BLOBs');
    },
    listSemanticIndexJobs: () => jobs,
    getSave: (id) => id === save.id ? save : undefined,
    getTagsForSave: () => tags,
    getSaveTopicProfile: () => ({ concepts: ['interface design'], summary: 'A dark UI' }),
    getSemanticVector: () => undefined,
    getAllSaves: () => [save],
    enqueueSemanticIndexJob: (input) => {
      calls.enqueued.push(input);
      const existing = jobs.find((job) =>
        job.generation_id === input.generationId &&
        job.save_id === input.saveId &&
        job.kind === input.kind);
      if (existing) {
        existing.source_hash = input.sourceHash;
        existing.state = 'pending';
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
    claimSemanticIndexJob: (kind) => {
      const job = jobs.find((candidate) => candidate.kind === kind && candidate.state === 'pending');
      if (!job) return undefined;
      job.state = 'running';
      return { ...job };
    },
    completeSemanticIndexJob: (input) => {
      calls.completed.push(input);
      return { ok: true, saveId: 'save-1', generationId: 'gen-active' };
    },
    failSemanticIndexJob: (input) => {
      calls.failed.push(input);
      return { ok: true };
    },
    pauseSemanticIndex: (input) => {
      calls.paused.push(input);
      return { paused: true, pause_reason: input.reason };
    },
    resumeSemanticIndex: () => {
      calls.resumed += 1;
      return { paused: false };
    },
    retrySemanticFailures: () => ({ ok: true, count: 0 }),
    dismissSemanticFailures: () => ({ ok: true, count: 0 }),
    cancelSemanticGeneration: () => ({ ok: true }),
    createSemanticRebuild(input) {
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
    ...overrides,
  };
  return { repository, save, tags, jobs, calls };
}

test('enqueue skips unchanged active vector and coalesces latest canonical source hash', () => {
  const fixture = makeRepository();
  const original = buildSemanticSource({
    save: fixture.save,
    tags: fixture.tags,
    topicProfile: fixture.repository.getSaveTopicProfile(),
  });
  fixture.repository.getSemanticVector = () => ({
    generation_id: 'gen-active',
    source_hash: original.sourceHash,
    model: 'embeddinggemma',
    dimension: 3,
  });
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', health: async () => ({ ok: true }), embed: async () => [1, 0, 0] },
    now: () => 100,
  });

  assert.deepEqual(index.enqueue('save-1'), { ok: true, skipped: 'unchanged' });
  fixture.tags.push({ name: 'cockpit' });
  const first = index.enqueue('save-1');
  const firstHash = first.job.source_hash;
  fixture.tags.push({ name: 'minimal' });
  const second = index.enqueue('save-1');

  assert.equal(fixture.jobs.length, 1);
  assert.notEqual(firstHash, second.job.source_hash);
  assert.equal(fixture.jobs[0].source_hash, second.job.source_hash);
});

test('incremental lane embeds and completes exactly one save per run', async () => {
  const fixture = makeRepository();
  const saves = [fixture.save, { id: 'save-2', title: 'Second save' }];
  fixture.repository.getSave = (id) => saves.find((save) => save.id === id);
  fixture.repository.getAllSaves = () => saves;
  const embedded = [];
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async (text, options) => {
        embedded.push({ text, options });
        return [0.25, -0.5, 0.75];
      },
    },
    now: () => 200,
    randomUUID: () => 'gen-building',
  });
  index.startRebuild();

  const lane = index.createLanes()[1];
  const job = lane.claimReady(200);
  await lane.run(job);

  assert.equal(embedded.length, 1);
  assert.equal(fixture.calls.completed.length, 1);
  assert.equal(fixture.calls.completed[0].dimension, 3);
  assert.deepEqual(
    [...new Float32Array(
      fixture.calls.completed[0].vector.buffer,
      fixture.calls.completed[0].vector.byteOffset,
      3,
    )],
    [0.25, -0.5, 0.75],
  );
  assert.equal(fixture.jobs.filter((candidate) => candidate.state === 'pending').length, 1);
});

test('worker recomputes source before embed and replaces stale claim without embedding', async () => {
  const fixture = makeRepository();
  let embedCalls = 0;
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async () => { embedCalls += 1; return [1, 2]; },
    },
    now: () => 300,
  });
  index.enqueue('save-1');
  const [lane] = index.createLanes();
  const stale = lane.claimReady(300);
  fixture.tags.push({ name: 'changed-after-claim' });

  const result = await lane.run(stale);

  assert.deepEqual(result, { ok: true, stale: true, requeued: true });
  assert.equal(embedCalls, 0);
  assert.equal(fixture.calls.completed.length, 0);
  assert.equal(fixture.jobs[0].state, 'pending');
  assert.notEqual(fixture.jobs[0].source_hash, stale.source_hash);
});

test('worker reuses unchanged active vector when source returns to indexed hash before claim', async () => {
  const fixture = makeRepository();
  let embedCalls = 0;
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async () => { embedCalls += 1; return [9, 9]; },
    },
    now: () => 350,
  });
  index.enqueue('save-1');
  const [lane] = index.createLanes();
  const job = lane.claimReady(350);
  fixture.repository.getSemanticVector = () => ({
    generation_id: 'gen-active',
    source_hash: job.source_hash,
    model: 'embeddinggemma',
    dimension: 2,
    vector: Buffer.from(new Float32Array([1, 0]).buffer),
  });

  const result = await lane.run(job);

  assert.equal(result.ok, true);
  assert.equal(embedCalls, 0);
  assert.equal(fixture.calls.completed.length, 1);
  assert.deepEqual(fixture.calls.completed[0].vector, fixture.repository.getSemanticVector().vector);
});

test('worker re-embeds malformed or zero stored vectors instead of reusing them', async () => {
  for (const storedVector of [
    Buffer.alloc(3),
    Buffer.from(new Float32Array([0, 0]).buffer),
  ]) {
    const fixture = makeRepository();
    let embedCalls = 0;
    const index = createSemanticIndex({
      repository: fixture.repository,
      ollama: {
        model: 'embeddinggemma',
        health: async () => ({ ok: true }),
        embed: async () => { embedCalls += 1; return [1, 0]; },
      },
      now: () => 360,
    });
    index.enqueue('save-1');
    const [lane] = index.createLanes();
    const job = lane.claimReady(360);
    fixture.repository.getSemanticVector = () => ({
      generation_id: 'gen-active',
      source_hash: job.source_hash,
      model: 'embeddinggemma',
      dimension: 2,
      vector: storedVector,
    });

    const result = await lane.run(job);

    assert.equal(result.ok, true);
    assert.equal(embedCalls, 1);
    assert.equal(fixture.calls.completed.length, 1);
    assert.deepEqual(
      [
        fixture.calls.completed[0].vector.readFloatLE(0),
        fixture.calls.completed[0].vector.readFloatLE(4),
      ],
      [1, 0],
    );
  }
});

test('save deletion during embed records failure instead of leaving running job', async () => {
  const fixture = makeRepository();
  let deleted = false;
  fixture.repository.getSave = () => deleted ? undefined : fixture.save;
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async () => { deleted = true; return [1, 0]; },
    },
    now: () => 375,
  });
  index.enqueue('save-1');
  const [lane] = index.createLanes();

  const result = await lane.run(lane.claimReady(375));

  assert.equal(result.ok, false);
  assert.equal(fixture.calls.completed.length, 0);
  assert.equal(fixture.calls.failed.length, 1);
});

test('runtime-wide Ollama failure pauses queue and uses capped durable retry', async () => {
  for (const [code, retryCount, retryable] of [
    ['ollama_unavailable', 0, true],
    ['ollama_model_missing', 0, true],
    ['ollama_unavailable', 2, false],
  ]) {
    const fixture = makeRepository();
    const unavailable = Object.assign(new Error(code), {
      code,
    });
    const index = createSemanticIndex({
      repository: fixture.repository,
      ollama: {
        model: 'embeddinggemma',
        health: async () => { throw unavailable; },
        embed: async () => { throw new Error('must not embed'); },
      },
      now: () => 1_000,
      maxAttempts: 3,
      baseRetryMs: 100,
    });
    index.enqueue('save-1');
    const [lane] = index.createLanes();
    const job = lane.claimReady(1_000);
    job.retry_count = retryCount;

    const result = await lane.run(job);

    assert.equal(result.ok, false);
    assert.equal(fixture.calls.failed[0].retryable, retryable);
    assert.equal(fixture.calls.failed[0].retryAt, retryable ? 1_100 : undefined);
    assert.equal(fixture.calls.paused[0].reason, code);
  }
});

test('worker rejects invalid injected vectors before repository storage', async () => {
  const fixture = makeRepository();
  const index = createSemanticIndex({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      health: async () => ({ ok: true }),
      embed: async () => [1, Number.NaN],
    },
    now: () => 400,
  });
  index.enqueue('save-1');
  const [lane] = index.createLanes();
  await lane.run(lane.claimReady(400));

  assert.equal(fixture.calls.completed.length, 0);
  assert.equal(fixture.calls.failed.length, 1);
  assert.equal(fixture.calls.failed[0].retryable, false);
  assert.match(fixture.calls.failed[0].error, /invalid embedding/i);
});
