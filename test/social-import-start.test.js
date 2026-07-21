const test = require('node:test');
const assert = require('node:assert/strict');

async function startLease() { return import('../extension/social-import-start.mjs'); }

test('accepts controller lease before background work begins', async () => {
  const { startSocialImportLease } = await startLease();
  let starts = 0;
  let releases = 0;
  const result = await startSocialImportLease({
    progress: {
      start: async () => { starts += 1; return { outcome: 'accepted' }; },
      beforeNext: () => true,
    },
    startArgs: { platform: 'x', mode: 'all' },
    release: () => { releases += 1; },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(starts, 1);
  assert.equal(releases, 0);
});

test('controller rejection releases reservation with panel-safe error', async () => {
  const { startSocialImportLease } = await startLease();
  let releases = 0;
  const result = await startSocialImportLease({
    progress: { start: async () => ({ outcome: 'controller-rejected' }), beforeNext: () => false },
    release: () => { releases += 1; },
  });
  assert.deepEqual(result, { ok: false, error: 'Another social import is already running.' });
  assert.equal(releases, 1);
});

test('setup exceptions release reservation', async () => {
  const { startSocialImportLease } = await startLease();
  let releases = 0;
  const result = await startSocialImportLease({
    progress: { start: async () => { throw new Error('native setup failed'); }, beforeNext: () => true },
    release: () => { releases += 1; },
  });
  assert.deepEqual(result, { ok: false, error: 'native setup failed' });
  assert.equal(releases, 1);
});
