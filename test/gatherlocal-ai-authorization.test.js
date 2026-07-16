'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGatherLocalAuthorization,
  providerAccess,
} = require('../src/main/gatherlocal/ai/authorization');

test('user-owned providers are allowed without account state', () => {
  const authorize = createGatherLocalAuthorization();

  for (const provider of ['codex', 'local', 'ollama']) {
    assert.deepEqual(authorize({ provider }), {
      allowed: true,
      ownership: 'user',
      requiresPro: false,
    });
  }
});

test('removed GatherOS proxy is rejected as unknown', () => {
  const authorize = createGatherLocalAuthorization();
  assert.equal(authorize({ provider: 'gatheros-proxy' }).allowed, false);
  assert.deepEqual(providerAccess('gatheros-proxy'), {
    ownership: 'unknown',
    requiresPro: true,
  });
});

test('unknown providers fail closed', () => {
  const authorize = createGatherLocalAuthorization();
  assert.deepEqual(authorize({ provider: 'mystery' }), {
    allowed: false,
    ownership: 'unknown',
    requiresPro: true,
  });
});
