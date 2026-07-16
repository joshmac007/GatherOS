const test = require('node:test');
const assert = require('node:assert/strict');

const { createVideoSemanticWorkflows } = require('../src/main/video-semantic-workflows');

test('workflow wires provider-neutral embedding and structured contracts', async () => {
  const failures = [];
  let lanes = [];
  const embeddingProvider = {
    model: 'local-embedding-model',
    async embed() { return { vector: [1, 0], model: 'local-embedding-model', dimension: 2 }; },
  };
  const structuredProvider = {
    async completeJson() { return { tags: [], warnings: [] }; },
  };
  const repository = {
    recoverBackgroundJobs() {},
    getSave(id) { return { id, kind: 'video', file_path: '/tmp/video.mp4' }; },
    getTagsForSave() { return []; },
    failVideoAnalysis(payload) { failures.push(payload); },
  };
  const runtime = createVideoSemanticWorkflows({
    repository,
    embeddingProvider,
    structuredProvider,
    createSemanticIndexService(options) {
      assert.equal(options.embeddingProvider, embeddingProvider);
      return { enqueue: async () => ({ ok: true }), createLanes: () => [] };
    },
    createSemanticSearchService(options) {
      assert.equal(options.embeddingProvider, embeddingProvider);
      return {};
    },
    createVideoAnalysisService(options) {
      assert.equal(options.structuredProvider, structuredProvider);
      return {
        async prepare() { return { status: 'queued' }; },
        async run() {
          const error = new Error('structured provider offline');
          error.code = 'AI_PROVIDER_UNAVAILABLE';
          error.retryable = true;
          throw error;
        },
      };
    },
    createCoordinator(options) {
      lanes = options.lanes;
      return {
        start() {}, stop() {}, wake() {}, noteActivity() {}, async whenIdle() {},
      };
    },
    now: () => 100,
  });

  runtime.start();
  assert.equal(lanes[0].name, 'video-analysis');
  const result = await lanes[0].run({
    id: 'video-job', save_id: 'video-save', fingerprint: 'fingerprint', retry_count: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AI_PROVIDER_UNAVAILABLE');
  assert.equal(failures[0].retryable, true);
  assert.equal(runtime.getSemanticHealth().model, 'local-embedding-model');
  assert.doesNotMatch(JSON.stringify(result), /Codex|Ollama|OpenAI/i);
});

test('workflow rejects incomplete capability providers', () => {
  const repository = { recoverBackgroundJobs() {} };
  assert.throws(() => createVideoSemanticWorkflows({
    repository,
    embeddingProvider: { async embed() {} },
    structuredProvider: { async completeJson() {} },
  }), /embedding provider/i);
  assert.throws(() => createVideoSemanticWorkflows({
    repository,
    embeddingProvider: { model: 'embedding-model', async embed() {} },
    structuredProvider: {},
  }), /structured-output provider/i);
});

test('healthy embedding provider bootstraps first semantic generation once', async () => {
  let starts = 0;
  let building = false;
  const runtime = createVideoSemanticWorkflows({
    repository: {
      recoverBackgroundJobs() {},
      getAllSaves: () => [{ id: 'save-1' }],
    },
    embeddingProvider: {
      model: 'embedding-model',
      health: async () => ({ ok: true, model: 'embedding-model' }),
      async embed() { return { vector: [1, 0] }; },
    },
    structuredProvider: { async completeJson() { return {}; } },
    createSemanticIndexService() {
      return {
        enqueue: async () => ({ ok: true }),
        createLanes: () => [],
        status: () => ({
          active_generation_id: null,
          building_generation_id: building ? 'generation-1' : null,
        }),
        startRebuild: () => {
          starts += 1;
          building = true;
          return { ok: true, generation: 'generation-1' };
        },
      };
    },
    createSemanticSearchService: () => ({}),
    createVideoAnalysisService: () => ({ prepare: async () => ({}), run: async () => ({}) }),
    createCoordinator: () => ({
      start() {}, stop() {}, wake() {}, noteActivity() {}, async whenIdle() {},
    }),
  });
  runtime.start();
  await runtime.refreshSemanticHealth();
  await runtime.refreshSemanticHealth();
  assert.equal(starts, 1);
});
