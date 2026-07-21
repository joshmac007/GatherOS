'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCodexStructuredAdapter, createCodexFetch, CODEX_ENDPOINT, SOURCE_ENDPOINT,
} = require('../src/main/gatherlocal/ai/codex-structured');

test('Codex fetch rewrites only exact responses POST and replays 401 with same session', async () => {
  const calls = [];
  const authCalls = [];
  let sends = 0;
  const auth = {
    async credentials(options = {}) {
      authCalls.push(options);
      return {
        accessToken: options.forceRefresh ? 'fresh' : 'old', refreshToken: 'r',
        expiresAt: 9e15, accountId: 'acct', generation: options.forceRefresh ? 2 : 1,
      };
    },
  };
  const fetch = createCodexFetch({
    auth, sessionId: 'session', userAgent: 'GatherLocal/test', onSend: () => { sends += 1; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: calls.length === 1 ? 401 : 200 };
    },
  });
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: 'Bearer oauth-dummy' }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(sends, 2);
  for (const call of calls) {
    assert.equal(call.url, CODEX_ENDPOINT);
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.get('originator'), 'gatherlocal');
    assert.equal(call.init.headers.get('session-id'), 'session');
    assert.equal(call.init.headers.get('ChatGPT-Account-Id'), 'acct');
  }
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer old');
  assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer fresh');
  assert.deepEqual(authCalls[1], {
    forceRefresh: true, expectedGeneration: 1, signal: undefined, deadline: undefined,
  });
  await assert.rejects(
    fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' }),
    (error) => error.code === 'AI_INVALID_RESPONSE',
  );
});

test('completeJson uses SDK streaming contract and retries one invalid output in original attempt', async () => {
  const calls = [];
  const attempts = [];
  const usage = [];
  const sessionIds = ['attempt-one', 'attempt-two'];
  const values = [
    () => Promise.reject(Object.assign(new Error('bad'), { name: 'JSONParseError' })),
    () => Promise.resolve({ ok: true }),
  ];
  const adapter = createCodexStructuredAdapter({ model: 'gpt-5.6-luna', timeoutMs: 1000 }, {
    auth: { credentials: async () => ({ accessToken: 'x', refreshToken: 'r', expiresAt: 9e15, generation: 1 }) },
    randomUUID: () => sessionIds.shift(),
    tracer: (event) => { if (event.event === 'attempt') attempts.push(event.sessionId); },
    fetch: async () => ({ status: 200 }),
    recordUsage: (entry) => usage.push(entry),
    sdk: {
      createOpenAI: ({ fetch }) => ({ responses: (model) => ({ model, fetch }) }),
      streamText(options) {
        calls.push(options);
        return {
          output: options.model.fetch(SOURCE_ENDPOINT, { method: 'POST' }).then(values.shift()),
          totalUsage: Promise.resolve({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
        };
      },
      Output: { object: ({ schema }) => ({ schema }) },
      jsonSchema: (schema) => schema,
    },
  });
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'boolean' } }, required: ['ok'],
  };
  assert.deepEqual(await adapter.completeJson({ input: 'x', outputSchema: schema, maxOutputTokens: 1 }), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model.model, 'gpt-5.6-luna');
  assert.equal(calls[0].maxOutputTokens, undefined);
  assert.equal(calls[0].maxRetries, 0);
  assert.equal(typeof calls[0].onError, 'function');
  assert.deepEqual(calls[0].providerOptions, { openai: { store: false, reasoningEffort: 'low' } });
  assert.deepEqual(attempts, ['attempt-one', 'attempt-two']);
  assert.deepEqual(usage.map((entry) => entry.outcome), ['failed', 'succeeded']);
  assert.deepEqual(usage.map((entry) => entry.usage.totalTokens), [3, 3]);
});

test('completeJson never begins OAuth when signed out', async () => {
  let browserCalls = 0;
  const adapter = createCodexStructuredAdapter({}, {
    auth: {
      snapshot: () => ({ state: 'signed_out' }),
      credentials: async () => { throw Object.assign(new Error('required'), { code: 'AI_AUTH_REQUIRED' }); },
      beginAuthorization: () => { browserCalls += 1; },
    },
    sdk: {
      createOpenAI: () => ({ responses: () => ({}) }),
      streamText: () => ({ output: Promise.resolve({ ok: true }) }),
      Output: { object: ({ schema }) => ({ schema }) },
      jsonSchema: (schema) => schema,
    },
  });
  const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  assert.equal(adapter.isConfigured(), true);
  assert.equal(adapter.isUsable(), false);
  await assert.rejects(adapter.completeJson({ outputSchema: schema }), (error) => error.code === 'AI_AUTH_REQUIRED');
  assert.equal(browserCalls, 0);
});

