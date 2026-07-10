const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBackgroundWorkCoordinator,
} = require('../src/main/background-work-coordinator');

function createLane(name, jobs, order, options = {}) {
  const queue = [...jobs];
  return {
    queue,
    claimReady: options.claimReady ?? (() => queue.shift() ?? null),
    run: options.run ?? (async (job) => {
      order.push(job ?? name);
      await Promise.resolve();
    }),
    nextReadyAt: options.nextReadyAt ?? (() => null),
  };
}

test('runs one job at a time in configured priority order', async () => {
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const makeLane = (name) => createLane(name, [name], order, {
    run: async (job) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      order.push(job);
      concurrent -= 1;
    },
  });
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [makeLane('video'), makeLane('incremental'), makeLane('rebuild')],
    isForegroundBusy: () => false,
  });

  coordinator.start();
  coordinator.wake();
  await coordinator.whenIdle();

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, ['video', 'incremental', 'rebuild']);
});

test('rechecks higher-priority lanes after each rebuild job', async () => {
  const order = [];
  const video = createLane('video', [], order);
  const rebuild = createLane('rebuild', ['rebuild-1', 'rebuild-2'], order, {
    run: async (job) => {
      order.push(job);
      if (job === 'rebuild-1') video.queue.push('video');
    },
  });
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [video, rebuild],
    isForegroundBusy: () => false,
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['rebuild-1', 'video', 'rebuild-2']);
});

test('skips a blocked lane without blocking ready lower-priority work', async () => {
  const order = [];
  const blocked = createLane('video', [], order, {
    claimReady: () => null,
    nextReadyAt: () => null,
  });
  const semantic = createLane('semantic', ['semantic'], order);
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [blocked, semantic],
    isForegroundBusy: () => false,
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['semantic']);
});

test('reports a rejected lane job and continues to lower-priority ready work', async () => {
  const order = [];
  const errors = [];
  const timers = [];
  const failure = new Error('Codex unavailable');
  const video = createLane('video', ['video'], order, {
    run: async () => { throw failure; },
    nextReadyAt: () => 100,
  });
  const semantic = createLane('semantic', ['semantic'], order);
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [video, semantic],
    isForegroundBusy: () => false,
    now: () => 0,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    onError: (error, context) => errors.push({ error, context }),
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['semantic']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, failure);
  assert.equal(errors[0].context.lane, video);
  assert.equal(errors[0].context.job, 'video');
  assert.equal(timers[0].delay, 100);
});

test('logs rejected lane jobs when no custom error reporter is provided', async () => {
  const order = [];
  const logs = [];
  const failure = new Error('Ollama unavailable');
  const video = createLane('video', ['video'], order, {
    run: async () => { throw failure; },
  });
  const semantic = createLane('semantic', ['semantic'], order);
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [video, semantic],
    isForegroundBusy: () => false,
    logger: { error: (...args) => logs.push(args) },
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['semantic']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], failure);
  assert.equal(logs[0][2].lane, video);
});

test('falls back to logging when a custom error reporter throws', async () => {
  const order = [];
  const logs = [];
  const failure = new Error('Codex unavailable');
  const reporterFailure = new Error('Reporter unavailable');
  const video = createLane('video', ['video'], order, {
    run: async () => { throw failure; },
  });
  const semantic = createLane('semantic', ['semantic'], order);
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [video, semantic],
    isForegroundBusy: () => false,
    onError: () => { throw reporterFailure; },
    logger: { error: (...args) => logs.push(args) },
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['semantic']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], reporterFailure);
  assert.equal(logs[0][2].originalError, failure);
  assert.equal(logs[0][2].context.lane, video);
});

