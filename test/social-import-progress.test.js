const test = require('node:test');
const assert = require('node:assert/strict');

async function progress() { return import('../extension/social-import-progress.mjs'); }
const HOST_NAME = 'co.gatherlocal.host';

test('requires caller-owned native host identity', async () => {
  const { createSocialImportProgress } = await progress();
  assert.throws(() => createSocialImportProgress({
    sendNativeMessage: async () => ({ ok: true }),
  }), /hostName required/);
});

test('reports full snapshots with monotonic counters and terminal state', async () => {
  const calls = [];
  const { createSocialImportProgress } = await progress();
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async (_host, msg) => { calls.push(msg); return { ok: true, cancelRequested: false }; },
  });
  await reporter.start({ platform: 'x', mode: 'fixed', target: 2, startedAt: 1000 });
  await reporter.update({ stage: 'scanning', scanned: 1 });
  await reporter.update({ stage: 'saving', saved: 1 });
  await reporter.finish('complete');
  assert.equal(calls[0].type, 'social-import-status');
  assert.deepEqual(calls.at(-1), {
    type: 'social-import-status', runId: 'run-1', platform: 'x', mode: 'fixed', stage: 'complete',
    scanned: 1, saved: 1, known: 0, failed: 0, target: 2, startedAt: 1000, message: null,
  });
  await assert.rejects(reporter.update({ scanned: 0 }), /already finished/);
});

test('terminal progress cannot be reopened by late batch updates', async () => {
  const { createSocialImportProgress } = await progress();
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async () => ({ ok: true, cancelRequested: false }),
  });
  await reporter.start({ platform: 'x', mode: 'catch-up' });
  await reporter.finish('failed', 'media failed');
  await assert.rejects(reporter.update({ stage: 'saving', scanned: 1, saved: 1 }), /already finished/);
  assert.equal(reporter.getSnapshot().stage, 'failed');
});

test('returns native cancellation and checks it before next work', async () => {
  const { createSocialImportProgress } = await progress();
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async () => ({ ok: true, cancelRequested: true }),
  });
  await reporter.start({ platform: 'instagram', mode: 'all' });
  assert.equal(reporter.isCancellationRequested(), true);
  assert.equal(reporter.beforeNext(), false);
});

test('native progress failure does not fail the import and logs once', async () => {
  const logs = [];
  const { createSocialImportProgress } = await progress();
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    log: (...args) => logs.push(args),
    sendNativeMessage: async () => { throw new Error('host down'); },
  });
  await reporter.start({ platform: 'x', mode: 'catch-up' });
  await reporter.update({ stage: 'scanning', scanned: 1 });
  assert.equal(logs.length, 1);
  assert.equal(reporter.getSnapshot().stage, 'scanning');
});

test('default UUID generator calls crypto.randomUUID with its receiver', async () => {
  const { createSocialImportProgress } = await progress();
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    sendNativeMessage: async () => ({ ok: true, cancelRequested: false }),
  });
  await reporter.start({ platform: 'x', mode: 'all' });
  assert.equal(typeof reporter.getSnapshot().runId, 'string');
});

test('reports after each processed item so a cancel response prevents the next item', async () => {
  const { createSocialImportProgress } = await progress();
  const calls = [];
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async (_host, payload) => {
      calls.push(payload);
      return { ok: true, cancelRequested: calls.length >= 2 };
    },
  });
  await reporter.start({ platform: 'x', mode: 'fixed' });
  await reporter.update({ stage: 'saving', scanned: 1, saved: 1 });
  assert.equal(calls.length, 2);
  assert.equal(reporter.beforeNext(), false);
});
