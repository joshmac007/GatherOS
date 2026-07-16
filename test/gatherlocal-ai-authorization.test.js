'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGatherLocalAuthorization,
  providerAccess,
} = require('../src/main/gatherlocal/ai/authorization');

test('user-owned providers do not consume GatherOS entitlement', () => {
  let entitlementReads = 0;
  const authorize = createGatherLocalAuthorization({
    getEntitlement: () => {
      entitlementReads += 1;
      return { proUnlocked: false };
    },
  });

  for (const provider of ['codex', 'local', 'ollama']) {
    assert.deepEqual(authorize({ provider }), {
      allowed: true,
      ownership: 'user',
      requiresPro: false,
    });
  }
  assert.equal(entitlementReads, 0);
});

test('GatherOS proxy keeps Brett entitlement enforcement', () => {
  const denied = createGatherLocalAuthorization({
    getEntitlement: () => ({ proUnlocked: false }),
  });
  const allowed = createGatherLocalAuthorization({
    getEntitlement: () => ({ proUnlocked: true }),
  });

  assert.equal(denied({ provider: 'gatheros-proxy' }).allowed, false);
  assert.equal(allowed({ provider: 'gatheros-proxy' }).allowed, true);
  assert.deepEqual(providerAccess('gatheros-proxy'), {
    ownership: 'gatheros',
    requiresPro: true,
  });
});

test('unknown providers fail closed', () => {
  const authorize = createGatherLocalAuthorization({
    getEntitlement: () => ({ proUnlocked: true }),
  });
  assert.deepEqual(authorize({ provider: 'mystery' }), {
    allowed: false,
    ownership: 'unknown',
    requiresPro: true,
  });
});
