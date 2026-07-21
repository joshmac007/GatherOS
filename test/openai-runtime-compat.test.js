const test = require('node:test');
const assert = require('node:assert/strict');

const { createOpenAiFacade } = require('../src/main/openai');

test('openai facade preserves image tag normalization while using runtime', async () => {
  const calls = [];
  const facade = createOpenAiFacade({
    runtime: {
      isConfigured: () => true,
      isUsable: () => true,
      providerFor: () => 'codex',
      completeJson: async (request) => {
        calls.push(request);
        return { tags: [' #UI ', 'ui', 'BRUTALIST', null, 'art'] };
      },
    },
  });
  assert.deepEqual(await facade.autoTagImage('/tmp/image.jpg'), ['ui', 'brutalist', 'art']);
  assert.equal(calls[0].imagePath, '/tmp/image.jpg');
  assert.equal(calls[0].maxOutputTokens, 120);
  assert.match(calls[0].system, /style, content/);
  assert.deepEqual(calls[0].outputSchema, {
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        minItems: 3,
        maxItems: 6,
        items: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
    required: ['tags'],
    additionalProperties: false,
  });
});

test('openai facade preserves embedding vector compatibility', async () => {
  let request = null;
  const facade = createOpenAiFacade({
    runtime: {
      isConfigured: () => true,
      isUsable: () => true,
      embed: async (value) => {
        request = value;
        return { vector: [0.25, 0.75], provider: 'proxy', model: 'test', dimension: 2 };
      },
    },
  });
  const result = await facade.embedText('  visual query  ', {
    expectedDimension: 2,
  });
  assert.deepEqual(result, [0.25, 0.75]);
  assert.equal(request.text, 'visual query');
  assert.equal(request.expectedDimension, 2);
});

test('openai facade reports provider ownership per capability', () => {
  const providers = {
    'structured-json': 'codex',
    embedding: 'ollama',
    'image-generation': null,
  };
  const facade = createOpenAiFacade({
    runtime: {
      providerFor: (capability) => providers[capability] || null,
      isConfigured: (capability) => capability !== 'image-generation',
      isUsable: (capability) => capability === 'structured-json',
    },
  });

  assert.deepEqual(facade.getAccess().structuredJson, {
    capability: 'structured-json',
    provider: 'codex',
    available: true,
    configured: true,
    ownership: 'user',
    requiresPro: false,
  });
  assert.deepEqual(facade.getAccess().imageGeneration, {
    capability: 'image-generation',
    provider: null,
    available: false,
    configured: false,
    ownership: 'unknown',
    requiresPro: true,
  });
});

test('openai facade resolves runtime at call time and uses usability for sessions', () => {
  let current = {
    providerFor: () => 'codex',
    isConfigured: () => true,
    isUsable: () => false,
  };
  const facade = createOpenAiFacade({ runtimeResolver: () => current });
  assert.equal(facade.hasSession(), false);
  assert.deepEqual(facade.getAccess().structuredJson, {
    capability: 'structured-json', provider: 'codex', available: true,
    configured: false, ownership: 'user', requiresPro: false,
  });
  current = { ...current, isUsable: () => true };
  assert.equal(facade.hasSession(), true);
  assert.equal(facade.getAccess().structuredJson.configured, true);
});

test('local structured provider remains a usable session without OAuth', () => {
  const facade = createOpenAiFacade({
    runtime: {
      providerFor: () => 'local',
      isConfigured: () => true,
      isUsable: () => true,
    },
  });
  assert.equal(facade.hasSession(), true);
  assert.equal(facade.getAccess().structuredJson.provider, 'local');
  assert.equal(facade.getAccess().structuredJson.configured, true);
});

test('image analysis and prompt use strict registry schemas', async () => {
  const calls = [];
  const facade = createOpenAiFacade({
    runtime: {
      completeJson: async (request) => {
        calls.push(request);
        return request.input.startsWith('Analyze')
          ? { title: 'Title', description: 'Description', text: '' }
          : { prompt: 'Prompt' };
      },
    },
  });
  await facade.analyzeImage('/tmp/image.png');
  await facade.generateImagePrompt('/tmp/image.png');
  assert.deepEqual(calls[0].outputSchema.required, ['title', 'description', 'text']);
  assert.equal(calls[0].outputSchema.additionalProperties, false);
  assert.deepEqual(calls[1].outputSchema.required, ['prompt']);
  assert.equal(calls[1].outputSchema.additionalProperties, false);
});
