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

test('coalesces concurrent progress updates behind one in-flight native send', async () => {
  const { createSocialImportProgress } = await progress();
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async (_host, payload) => {
      calls.push(payload);
      if (calls.length === 1) await gate;
      return { ok: true, cancelRequested: false };
    },
  });
  const start = reporter.start({ platform: 'x', mode: 'all' });
  await Promise.resolve();
  const scanning = reporter.update({ stage: 'scanning', scanned: 1 });
  const saving = reporter.update({ stage: 'saving', scanned: 2, saved: 1 });
  release();
  await Promise.all([start, scanning, saving]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].stage, 'saving');
  assert.equal(calls[1].scanned, 2);
});

test('controller rejection is typed and stops later work', async () => {
  const { createSocialImportProgress } = await progress();
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async () => ({ ok: false, error: 'runId mismatch' }),
  });
  await reporter.start({ platform: 'x', mode: 'all' });
  const result = await reporter.update({ stage: 'scanning', scanned: 1 });
  assert.equal(result.outcome, 'controller-rejected');
  assert.equal(reporter.beforeNext(), false);
});

test('starts heartbeat after accepted start at derived safe interval and unreferences it', async () => {
  const { createSocialImportProgress, SOCIAL_IMPORT_HEARTBEAT_INTERVAL_MS, SOCIAL_IMPORT_STALE_AFTER_MS } = await progress();
  let scheduled = null;
  let unrefCalls = 0;
  const timer = { unref: () => { unrefCalls += 1; } };
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async () => ({ ok: true, cancelRequested: false }),
    setIntervalFn: (fn, ms) => { scheduled = { fn, ms }; return timer; },
  });
  await reporter.start({ platform: 'x', mode: 'all' });
  assert.equal(SOCIAL_IMPORT_HEARTBEAT_INTERVAL_MS, 10_000);
  assert.ok(SOCIAL_IMPORT_HEARTBEAT_INTERVAL_MS < SOCIAL_IMPORT_STALE_AFTER_MS);
  assert.equal(scheduled.ms, SOCIAL_IMPORT_HEARTBEAT_INTERVAL_MS);
  assert.equal(unrefCalls, 1);
});

test('heartbeat uses normal reporter path then stops on terminal finish', async () => {
  const { createSocialImportProgress } = await progress();
  let tick;
  let cleared = 0;
  const calls = [];
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async (_host, payload) => { calls.push(payload); return { ok: true, cancelRequested: false }; },
    setIntervalFn: (fn) => { tick = fn; return 7; },
    clearIntervalFn: (id) => { assert.equal(id, 7); cleared += 1; },
  });
  await reporter.start({ platform: 'x', mode: 'all' });
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  await reporter.finish('complete');
  assert.equal(cleared, 1);
});

test('repeated heartbeat ticks coalesce while one native send is in flight', async () => {
  const { createSocialImportProgress } = await progress();
  let tick;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const reporter = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async (_host, payload) => {
      calls.push(payload);
      if (calls.length === 2) await gate;
      return { ok: true, cancelRequested: false };
    },
    setIntervalFn: (fn) => { tick = fn; return 1; },
  });
  await reporter.start({ platform: 'x', mode: 'all' });
  tick();
  tick();
  tick();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
});

test('does not start heartbeat after rejected start and stops it on controller rejection', async () => {
  const { createSocialImportProgress } = await progress();
  let scheduled = 0;
  const rejected = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-1',
    sendNativeMessage: async () => ({ ok: false }),
    setIntervalFn: () => { scheduled += 1; return 1; },
  });
  await rejected.start({ platform: 'x', mode: 'all' });
  assert.equal(scheduled, 0);

  let clears = 0;
  const active = createSocialImportProgress({
    hostName: HOST_NAME,
    randomUUID: () => 'run-2',
    sendNativeMessage: async (_host, payload) => ({ ok: payload.stage === 'starting' }),
    setIntervalFn: () => 9,
    clearIntervalFn: () => { clears += 1; },
  });
  await active.start({ platform: 'x', mode: 'all' });
  await active.update({ stage: 'scanning', scanned: 1 });
  assert.equal(clears, 1);
});
