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

test('semantic transport contains no OpenAI-shaped or cloud fallback routes', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ollama-embed-client'), 'utf8');

  assert.doesNotMatch(source, /\/v1\/embeddings|['"]\/embeddings['"]|LM Studio|api\.openai\.com/i);
});
