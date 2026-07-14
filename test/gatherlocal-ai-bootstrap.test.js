'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultAiRuntime } = require('../src/main/ai/bootstrap');
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
        codex: { bin: 'codex' },
        ollama: { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
      },
      dependencies: {
        codex: { spawnSync: () => ({ status: 0 }) },
        ollama: { fetch: async () => ({ ok: true, text: async () => '{"embeddings":[[1,0]]}' }) },
      },
    },
  });

  assert.equal(runtime.providerFor(CAPABILITIES.STRUCTURED_JSON), 'codex');
  assert.equal(runtime.providerFor(CAPABILITIES.EMBEDDING), 'ollama');
  assert.equal(runtime.providerFor(CAPABILITIES.IMAGE_GENERATION), null);
});

test('entitlement denial blocks personal providers before transport', async () => {
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
