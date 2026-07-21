const test = require('node:test');
const assert = require('node:assert/strict');

const { createAiRuntime, CAPABILITIES } = require('../src/main/ai/runtime');
const { AiRuntimeError, CODES } = require('../src/main/ai/errors');

function adapter(id, overrides = {}) {
  return {
    id,
    model: 'm',
    isConfigured: () => true,
    health: async () => ({ ok: true }),
    completeJson: async () => ({ ok: true }),
    embed: async () => ({ vector: [1], provider: id, model: 'm', dimension: 1 }),
    generateImage: async () => ({ bytes: Buffer.from('x'), mimeType: 'image/png', provider: id, model: 'm' }),
    getUsage: async () => ({ ok: true, provider: id }),
    ...overrides,
  };
}

test('runtime routes each capability independently', async () => {
  const structured = adapter('codex');
  const embedding = adapter('ollama');
  const runtime = createAiRuntime({
    authorize: () => true,
    routes: {
      [CAPABILITIES.STRUCTURED_JSON]: structured,
      [CAPABILITIES.EMBEDDING]: embedding,
      [CAPABILITIES.IMAGE_GENERATION]: null,
    },
  });

  assert.equal(runtime.providerFor(CAPABILITIES.STRUCTURED_JSON), 'codex');
  assert.equal(runtime.providerFor(CAPABILITIES.EMBEDDING), 'ollama');
  assert.equal(runtime.modelFor(CAPABILITIES.EMBEDDING), 'm');
  assert.equal(runtime.modelFor(CAPABILITIES.IMAGE_GENERATION), null);
  assert.equal(runtime.isConfigured(CAPABILITIES.IMAGE_GENERATION), false);
  assert.deepEqual(await runtime.completeJson({ input: 'x' }), { ok: true });
  assert.deepEqual(await runtime.embed({ text: 'x' }), { vector: [1], provider: 'ollama', model: 'm', dimension: 1 });
});

test('runtime blocks every execution when entitlement is false', async () => {
  let calls = 0;
  const route = adapter('proxy', {
    completeJson: async () => { calls += 1; return {}; },
    embed: async () => { calls += 1; return {}; },
    generateImage: async () => { calls += 1; return {}; },
  });
  const runtime = createAiRuntime({
    authorize: () => false,
    routes: {
      [CAPABILITIES.STRUCTURED_JSON]: route,
      [CAPABILITIES.EMBEDDING]: route,
      [CAPABILITIES.IMAGE_GENERATION]: route,
    },
  });

  for (const action of [
    () => runtime.completeJson({}),
    () => runtime.embed({ text: 'x' }),
    () => runtime.generateImage({ prompt: 'x' }),
  ]) {
    await assert.rejects(action, (error) => {
      assert.ok(error instanceof AiRuntimeError);
      assert.equal(error.code, CODES.NOT_ENTITLED);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('runtime never falls back when route is missing', async () => {
  const runtime = createAiRuntime({
    authorize: () => true,
    routes: { [CAPABILITIES.STRUCTURED_JSON]: adapter('one') },
  });
  await assert.rejects(
    () => runtime.embed({ text: 'x' }),
    (error) => error.code === CODES.CAPABILITY_UNCONFIGURED && error.capability === CAPABILITIES.EMBEDDING,
  );
});

test('runtime reports provider usability without blocking adapter auth errors', async () => {
  let calls = 0;
  const oauthCodex = adapter('codex', {
    isUsable: () => false,
    async completeJson() {
      calls += 1;
      throw new AiRuntimeError(CODES.AUTH_REQUIRED, 'Codex sign in required');
    },
  });
  const local = adapter('local');
  const codexRuntime = createAiRuntime({
    authorize: () => true,
    routes: { [CAPABILITIES.STRUCTURED_JSON]: oauthCodex },
  });
  const localRuntime = createAiRuntime({
    authorize: () => true,
    routes: { [CAPABILITIES.STRUCTURED_JSON]: local },
  });

  assert.equal(codexRuntime.isConfigured(CAPABILITIES.STRUCTURED_JSON), true);
  assert.equal(codexRuntime.isUsable(CAPABILITIES.STRUCTURED_JSON), false);
  await assert.rejects(codexRuntime.completeJson({}), (error) => error.code === CODES.AUTH_REQUIRED);
  assert.equal(calls, 1);
  assert.equal(localRuntime.isUsable(CAPABILITIES.STRUCTURED_JSON), true);
});
