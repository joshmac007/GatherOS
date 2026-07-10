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

test('schedules a wake for the earliest lane backoff', async () => {
  const order = [];
  const timers = [];
  let currentTime = 10;
  let available = true;
  const lane = createLane('video', [], order, {
    claimReady: (time) => {
      if (!available || time < 50) return null;
      available = false;
      return 'video';
    },
    nextReadyAt: () => (available ? 50 : null),
  });
  const coordinator = createBackgroundWorkCoordinator({
    lanes: [lane],
    isForegroundBusy: () => false,
    now: () => currentTime,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  });

  coordinator.start();
  await coordinator.whenIdle();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 40);
  currentTime = 50;
  timers[0].callback();
  await coordinator.whenIdle();

  assert.deepEqual(order, ['video']);
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

test('stop invalidates a pending backoff timer', async () => {
  const order = [];
  let timerCallback;
  const lane = createLane('video', [], order, {
    claimReady: () => null,
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
  });

  coordinator.start();
  await coordinator.whenIdle();
  coordinator.stop();
  timerCallback();
  await coordinator.whenIdle();

  assert.deepEqual(order, []);
});
