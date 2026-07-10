const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSemanticSearch, cosineSimilarity } = require('../src/main/semantic-search');

function floatBuffer(values) {
  const payload = Buffer.from(new Float32Array(values).buffer);
  const unaligned = Buffer.alloc(payload.length + 1);
  payload.copy(unaligned, 1);
  return unaligned.subarray(1);
}

function makeRepository(overrides = {}) {
  const saves = [
    { id: 'save-a', title: 'Literal result', deleted_at: null },
    { id: 'save-b', title: 'Semantic result', deleted_at: null },
    { id: 'save-c', title: 'Filtered out', deleted_at: null },
  ];
  const calls = [];
  return {
    calls,
    repository: {
      getSemanticIndexState: () => ({
        active_generation_id: 'gen-active', building_generation_id: null, paused: false,
      }),
      getActiveSemanticVectors: () => [
        { generation_id: 'gen-active', save_id: 'save-a', model: 'embeddinggemma', dimension: 3, vector: floatBuffer([0, 1, 0]) },
        { generation_id: 'gen-active', save_id: 'save-b', model: 'embeddinggemma', dimension: 3, vector: floatBuffer([1, 0, 0]) },
        { generation_id: 'gen-active', save_id: 'save-c', model: 'embeddinggemma', dimension: 3, vector: floatBuffer([1, 0, 0]) },
      ],
      getSemanticVector: (saveId) => ({
        generation_id: 'gen-active', save_id: saveId, model: 'embeddinggemma', dimension: 3,
        vector: floatBuffer(saveId === 'save-a' ? [1, 0, 0] : [0, 1, 0]),
      }),
      getAllSaves: (options) => {
        calls.push(options);
        if (options.search === '') return saves;
        if (options.search === 'tag:aviation') return saves.slice(0, 2);
        return [saves[0]];
      },
      getSavesByIds: (ids) => ids.map((id) => saves.find((save) => save.id === id)).filter(Boolean),
      findSimilarByPalette: () => [saves[2]],
      ...overrides,
    },
  };
}

test('semantic search embeds with active model dimension and preserves literal/structural results', async () => {
  const fixture = makeRepository();
  const embedCalls = [];
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      embed: async (query, options) => {
        embedCalls.push({ query, options });
        return [1, 0, 0];
      },
    },
  });

  const result = await search.search('cockpit tag:aviation', { view: 'all' });

  assert.deepEqual(embedCalls, [{ query: 'cockpit', options: { expectedDimension: 3 } }]);
  assert.equal(result.semanticAvailable, true);
  assert.equal(result.fallback, false);
  assert.deepEqual(result.results.map((save) => save.id), ['save-b', 'save-a']);
  assert.equal(fixture.calls.some((options) => options.search === 'cockpit tag:aviation'), true);
  assert.equal(fixture.calls.some((options) => options.search === 'tag:aviation'), true);
});

test('query failure returns explicit unavailable signal with literal fallback', async () => {
  const fixture = makeRepository();
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: {
      model: 'embeddinggemma',
      embed: async () => { throw Object.assign(new Error('offline'), { code: 'ollama_unavailable' }); },
    },
  });

  const result = await search.search('cockpit');

  assert.deepEqual(result.results.map((save) => save.id), ['save-a']);
  assert.equal(result.semanticAvailable, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'ollama_unavailable');
});

test('same-model rebuild keeps completed active generation searchable', async () => {
  let embedded = false;
  const fixture = makeRepository({
    getSemanticIndexState: () => ({
      active_generation_id: 'gen-active', building_generation_id: 'gen-building', paused: false,
    }),
  });
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', embed: async () => { embedded = true; return [1, 0, 0]; } },
  });

  const result = await search.search('cockpit');

  assert.equal(embedded, true);
  assert.equal(result.semanticAvailable, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.results.map((save) => save.id), ['save-b', 'save-c', 'save-a']);
});

