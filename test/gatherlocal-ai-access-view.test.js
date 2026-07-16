'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function helpers() {
  return import('../src/renderer/lib/aiAccess.mjs');
}

test('configured user-owned AI is usable', async () => {
  const { canUseCapability } = await helpers();
  const local = { configured: true, ownership: 'user', requiresPro: false };
  assert.equal(canUseCapability(local), true);
});

test('non-user providers are unavailable', async () => {
  const { canUseCapability } = await helpers();
  assert.equal(canUseCapability({ configured: true, ownership: 'unknown' }), false);
});

test('unconfigured and unresolved capabilities fail closed', async () => {
  const { canUseCapability } = await helpers();
  assert.equal(canUseCapability({ configured: false, ownership: 'user' }), false);
  assert.equal(canUseCapability(null), false);
});
