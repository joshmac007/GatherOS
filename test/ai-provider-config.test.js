const test = require('node:test');
const assert = require('node:assert/strict');

const { readAiConfig } = require('../src/main/ai-provider-config');
const { extractJsonObject: extractLocalJson } = require('../src/main/ai-local-provider');
const {
  createCodexProvider,
  extractJsonObject: extractCodexJson,
} = require('../src/main/ai-codex-provider');

test('defaults to Codex subscription provider and never api.openai.com', () => {
  const config = readAiConfig({});

  assert.equal(config.provider, 'codex');
  assert.equal(config.local.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config.local.chatModel, 'llama3.2-vision');
  assert.deepEqual(config.ollama, {
    baseUrl: 'http://127.0.0.1:11434',
    embedModel: 'embeddinggemma',
  });
});

test('supports explicit local provider and model overrides', () => {
  const config = readAiConfig({
    GATHERLOCAL_AI_PROVIDER: 'local',
    GATHERLOCAL_LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1/',
    GATHERLOCAL_LOCAL_CHAT_MODEL: 'local-vision',
    GATHERLOCAL_OLLAMA_BASE_URL: 'http://127.0.0.1:2345/',
    GATHERLOCAL_OLLAMA_EMBED_MODEL: 'local-embed',
  });

  assert.equal(config.provider, 'local');
  assert.equal(config.local.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(config.local.chatModel, 'local-vision');
  assert.deepEqual(config.ollama, {
    baseUrl: 'http://127.0.0.1:2345',
    embedModel: 'local-embed',
  });
});

test('active provider facade has no generic embedding fallback', () => {
  const openai = require('../src/main/openai');
  const local = require('../src/main/ai-local-provider');

  assert.equal(openai.embedText, undefined);
  assert.equal(local.createLocalProvider({}).embedText, undefined);
  assert.equal(typeof openai.createOllamaEmbedClient, 'function');
});

test('falls back to Codex for invalid provider names', () => {
  const config = readAiConfig({ GATHERLOCAL_AI_PROVIDER: 'openai-api-key' });

  assert.equal(config.provider, 'codex');
});

test('extracts JSON from fenced provider responses', () => {
  assert.deepEqual(extractLocalJson('```json\n{"tags":["ui"]}\n```'), { tags: ['ui'] });
  assert.deepEqual(extractCodexJson('Answer:\n{"title":"Dashboard"}'), { title: 'Dashboard' });
});

test('Codex provider uses app-server read-only sandbox spelling', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ai-codex-provider'), 'utf8');

  assert.match(source, /sandbox:\s*'read-only'/);
  assert.doesNotMatch(source, /sandbox:\s*'readOnly'/);
});

test('Codex provider includes smart category membership scoring contract', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ai-codex-provider'), 'utf8');

  assert.match(source, /generateSmartCategoryMemberships/);
  assert.match(source, /Given one save topic profile and candidate smart categories/);
  assert.match(source, /Use 0\.75\+ for strong primary fit/);
  assert.match(source, /Use 0\.45-0\.74 for secondary fit/);
  assert.match(source, /Below 0\.45 omit/);
});

test('Codex provider includes conservative taxonomy refresh contract', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ai-codex-provider'), 'utf8');

  assert.match(source, /generateSmartCategoryTaxonomyRefresh/);
  assert.match(source, /Prefer aliases over renames/);
  assert.match(source, /Never rename for casing, punctuation, pluralization/);
  assert.match(source, /Merge\/split proposals are advisory only/);
});

test('Codex provider exposes one-image video suggestion contract', async () => {
  const calls = [];
  const provider = createCodexProvider({ bin: 'unused', timeoutMs: 1000 }, {
    codexJson: async (...args) => {
      calls.push(args);
      return {
        tags: [{ name: 'patio renovation', confidence: 'high', evidence: ['visual'] }],
        warnings: [],
      };
    },
  });

  assert.equal(typeof provider.generateVideoTagSuggestions, 'function');
  const result = await provider.generateVideoTagSuggestions({
    duration: 30,
    timestamps: [5, 10, 15],
    evidenceMode: 'frames',
    context: { title: 'Patio build', acceptedTags: ['woodworking'] },
  }, { imagePath: '/tmp/contact-sheet.jpg' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/tmp/contact-sheet.jpg');
  assert.match(calls[0][2], /high/);
  assert.match(calls[0][2], /visual/);
  assert.match(calls[0][2], /conflict/i);
  assert.deepEqual(result.tags[0].evidence, ['visual']);
});

test('dedicated video facade always constructs Codex provider, never active local provider', async () => {
  const { createVideoTagSuggestionGenerator } = require('../src/main/openai');
  let codexCreations = 0;
  let localCalls = 0;
  const generate = createVideoTagSuggestionGenerator({
    readConfig: () => ({
      provider: 'local',
      codex: { bin: 'codex-subscription' },
      local: { baseUrl: 'http://127.0.0.1:11434/v1' },
    }),
    createCodex: (config) => {
      codexCreations += 1;
      assert.equal(config.bin, 'codex-subscription');
      return {
        async generateVideoTagSuggestions(input, options) {
          return { input, options, provider: 'codex' };
        },
      };
    },
    createLocal: () => ({
      async generateVideoTagSuggestions() { localCalls += 1; },
    }),
  });

  assert.equal(typeof generate, 'function');
  const first = await generate({ duration: 10 }, { imagePath: '/tmp/sheet.jpg' });
  const second = await generate({ duration: 20 }, { imagePath: '/tmp/sheet-2.jpg' });

  assert.equal(first.provider, 'codex');
  assert.equal(second.provider, 'codex');
  assert.equal(codexCreations, 1);
  assert.equal(localCalls, 0);
});

test('cached Codex video facade exposes session status independent of active local provider', async () => {
  const { createCodexVideoFacade } = require('../src/main/openai');
  let creations = 0;
  const facade = createCodexVideoFacade({
    readConfig: () => ({ provider: 'local', codex: { bin: 'codex-subscription' } }),
    createCodex: () => {
      creations += 1;
      return {
        hasSession: () => true,
        async generateVideoTagSuggestions() { return { tags: [], warnings: [] }; },
      };
    },
  });

  assert.equal(facade.hasCodexSession(), true);
  assert.deepEqual(await facade.generateVideoTagSuggestions({}, { imagePath: '/tmp/poster.jpg' }), {
    tags: [], warnings: [],
  });
  assert.equal(creations, 1);
});

test('cached Codex video facade reports missing Codex session without consulting local provider', () => {
  const { createCodexVideoFacade } = require('../src/main/openai');
  let localCalls = 0;
  const facade = createCodexVideoFacade({
    readConfig: () => ({ provider: 'local', codex: { bin: 'missing-codex' } }),
    createCodex: () => ({ hasSession: () => false }),
    createLocal: () => { localCalls += 1; return { hasSession: () => true }; },
  });

  assert.equal(facade.hasCodexSession(), false);
  assert.equal(localCalls, 0);
});
