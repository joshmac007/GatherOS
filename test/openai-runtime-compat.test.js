const test = require('node:test');
const assert = require('node:assert/strict');

const { createOpenAiFacade } = require('../src/main/openai');

test('openai facade preserves image tag normalization while using runtime', async () => {
  const calls = [];
  const facade = createOpenAiFacade({
    runtime: {
      isConfigured: () => true,
      providerFor: () => 'codex',
      completeJson: async (request) => {
        calls.push(request);
        return { tags: [' #UI ', 'BRUTALIST', null, 'art'] };
      },
    },
  });
  assert.deepEqual(await facade.autoTagImage('/tmp/image.jpg'), ['ui', 'brutalist', 'art']);
  assert.equal(calls[0].imagePath, '/tmp/image.jpg');
  assert.equal(calls[0].maxOutputTokens, 120);
  assert.match(calls[0].system, /style, content/);
});

test('openai facade preserves embedding vector compatibility', async () => {
  let request = null;
  const facade = createOpenAiFacade({
    runtime: {
      isConfigured: () => true,
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
    'image-generation': 'gatheros-proxy',
  };
  const facade = createOpenAiFacade({
    runtime: {
      providerFor: (capability) => providers[capability] || null,
      isConfigured: (capability) => capability !== 'image-generation',
    },
  });

  assert.deepEqual(facade.getAccess().structuredJson, {
    capability: 'structured-json',
    provider: 'codex',
    configured: true,
    ownership: 'user',
    requiresPro: false,
  });
  assert.deepEqual(facade.getAccess().imageGeneration, {
    capability: 'image-generation',
    provider: 'gatheros-proxy',
    configured: false,
    ownership: 'gatheros',
    requiresPro: true,
  });
});
