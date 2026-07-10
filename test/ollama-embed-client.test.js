const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function loadClient() {
  return require('../src/main/ollama-embed-client');
}

test('uses Ollama native health and embedding endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (url.endsWith('/api/tags')) {
      return jsonResponse(200, { models: [{ name: 'embeddinggemma:latest' }] });
    }
    return jsonResponse(200, { embeddings: [[0.25, -0.5, 0.75]] });
  };
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434/',
    embedModel: 'embeddinggemma',
  }, { fetchImpl });

  assert.deepEqual(await client.health(), {
    ok: true,
    model: 'embeddinggemma',
  });
  assert.deepEqual(await client.embed('Find dark aviation dashboards'), [0.25, -0.5, 0.75]);
  assert.deepEqual(calls, [
    {
      url: 'http://127.0.0.1:11434/api/tags',
      method: 'GET',
      body: null,
    },
    {
      url: 'http://127.0.0.1:11434/api/embed',
      method: 'POST',
      body: {
        model: 'embeddinggemma',
        input: 'Find dark aviation dashboards',
      },
    },
  ]);
});

test('health rejects a missing embedding model with exact setup action', async () => {
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  }, {
    fetchImpl: async () => jsonResponse(200, { models: [{ name: 'llama3.2-vision:latest' }] }),
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, 'ollama_model_missing');
    assert.equal(error.setupAction, 'ollama pull embeddinggemma');
    return true;
  });
});

test('health does not treat a different model tag as the requested tagged model', async () => {
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma:300m',
  }, {
    fetchImpl: async () => jsonResponse(200, { models: [{ name: 'embeddinggemma:latest' }] }),
  });

  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, 'ollama_model_missing');
    return true;
  });
});

test('rejects empty embedding input before transport', async () => {
  let called = false;
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  }, {
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });

  await assert.rejects(client.embed('  '), /Cannot embed empty text/);
  assert.equal(called, false);
});

for (const [name, embeddings] of [
  ['missing array', undefined],
  ['empty array', []],
  ['non-array vector', ['bad']],
  ['empty vector', [[]]],
  ['non-finite vector', [[0.25, Number.NaN]]],
  ['zero vector', [[0, 0, 0]]],
]) {
  test(`rejects ${name} returned by Ollama`, async () => {
    const client = loadClient().createOllamaEmbedClient({
      baseUrl: 'http://127.0.0.1:11434',
      embedModel: 'embeddinggemma',
    }, {
      fetchImpl: async () => jsonResponse(200, { embeddings }),
    });

    await assert.rejects(client.embed('semantic source'), /invalid embedding/i);
  });
}

test('rejects vector dimension mismatch against expected dimension', async () => {
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  }, {
    fetchImpl: async () => jsonResponse(200, { embeddings: [[0.25, -0.5, 0.75]] }),
  });

  await assert.rejects(client.embed('semantic source', { expectedDimension: 4 }), (error) => {
    assert.equal(error.code, 'ollama_embedding_dimension_mismatch');
    return true;
  });
});

test('concurrent first embeddings atomically establish one observed dimension', async () => {
  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }
  const responses = [deferred(), deferred()];
  let call = 0;
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  }, {
    fetchImpl: async () => responses[call++].promise,
  });

  const first = client.embed('first semantic source');
  const second = client.embed('second semantic source');
  responses[0].resolve(jsonResponse(200, { embeddings: [[0.25, -0.5, 0.75]] }));
  assert.deepEqual(await first, [0.25, -0.5, 0.75]);
  responses[1].resolve(jsonResponse(200, { embeddings: [[0.1, 0.2, 0.3, 0.4]] }));

  await assert.rejects(second, (error) => {
    assert.equal(error.code, 'ollama_embedding_dimension_mismatch');
    assert.equal(error.expectedDimension, 3);
    assert.equal(error.actualDimension, 4);
    return true;
  });
});

test('times out a hanging request with abort cleanup and a distinct error', async () => {
  const timerId = Symbol('ollama-timeout');
  let timeoutCallback;
  let timeoutMs;
  let clearedTimer = null;
  let requestSignal = null;
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
    timeoutMs: 250,
  }, {
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      const fixtureCleanup = setTimeout(() => reject(new Error('fixture cleanup')), 20);
      options.signal.addEventListener('abort', () => {
        clearTimeout(fixtureCleanup);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    setTimeoutImpl(callback, ms) {
      timeoutCallback = callback;
      timeoutMs = ms;
      return timerId;
    },
    clearTimeoutImpl(id) {
      clearedTimer = id;
    },
  });

  const pending = client.embed('semantic source');
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'ollama_timeout');
    return true;
  });
  if (timeoutCallback) timeoutCallback();
  await rejected;
  assert.equal(timeoutMs, 250);
  assert.equal(requestSignal.aborted, true);
  assert.equal(clearedTimer, timerId);
});

test('non-JSON HTTP failures preserve status and retry classification', async () => {
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async text() { return 'service temporarily unavailable'; },
    }),
  });

  await assert.rejects(client.embed('semantic source'), (error) => {
    assert.equal(error.code, 'ollama_request_failed');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.match(error.message, /service temporarily unavailable/);
    return true;
  });
});

test('malformed JSON from a successful response remains an invalid response', async () => {
  const client = loadClient().createOllamaEmbedClient({
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() { return '<html>not JSON</html>'; },
    }),
  });

  await assert.rejects(client.embed('semantic source'), (error) => {
    assert.equal(error.code, 'ollama_invalid_response');
    return true;
  });
});

test('semantic transport contains no OpenAI-shaped or cloud fallback routes', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ollama-embed-client'), 'utf8');

  assert.doesNotMatch(source, /\/v1\/embeddings|['"]\/embeddings['"]|LM Studio|api\.openai\.com/i);
});