test('changed-model rebuild leaves old active vectors intact but query unavailable', async () => {
  let embedded = false;
  const fixture = makeRepository({
    getSemanticIndexState: () => ({
      active_generation_id: 'gen-active', building_generation_id: 'gen-building', paused: false,
    }),
  });
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'nomic-embed-text', embed: async () => { embedded = true; return [1, 0, 0]; } },
  });

  const result = await search.search('cockpit');

  assert.equal(embedded, false);
  assert.equal(result.semanticAvailable, false);
  assert.equal(result.reason, 'active_model_unavailable');
  assert.deepEqual(result.results.map((save) => save.id), ['save-a']);
});

test('strict cosine dimensions reject mismatch instead of truncating', async () => {
  assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /dimension mismatch/i);

  const fixture = makeRepository({
    getActiveSemanticVectors: () => [
      { generation_id: 'gen-active', save_id: 'save-a', model: 'embeddinggemma', dimension: 2, vector: floatBuffer([1, 0]) },
      { generation_id: 'gen-active', save_id: 'save-b', model: 'embeddinggemma', dimension: 3, vector: floatBuffer([1, 0, 0]) },
    ],
  });
  let embedCalls = 0;
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', embed: async () => { embedCalls += 1; return [1, 0]; } },
  });
  const result = await search.search('cockpit');

  assert.equal(embedCalls, 0);
  assert.equal(result.semanticAvailable, false);
  assert.equal(result.reason, 'vector_identity_mismatch');
});

test('invalid stored vector returns fallback signal instead of rejecting search', async () => {
  const fixture = makeRepository({
    getActiveSemanticVectors: () => [
      { generation_id: 'gen-active', save_id: 'save-a', model: 'embeddinggemma', dimension: 3, vector: floatBuffer([0, 0, 0]) },
    ],
  });
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', embed: async () => [1, 0, 0] },
  });

  const result = await search.search('cockpit');

  assert.equal(result.semanticAvailable, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'vector_identity_mismatch');
});

test('active model mismatch never sends query to wrong Ollama client', async () => {
  const fixture = makeRepository();
  let embedCalls = 0;
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'nomic-embed-text', embed: async () => { embedCalls += 1; return [1, 0, 0]; } },
  });

  const result = await search.search('cockpit');

  assert.equal(embedCalls, 0);
  assert.equal(result.reason, 'active_model_unavailable');
  assert.equal(result.fallback, true);
});

test('find similar reads active generation only and falls back to palette when unavailable', () => {
  const fixture = makeRepository();
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'embeddinggemma', embed: async () => [1, 0, 0] },
  });

  const result = search.findSimilar('save-a', { limit: 5 });
  assert.equal(result.semanticAvailable, true);
  assert.deepEqual(result.results.map((save) => save.id), ['save-b', 'save-c']);

  fixture.repository.getSemanticVector = () => undefined;
  const fallback = search.findSimilar('save-a', { limit: 5 });
  assert.equal(fallback.semanticAvailable, false);
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.reason, 'anchor_not_indexed');
  assert.deepEqual(fallback.results.map((save) => save.id), ['save-c']);
});

test('find similar falls back to palette when active model differs from Ollama client', () => {
  const fixture = makeRepository();
  const search = createSemanticSearch({
    repository: fixture.repository,
    ollama: { model: 'nomic-embed-text', embed: async () => [1, 0, 0] },
  });

  const result = search.findSimilar('save-a', { limit: 5 });

  assert.equal(result.semanticAvailable, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'active_model_unavailable');
  assert.deepEqual(result.results.map((save) => save.id), ['save-c']);
});

test('semantic core has no generic openai.embedText consumer', () => {
  for (const name of ['semantic-index.js', 'semantic-search.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', name), 'utf8');
    assert.doesNotMatch(source, /require\(['"]\.\/openai['"]\)/);
    assert.doesNotMatch(source, /\bembedText\b/);
    assert.doesNotMatch(source, /\/v1\/embeddings|LM Studio/i);
  }
});
