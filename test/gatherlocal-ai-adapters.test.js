'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, readGatherLocalAiConfig } = require('../src/main/gatherlocal/ai/config');
const { createGatherLocalRoutes } = require('../src/main/gatherlocal/ai');
const { createLocalStructuredAdapter } = require('../src/main/gatherlocal/ai/local-structured');
const { createOllamaEmbeddingAdapter } = require('../src/main/gatherlocal/ai/ollama-embeddings');

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

test('per-capability config defaults independently', () => {
  const config = readGatherLocalAiConfig({});
  assert.equal(config.routes[CAPABILITIES.STRUCTURED_JSON], 'codex');
  assert.equal(config.routes[CAPABILITIES.EMBEDDING], 'ollama');
  assert.equal(config.routes[CAPABILITIES.IMAGE_GENERATION], 'disabled');
  assert.deepEqual(config.codex, {
    model: 'gpt-5.6-sol', timeoutMs: 120000, maxImageBytes: 2 * 1024 * 1024,
  });
  assert.deepEqual(readGatherLocalAiConfig({
    GATHERLOCAL_CODEX_MODEL: 'custom',
    GATHERLOCAL_CODEX_TIMEOUT_MS: '42',
    GATHERLOCAL_CODEX_MAX_IMAGE_BYTES: '99',
  }).codex, { model: 'custom', timeoutMs: 42, maxImageBytes: 99 });
  assert.throws(
    () => readGatherLocalAiConfig({ GATHERLOCAL_AI_STRUCTURED_PROVIDER: 'typo' }),
    /GATHERLOCAL_AI_STRUCTURED_PROVIDER must be one of/,
  );
});

test('route composition keeps Codex structured and Ollama embedding simultaneous', () => {
  const routes = createGatherLocalRoutes({
    config: {
      routes: {
        [CAPABILITIES.STRUCTURED_JSON]: 'codex',
        [CAPABILITIES.EMBEDDING]: 'ollama',
        [CAPABILITIES.IMAGE_GENERATION]: 'disabled',
      },
      codex: { model: 'gpt-5.6-sol' },
      ollama: { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
    },
    dependencies: {
      codex: { auth: { snapshot: () => ({ state: 'signed_out' }), credentials: async () => {} } },
      ollama: { fetch: async () => response({ embeddings: [[1, 0]] }) },
    },
  });
  assert.deepEqual(Object.keys(routes), Object.values(CAPABILITIES));
  assert.equal(routes[CAPABILITIES.STRUCTURED_JSON].id, 'codex');
  assert.equal(routes[CAPABILITIES.EMBEDDING].id, 'ollama');
  assert.equal(routes[CAPABILITIES.IMAGE_GENERATION], null);
});

test('unknown structured route is unavailable even when injected', () => {
  const routes = createGatherLocalRoutes({
    config: {
      routes: {
        [CAPABILITIES.STRUCTURED_JSON]: 'unknown',
        [CAPABILITIES.EMBEDDING]: 'ollama',
        [CAPABILITIES.IMAGE_GENERATION]: 'disabled',
      },
      ollama: { embedModel: 'embeddinggemma' },
    },
  });
  assert.equal(routes[CAPABILITIES.STRUCTURED_JSON], null);
});

test('local structured adapter sends JSON response format and bounded JPEG data URL', async () => {
  let request;
  const adapter = createLocalStructuredAdapter(
    { baseUrl: 'http://local/v1', chatModel: 'vision', timeoutMs: 1000, maxImageBytes: 100 },
    {
      imageToDataUrl: async () => 'data:image/jpeg;base64,ZmFrZQ==',
      fetch: async (_url, options) => {
        request = JSON.parse(options.body);
        return response({ choices: [{ message: { content: '{"answer":true}' } }] });
      },
    },
  );
  assert.deepEqual(await adapter.completeJson({
    system: 'system', input: 'input', imagePath: '/tmp/x.jpg',
  }), { answer: true });
  assert.equal(request.model, 'vision');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;'), true);
});

test('Ollama adapter validates vector identity and dimension', async () => {
  const adapter = createOllamaEmbeddingAdapter(
    { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
    { fetch: async () => response({ embeddings: [[1, 0, 0]] }) },
  );
  assert.deepEqual(await adapter.embed({ text: 'hello' }), {
    vector: [1, 0, 0], provider: 'ollama', model: 'embeddinggemma', dimension: 3,
  });
  await assert.rejects(
    adapter.embed({ text: 'hello', expectedDimension: 2 }),
    (error) => error.code === 'AI_EMBEDDING_DIMENSION_MISMATCH',
  );
});

test('local transport distinguishes caller cancellation from timeout', async () => {
  function waitingFetch(_url, options) {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  }
  const controller = new AbortController();
  const cancelled = createLocalStructuredAdapter(
    { baseUrl: 'http://local/v1', chatModel: 'vision', timeoutMs: 1000 },
    { fetch: waitingFetch },
  ).completeJson({ input: 'input', signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === 'AI_ABORTED');
  await assert.rejects(createLocalStructuredAdapter(
    { baseUrl: 'http://local/v1', chatModel: 'vision', timeoutMs: 5 },
    { fetch: waitingFetch },
  ).completeJson({ input: 'input' }), (error) => error.code === 'AI_TIMEOUT');
});
