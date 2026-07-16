'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  CAPABILITIES,
  readGatherLocalAiConfig,
} = require('../src/main/gatherlocal/ai/config');
const { createGatherLocalRoutes } = require('../src/main/gatherlocal/ai');
const { createCodexStructuredAdapter } = require('../src/main/gatherlocal/ai/codex-structured');
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
  assert.equal(typeof config.codex.bin, 'string');
  assert.notEqual(config.codex.bin, '');
  assert.equal(readGatherLocalAiConfig({ GATHERLOCAL_CODEX_BIN: '/custom/codex' }).codex.bin, '/custom/codex');
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
      codex: { bin: 'codex' },
      ollama: { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
    },
    dependencies: {
      codex: { spawnSync: () => ({ status: 0 }) },
      ollama: { fetch: async () => response({ embeddings: [[1, 0]] }) },
    },
  });
  assert.deepEqual(Object.keys(routes), Object.values(CAPABILITIES));
  assert.equal(routes[CAPABILITIES.STRUCTURED_JSON].id, 'codex');
  assert.equal(routes[CAPABILITIES.EMBEDDING].id, 'ollama');
  assert.equal(routes[CAPABILITIES.IMAGE_GENERATION], null);
});

test('proxy route is unavailable even when injected', () => {
  const proxyStructured = { provider: 'proxy', completeJson: async () => ({ ok: true }) };
  const routes = createGatherLocalRoutes({
    config: {
      routes: {
        [CAPABILITIES.STRUCTURED_JSON]: 'proxy',
        [CAPABILITIES.EMBEDDING]: 'ollama',
        [CAPABILITIES.IMAGE_GENERATION]: 'disabled',
      },
      ollama: { embedModel: 'embeddinggemma' },
    },
    proxyAdapter: proxyStructured,
  });
  assert.equal(routes[CAPABILITIES.STRUCTURED_JSON], null);
  assert.equal(routes[CAPABILITIES.IMAGE_GENERATION], null);
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
  assert.deepEqual(await adapter.completeJson({ system: 'system', input: 'input', imagePath: '/tmp/x.jpg' }), { answer: true });
  assert.equal(request.model, 'vision');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;'), true);
});

test('Ollama adapter validates vector identity and dimension', async () => {
  const calls = [];
  const adapter = createOllamaEmbeddingAdapter(
    { baseUrl: 'http://ollama', embedModel: 'embeddinggemma' },
    {
      fetch: async (url) => {
        calls.push(url);
        return response({ embeddings: [[1, 0, 0]] });
      },
    },
  );
  const result = await adapter.embed({ text: 'hello' });
  assert.deepEqual(result, {
    vector: [1, 0, 0],
    provider: 'ollama',
    model: 'embeddinggemma',
    dimension: 3,
  });
  assert.deepEqual(calls, ['http://ollama/api/embed']);
  await assert.rejects(
    adapter.embed({ text: 'hello', expectedDimension: 2 }),
    (error) => error.code === 'AI_EMBEDDING_DIMENSION_MISMATCH',
  );
});

test('local transport distinguishes caller cancellation from timeout', async () => {
  function waitingFetch(_url, options) {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  }

  const adapter = createLocalStructuredAdapter(
    { baseUrl: 'http://local/v1', chatModel: 'vision', timeoutMs: 1000 },
    { fetch: waitingFetch },
  );
  const controller = new AbortController();
  const cancelled = adapter.completeJson({ input: 'input', signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === 'AI_ABORTED');

  const timedOut = createLocalStructuredAdapter(
    { baseUrl: 'http://local/v1', chatModel: 'vision', timeoutMs: 5 },
    { fetch: waitingFetch },
  ).completeJson({ input: 'input' });
  await assert.rejects(timedOut, (error) => error.code === 'AI_TIMEOUT');
});

test('Codex cancellation terminates its app-server process', async () => {
  const controller = new AbortController();
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  let killed = false;
  const requests = [];
  process.kill = () => { killed = true; };
  process.stdin = {
    write(line) {
      const message = JSON.parse(line);
      requests.push(message);
      const reply = (result) => queueMicrotask(() => {
        process.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`);
      });
      if (message.method === 'initialize') reply({});
      if (message.method === 'thread/start') reply({ thread: { id: 'thread-1' } });
      if (message.method === 'turn/start') {
        reply({ turn: { id: 'turn-1' } });
        queueMicrotask(() => controller.abort());
      }
    },
  };

  const adapter = createCodexStructuredAdapter(
    { bin: 'codex', cwd: '/tmp', timeoutMs: 1000 },
    {
      spawnSync: () => ({ status: 0 }),
      spawn: () => process,
    },
  );
  await assert.rejects(
    adapter.completeJson({ input: 'input', signal: controller.signal }),
    (error) => error.code === 'AI_ABORTED',
  );
  assert.equal(killed, true);
  assert.equal(requests.find((request) => request.method === 'thread/start').params.ephemeral, true);
  assert.equal(requests.find((request) => request.method === 'thread/start').params.sandbox, 'read-only');
});