test('falls back without an unhandled rejection when an async error reporter rejects', async () => {
  const order = [];
  const logs = [];
  const unhandled = [];
  const failure = new Error('Codex unavailable');
  const reporterFailure = new Error('Async reporter unavailable');
  const video = createLane('video', ['video'], order, {
    run: async () => { throw failure; },
  });
  const semantic = createLane('semantic', ['semantic'], order);
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    const coordinator = createBackgroundWorkCoordinator({
      lanes: [video, semantic],
      isForegroundBusy: () => false,
      onError: async () => { throw reporterFailure; },
      logger: { error: (...args) => logs.push(args) },
    });

    coordinator.start();
    await coordinator.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(order, ['semantic']);
    assert.deepEqual(unhandled, []);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1], reporterFailure);
    assert.equal(logs[0][2].originalError, failure);
    assert.equal(logs[0][2].context.lane, video);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('defers claims while foreground work is busy and noteActivity wakes it', async () => {
  const order = [];
  let foregroundBusy = true;
  const lane = createLane('video', ['video'], order);
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [lane],
    isForegroundBusy: () => foregroundBusy,
  });

  coordinator.start();
  await coordinator.whenIdle();
  assert.deepEqual(order, []);

  foregroundBusy = false;
  coordinator.noteActivity();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['video']);
});

test('reschedules an earlier lane deadline and ignores the stale timer callback', async () => {
  const order = [];
  const timers = [];
  const cleared = [];
  let currentTime = 10;
  let firstReadyAt = 100;
  let secondReadyAt = 200;
  let secondAvailable = true;
  let claimCount = 0;
  const firstLane = createLane('video', [], order, {
    claimReady: () => {
      claimCount += 1;
      return null;
    },
    nextReadyAt: () => firstReadyAt,
  });
  const secondLane = createLane('semantic', [], order, {
    claimReady: (time) => {
      claimCount += 1;
      if (!secondAvailable || time < secondReadyAt) return null;
      secondAvailable = false;
      return 'semantic';
    },
    nextReadyAt: () => (secondAvailable ? secondReadyAt : null),
  });
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [firstLane, secondLane],
    isForegroundBusy: () => false,
    now: () => currentTime,
    setTimer: (callback, delay) => {
      const handle = timers.length + 1;
      timers.push({ callback, delay, handle });
      return handle;
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 90);
  secondReadyAt = 50;
  coordinator.wake();
  await coordinator.whenIdle();
  assert.deepEqual(cleared, [1]);
  assert.equal(timers[1].delay, 40);

  const claimsBeforeStaleCallback = claimCount;
  timers[0].callback();
  await coordinator.whenIdle();
  assert.equal(claimCount, claimsBeforeStaleCallback);

  currentTime = 50;
  firstReadyAt = 100;
  timers[1].callback();
  await coordinator.whenIdle();

  assert.deepEqual(cleared, [1, 2]);
  assert.deepEqual(order, ['semantic']);
});

test('stop prevents new claims and whenIdle waits for the active job', async () => {
  const order = [];
  let releaseActive;
  const active = new Promise((resolve) => { releaseActive = resolve; });
  let activeStarted;
  const started = new Promise((resolve) => { activeStarted = resolve; });
  const lane = createLane('video', ['video-1', 'video-2'], order, {
    run: async (job) => {
      order.push(job);
      activeStarted();
      await active;
    },
  });
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [lane],
    isForegroundBusy: () => false,
  });

  coordinator.start();
  await started;
  coordinator.stop();
  let idle = false;
  const idlePromise = coordinator.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);

  releaseActive();
  await idlePromise;
  coordinator.wake();

  assert.deepEqual(order, ['video-1']);
  assert.deepEqual(lane.queue, ['video-2']);
});

test('stop clears a pending backoff timer and prevents claim re-entry', async () => {
  const order = [];
  let timerCallback;
  let claimCount = 0;
  const cleared = [];
  const lane = createLane('video', [], order, {
    claimReady: () => {
      claimCount += 1;
      return null;
    },
    nextReadyAt: () => 100,
  });
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [lane],
    isForegroundBusy: () => false,
    now: () => 0,
    setTimer: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  coordinator.start();
  await coordinator.whenIdle();
  const claimsBeforeStop = claimCount;
  coordinator.stop();
  timerCallback();
  await coordinator.whenIdle();

  assert.deepEqual(cleared, [1]);
  assert.equal(claimCount, claimsBeforeStop);
  assert.deepEqual(order, []);
});
