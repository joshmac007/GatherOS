'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultAiRuntime, createPostReadyAiBackend, getAiRuntime, installAiRuntime,
} = require('../src/main/ai/bootstrap');
const { CAPABILITIES } = require('../src/main/ai/runtime');

test('default runtime composes the selected GatherLocal capability routes', () => {
  const runtime = createDefaultAiRuntime({
    authorize: () => true,
    gatherLocalOptions: {
      config: {
        routes: {
          [CAPABILITIES.STRUCTURED_JSON]: 'codex',
          [CAPABILITIES.EMBEDDING]: 'ollama',
          [CAPABILITIES.IMAGE_GENERATION]: 'disabled',
        },
        codex: { model: 'gpt-5.6-luna' },
        ollama: { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
      },
      dependencies: {
        codex: { auth: { snapshot: () => ({ state: 'signed_out' }), credentials: async () => {} } },
        ollama: { fetch: async () => ({ ok: true, text: async () => '{"embeddings":[[1,0]]}' }) },
      },
    },
  });

  assert.equal(runtime.providerFor(CAPABILITIES.STRUCTURED_JSON), 'codex');
  assert.equal(runtime.providerFor(CAPABILITIES.EMBEDDING), 'ollama');
  assert.equal(runtime.providerFor(CAPABILITIES.IMAGE_GENERATION), null);
});

test('explicit runtime authorization denial blocks transport', async () => {
  let calls = 0;
  const runtime = createDefaultAiRuntime({
    authorize: () => false,
    gatherLocalOptions: {
      config: {
        routes: {
          [CAPABILITIES.STRUCTURED_JSON]: 'local',
          [CAPABILITIES.EMBEDDING]: 'ollama',
          [CAPABILITIES.IMAGE_GENERATION]: 'disabled',
        },
        local: { baseUrl: 'http://local/v1', chatModel: 'vision' },
        ollama: { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
      },
      dependencies: {
        local: { fetch: async () => { calls += 1; } },
        ollama: { fetch: async () => { calls += 1; } },
      },
    },
  });

  await assert.rejects(runtime.completeJson({ input: 'x' }), (error) => error.code === 'AI_NOT_ENTITLED');
  await assert.rejects(runtime.embed({ text: 'x' }), (error) => error.code === 'AI_NOT_ENTITLED');
  assert.equal(calls, 0);
});

test('installed runtime becomes the single runtime returned by bootstrap', () => {
  const runtime = { completeJson: async () => ({ installed: true }) };
  assert.equal(installAiRuntime(runtime), runtime);
  assert.equal(getAiRuntime(), runtime);
});

test('post-ready backend injects one usage ledger into configured routes', async () => {
  const recorded = [];
  const usageLedger = {
    record: (entry) => recorded.push(entry),
    snapshot: () => ({ ok: true, currentMonth: { totals: {} }, lifetime: { totals: {} } }),
  };
  const backend = createPostReadyAiBackend({
    app: { getPath: () => '/virtual/user-data', getVersion: () => 'test' },
    safeStorage: { isEncryptionAvailable: () => false },
    env: {
      GATHERLOCAL_AI_STRUCTURED_PROVIDER: 'local',
      GATHERLOCAL_LOCAL_VISION_MODEL: 'vision',
    },
    dependencies: {
      usageLedger,
      local: {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        }),
      },
    },
  });

  assert.equal(backend.usageLedger, usageLedger);
  assert.deepEqual(await backend.runtime.completeJson({ input: 'x' }), { ok: true });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].provider, 'local');
  assert.equal(backend.runtime.getUsage().routes[CAPABILITIES.STRUCTURED_JSON].model, 'vision');
  backend.codexAuth.dispose();
});