test('second 401 clears latest credentials while 403 never clears', async () => {
  let clears = 0;
  const auth = {
    async credentials(options = {}) {
      return { accessToken: options.forceRefresh ? 'fresh' : 'old', generation: options.forceRefresh ? 2 : 1 };
    },
    async rejectCredentials(generation) { assert.equal(generation, 2); clears += 1; },
  };
  const unauthorized = createCodexFetch({
    auth, sessionId: 's', userAgent: 'u', fetchImpl: async () => ({ status: 401 }),
  });
  assert.equal((await unauthorized('https://api.openai.com/v1/responses', { method: 'POST' })).status, 401);
  assert.equal(clears, 1);

  const forbidden = createCodexFetch({
    auth, sessionId: 's', userAgent: 'u', fetchImpl: async () => ({ status: 403 }),
  });
  assert.equal((await forbidden('https://api.openai.com/v1/responses', { method: 'POST' })).status, 403);
  assert.equal(clears, 1);
});

test('deadline exists before credentials and maps SDK timeout/abort/status errors', async () => {
  const credentialCalls = [];
  const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  function adapterFor(error, signal) {
    return createCodexStructuredAdapter({ timeoutMs: 1000 }, {
      now: () => 100,
      auth: {
        async credentials(options) {
          credentialCalls.push(options);
          return { accessToken: 'x', expiresAt: 9e15, generation: 1 };
        },
      },
      sdk: {
        createOpenAI: () => ({ responses: () => ({}) }),
        streamText: () => ({ output: Promise.reject(error) }),
        Output: { object: ({ schema: value }) => ({ schema: value }) },
        jsonSchema: (value) => value,
      },
    }).completeJson({ outputSchema: schema, signal });
  }
  await assert.rejects(adapterFor(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
    (error) => error.code === 'AI_TIMEOUT');
  assert.equal(credentialCalls[0].deadline, 1100);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapterFor(Object.assign(new Error('abort'), { name: 'AbortError' }), controller.signal),
    (error) => error.code === 'AI_ABORTED');

  await assert.rejects(adapterFor(Object.assign(new Error('forbidden'), { statusCode: 403 })),
    (error) => error.code === 'AI_PROVIDER_FORBIDDEN' && error.retryable === false);
  await assert.rejects(adapterFor(Object.assign(new Error('unsupported model'), { statusCode: 400 })),
    (error) => error.code === 'AI_MODEL_MISSING');
  await assert.rejects(adapterFor(Object.assign(new Error('limited'), {
    statusCode: 429, responseHeaders: { 'retry-after': '2' },
  })), (error) => error.code === 'AI_PROVIDER_UNAVAILABLE' && error.retryAfter === '2' && error.retryable);
});

test('real AI SDK emits expected Codex responses wire shape', async () => {
  const requests = [];
  const usage = [];
  const events = [
    { type: 'response.created', response: { id: 'resp', created_at: 1, model: 'gpt-5.6-luna' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message' } },
    { type: 'response.output_text.delta', item_id: 'message', delta: '{"ok":true}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message' } },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  const adapter = createCodexStructuredAdapter({ model: 'gpt-5.6-luna', timeoutMs: 1000 }, {
    auth: {
      async credentials() { return { accessToken: 'token', generation: 1 }; },
    },
    randomUUID: () => 'sdk-session',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
    recordUsage: (entry) => usage.push(entry),
  });
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'boolean' } }, required: ['ok'],
  };
  assert.deepEqual(await adapter.completeJson({ input: 'x', outputSchema: schema }), { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, CODEX_ENDPOINT);
  assert.equal(requests[0].init.headers.get('session-id'), 'sdk-session');
  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.max_output_tokens, undefined);
  assert.equal(requestBody.reasoning.effort, 'low');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].outcome, 'succeeded');
  assert.equal(usage[0].provider, 'codex');
  assert.equal(usage[0].usage.inputTokens, 1);
  assert.equal(usage[0].usage.outputTokens, 1);
});

test('hung image preprocessing settles at request deadline and ignores late result', async () => {
  let resolveImage;
  let sdkCalls = 0;
  const timers = [];
  const image = new Promise((resolve) => { resolveImage = resolve; });
  const adapter = createCodexStructuredAdapter({ timeoutMs: 1000 }, {
    now: () => 100,
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {},
    imageToDataUrl: () => image,
    auth: {
      async credentials() { return { accessToken: 'token', generation: 1 }; },
    },
    sdk: {
      createOpenAI: () => ({ responses: () => ({}) }),
      streamText() { sdkCalls += 1; return { output: Promise.resolve({ ok: true }) }; },
      Output: { object: ({ schema }) => ({ schema }) },
      jsonSchema: (schema) => schema,
    },
  });
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'boolean' } }, required: ['ok'],
  };
  const completion = adapter.completeJson({ imagePath: '/virtual/image.jpg', outputSchema: schema });
  await Promise.resolve();
  timers[0]();
  await assert.rejects(completion, (error) => error.code === 'AI_TIMEOUT');
  resolveImage('data:image/jpeg;base64,late');
  await Promise.resolve();
  assert.equal(sdkCalls, 0);
});
