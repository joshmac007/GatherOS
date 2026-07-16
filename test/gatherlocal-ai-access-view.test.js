'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function helpers() {
  return import('../src/renderer/lib/aiAccess.mjs');
}

test('user-owned AI remains usable without GatherOS Pro', async () => {
  const { canUseCapability, capabilityRequiresUpgrade } = await helpers();
  const local = { configured: true, ownership: 'user', requiresPro: false };
  assert.equal(canUseCapability(local, true), true);
  assert.equal(capabilityRequiresUpgrade(local, true), false);
});

test('GatherOS proxy remains locked without Pro', async () => {
  const { canUseCapability, capabilityRequiresUpgrade } = await helpers();
  const proxy = { configured: true, ownership: 'gatheros', requiresPro: true };
  assert.equal(canUseCapability(proxy, true), false);
  assert.equal(capabilityRequiresUpgrade(proxy, true), true);
  assert.equal(canUseCapability(proxy, false), true);
});

test('unconfigured and unresolved capabilities fail closed', async () => {
  const { canUseCapability, capabilityRequiresUpgrade } = await helpers();
  assert.equal(canUseCapability({ configured: false, requiresPro: false }, true), false);
  assert.equal(canUseCapability(null, true), false);
  assert.equal(capabilityRequiresUpgrade(null, true), true);
});
