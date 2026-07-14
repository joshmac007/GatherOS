'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createGatherOsProxyAdapter } = require('../src/main/ai/providers/gatheros-proxy');

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('GatherOS proxy preserves chat and embedding request contracts', async () => {
  const calls = [];
  const adapter = createGatherOsProxyAdapter({
    baseUrl: 'https://proxy.test',
    getSessionToken: () => 'session-token',
    encodeImage: async () => ({ b64: 'aW1hZ2U=', mimeType: 'image/jpeg' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/ai/chat')) {
        return response({
          ok: true,
          choices: [{ message: { content: '{"tags":["aviation"]}' } }],
        });
      }
      return response({
        ok: true,
        data: [{ embedding: [0.25, 0.75] }],
      });
    },
  });

  assert.equal(adapter.isConfigured(), true);
  assert.deepEqual(await adapter.completeJson({
    system: 'Return JSON.',
    input: 'Tag this image.',
    imagePath: '/tmp/reference.jpg',
    maxOutputTokens: 120,
  }), { tags: ['aviation'] });
  assert.deepEqual(await adapter.embed({ text: '  visual query  ' }), {
    vector: [0.25, 0.75],
    provider: 'gatheros-proxy',
    model: 'text-embedding-3-small',
    dimension: 2,
  });

  assert.equal(calls[0].url, 'https://proxy.test/ai/chat');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer session-token');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.equal(calls[0].body.max_tokens, 120);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.messages[1].content[1].type, 'image_url');
  assert.equal(calls[1].url, 'https://proxy.test/ai/embed');
  assert.deepEqual(calls[1].body, { input: 'visual query' });
});

test('GatherOS proxy is unconfigured without licensing session', async () => {
  let calls = 0;
  const adapter = createGatherOsProxyAdapter({
    getSessionToken: () => null,
    fetchImpl: async () => { calls += 1; return response({ ok: true }); },
  });

  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(
    () => adapter.completeJson({ input: 'never sent' }),
    (error) => error.code === 'AI_AUTH_REQUIRED',
  );
  assert.equal(calls, 0);
});
