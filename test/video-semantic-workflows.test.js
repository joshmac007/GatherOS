const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createVideoSemanticWorkflows,
  cleanupPurgedSaveDerived,
  isVideoSave,
  shouldUseImageAi,
} = require('../src/main/video-semantic-workflows');
const { createBackgroundWorkCoordinator } = require('../src/main/background-work-coordinator');
const { buildSaveTopicEvidence } = require('../src/main/save-topic-profiles');
const { completeSavedResponse } = require('../src/main/extension-server');
const { createForegroundActivityTracker } = require('../src/main/foreground-activity');
const { createSaveBackgroundRouter } = require('../src/main/save-background-router');
const saveNotifications = require('../src/main/notify');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness({
  foregroundBusy = false,
  hasCodexSession = true,
  videoRun = null,
  videoPrepareError = null,
  semanticEnqueueError = null,
  ollamaHealth = async () => ({ ok: true, model: 'embeddinggemma' }),
} = {}) {
  const order = [];
  const videoQueue = [];
  const incrementalQueue = [];
  const rebuildQueue = [];
  const failures = [];
  const completions = [];
  const recovery = [];
  const cleanups = [];
  const restores = [];
  const events = [];
  const saves = new Map();
  let library = 'library-a';
  let busy = foregroundBusy;
  let concurrent = 0;
  let maxConcurrent = 0;

  const repository = {
    recoverBackgroundJobs(now) {
      recovery.push({ library, now });
      return { semantic: 0, video: 0 };
    },
    claimVideoAnalysis() {
      return videoQueue.shift();
    },
    getNextVideoAnalysisReadyAt() {
      return null;
    },
    getSave(id) {
      return saves.get(id);
    },
    getTagsForSave() {
      return [];
    },
    failVideoAnalysis(input) {
      failures.push({ ...input, library });
      return { ok: true };
    },
    completeVideoAnalysis(input) {
      completions.push({ ...input, library });
      return { ok: true };
    },
  };

  function trackedRun(name, callback = null) {
    return async (job) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        order.push(name);
        if (callback) return await callback(job);
        await Promise.resolve();
        return { ok: true };
      } finally {
        concurrent -= 1;
      }
    };
  }

  const createSemanticIndexService = ({ coordinator }) => ({
    enqueue(saveId) {
      if (semanticEnqueueError) throw semanticEnqueueError;
      order.push('semantic-persist');
      incrementalQueue.push({ id: `semantic-${saveId}`, save_id: saveId });
      coordinator.wake();
      return { ok: true };
    },
    status: () => ({ active_generation_id: 'gen-active', active_model: 'embeddinggemma' }),
    createLanes: () => [
      {
        name: 'semantic-incremental',
        claimReady: () => incrementalQueue.shift(),
        run: trackedRun('semantic-incremental'),
        nextReadyAt: () => null,
      },
      {
        name: 'semantic-rebuild',
        claimReady: () => rebuildQueue.shift(),
        run: trackedRun('semantic-rebuild'),
        nextReadyAt: () => null,
      },
    ],
  });

  const createVideoAnalysisService = ({ repository: boundRepository }) => ({
    async prepare({ save }) {
      if (videoPrepareError) throw videoPrepareError;
      order.push('video-persist');
      const job = {
        id: `video-${save.id}`,
        save_id: save.id,
        fingerprint: `fingerprint-${save.id}`,
        prompt_version: 1,
        retry_count: 0,
      };
      videoQueue.push(job);
      return { status: 'queued', job };
    },
    run: trackedRun('video', async (job) => {
      if (videoRun) return videoRun({ job, repository: boundRepository });
      boundRepository.completeVideoAnalysis({ id: job.id, fingerprint: job.fingerprint });
      return { status: 'completed' };
    }),
  });

  const runtime = createVideoSemanticWorkflows({
    repository,
    ollama: { model: 'embeddinggemma', health: ollamaHealth, embed: async () => [1, 0] },
    codex: {
      hasCodexSession: () => hasCodexSession,
      generateVideoTagSuggestions: async () => ({ tags: [], warnings: [] }),
    },
    frameExtractor: { extract: async () => ({ duration: 10, timestamps: [], frames: [] }) },
    createSemanticIndexService,
    createSemanticSearchService: () => ({ search: async () => ({ results: [] }) }),
    createVideoAnalysisService,
    createCoordinator: createBackgroundWorkCoordinator,
    isForegroundBusy: () => busy,
    notify: (event, payload) => events.push({ event, payload }),
    getDerivedDirectory: () => `/derived/${library}`,
    cleanupDerivedSave: async (directory, saveId) => cleanups.push({ directory, saveId }),
    cleanupDerivedAll: async (directory) => cleanups.push({ directory, all: true }),
    restoreBackupImpl: async (snapshotPath) => {
      restores.push({ snapshotPath, library });
      return { ok: true };
    },
    now: () => 100,
  });

  return {
    runtime,
    repository,
    order,
    videoQueue,
    incrementalQueue,
    rebuildQueue,
    failures,
    completions,
    recovery,
    cleanups,
    restores,
    events,
    saves,
    get maxConcurrent() { return maxConcurrent; },
    setBusy(value) { busy = value; },
    switchLibrary(value) { library = value; videoQueue.length = 0; incrementalQueue.length = 0; rebuildQueue.length = 0; },
  };
}

test('one coordinator runs video, incremental semantic, then rebuild with global concurrency one', async () => {
  const harness = createHarness({ foregroundBusy: true });
  harness.saves.set('clip', { id: 'clip', kind: 'video', file_path: '/tmp/clip.mp4' });
  harness.rebuildQueue.push({ id: 'rebuild-1' });

  harness.runtime.start();
  await harness.runtime.routeSave(harness.saves.get('clip'));
  harness.setBusy(false);
  harness.runtime.noteActivity();
  await harness.runtime.whenIdle();

  assert.deepEqual(harness.order, [
    'video-persist', 'semantic-persist', 'video', 'semantic-incremental', 'semantic-rebuild',
  ]);
  assert.equal(harness.maxConcurrent, 1);
  assert.equal(harness.recovery.length, 1);
});

test('production-ready routing persists video before semantic wake and runs video first', async () => {
  const harness = createHarness();
  const save = { id: 'ready-video', kind: 'video', file_path: '/tmp/ready.mp4' };
  harness.saves.set(save.id, save);
  harness.runtime.start();

  await harness.runtime.routeSave(save);
  await harness.runtime.whenIdle();

  assert.deepEqual(harness.order, [
    'video-persist', 'semantic-persist', 'video', 'semantic-incremental',
  ]);
  assert.equal(harness.events.some(({ event }) => event === 'video-analysis:updated'), true);
});

test('Codex outage fails video domain without blocking semantic work', async () => {
  const harness = createHarness({ foregroundBusy: true, hasCodexSession: false });
  const save = { id: 'offline-video', kind: 'video', file_path: '/tmp/offline.mp4' };
  harness.saves.set(save.id, save);

  harness.runtime.start();
  await harness.runtime.routeSave(save);
  harness.setBusy(false);
  harness.runtime.noteActivity();
  await harness.runtime.whenIdle();

  assert.deepEqual(harness.order, ['video-persist', 'semantic-persist', 'semantic-incremental']);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].retryable, true);
  assert.match(harness.failures[0].error, /Codex session/i);
  assert.equal(harness.events.some(({ event }) => event === 'video-analysis:updated'), true);
});

test('ordinary duplicate is a no-op in the runtime', async () => {
  const harness = createHarness({ foregroundBusy: true });
  const save = { id: 'new-video', kind: 'video', file_path: '/tmp/new.mp4' };
  harness.saves.set(save.id, save);
  harness.runtime.start();

  assert.deepEqual(await harness.runtime.routeSave(save, { duplicate: true }), {
    ok: true, skipped: 'duplicate',
  });
  assert.equal(harness.videoQueue.length, 0);
  assert.equal(harness.incrementalQueue.length, 0);

});

test('new save routing warns instead of rejecting after semantic enqueue failure', async () => {
  const harness = createHarness({
    semanticEnqueueError: new Error('semantic queue unavailable'),
  });
  const save = { id: 'committed-save', kind: 'image', file_path: '/tmp/image.png' };
  harness.saves.set(save.id, save);
  harness.runtime.start();

  const result = await harness.runtime.routeSave(save);

  assert.equal(result.ok, true);
  assert.equal(result.semanticWarning?.reason, 'semantic-enqueue-failed');
});

test('extension success response acknowledges durable queue without waiting for background work', async () => {
  const order = [];
  let responseBody = null;
  const response = {
    writeHead() {},
    end(body) { order.push('response'); responseBody = JSON.parse(body); },
  };
  await completeSavedResponse({
    res: response,
    record: { id: 'extension-video', kind: 'video' },
    notify: (_record, options) => order.push(['notify', options]),
    routeSave: () => { order.push('queued'); return { ok: true, scheduled: true }; },
  });

  assert.deepEqual(order, [
    'queued',
    ['notify', { backgroundRouted: true }],
    'response',
  ]);
  assert.deepEqual(responseBody, { ok: true, id: 'extension-video' });
});

test('extension reports saved with background warning after durable routing failure', async () => {
  let responseBody = null;
  let notified = 0;
  const response = {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { responseBody = JSON.parse(body); },
  };

  await completeSavedResponse({
    res: response,
    record: { id: 'saved-before-background-failure', kind: 'video' },
    duplicate: true,
    notify: (_record, options) => {
      notified += 1;
      assert.deepEqual(options, { backgroundRouted: true });
    },
    routeSave: async (_record, options) => {
      assert.deepEqual(options, { duplicate: true });
      throw new Error('queue locked');
    },
  });

  assert.equal(notified, 1);
  assert.deepEqual(responseBody, {
    ok: true,
    id: 'saved-before-background-failure',
    duplicate: true,
    background: { ok: false, warning: 'queue locked' },
  });
});

test('foreground activity defers ready work and wakes once the quiet window ends', () => {
  let timestamp = 1_000;
  const timers = [];
  let idleCalls = 0;
  const tracker = createForegroundActivityTracker({
    quietMs: 500,
    now: () => timestamp,
    setTimer: (callback, delay) => {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimer: () => {},
    onIdle: () => { idleCalls += 1; },
  });

  tracker.noteActivity({ kind: 'interactive-ui' });
  assert.equal(tracker.isBusy(), true);
  assert.equal(timers.at(-1).delay, 500);
  timestamp = 1_500;
  timers.at(-1).callback();
  assert.equal(tracker.isBusy(), false);
  assert.equal(idleCalls, 1);
});

test('save router schedules image enrichment, drains outbox once, and leaves legacy duplicates alone', async () => {
  const order = [];
  const enrichGate = deferred();
  const tasks = [];
  const records = new Map([
    ['image-save', { id: 'image-save', kind: 'image', file_path: '/tmp/image.png' }],
    ['video-save', { id: 'video-save', kind: 'video', file_path: '/tmp/video.mp4' }],
  ]);
  const jobs = new Map([
    ['image-save', { save_id: 'image-save', state: 'pending' }],
    ['video-save', { save_id: 'video-save', state: 'pending' }],
  ]);
  const repository = {
    getSaveBackgroundRoute(saveId) { return jobs.get(saveId); },
    claimSaveBackgroundRoute(saveId) {
      const job = jobs.get(saveId);
      if (!job || job.state !== 'pending') return undefined;
      job.state = 'running';
      return job;
    },
    completeSaveBackgroundRoute(saveId) { jobs.get(saveId).state = 'completed'; return { ok: true }; },
    failSaveBackgroundRoute({ saveId }) { jobs.get(saveId).state = 'pending'; return { ok: true, availableAt: 5_000 }; },
    listPendingSaveBackgroundRoutes() { return [...jobs.values()].filter((job) => job.state === 'pending'); },
  };
  const backgroundRuntime = {
    async routeSave(record, options) {
      order.push(['route', record.id, options]);
      return { ok: true };
    },
    scheduleForegroundTask(task) {
      const pending = (this.taskTail || Promise.resolve()).then(() => task({
        isCurrent: () => true,
        routeSave: this.routeSave.bind(this),
      }));
      this.taskTail = pending.catch(() => {});
      tasks.push(pending);
      return { ok: true, scheduled: true };
    },
  };
  const router = createSaveBackgroundRouter({
    backgroundRuntime,
    repository,
    getSave: (id) => records.get(id),
    enrichImageSave: async (record) => {
      order.push(['enrich', record.id]);
      await enrichGate.promise;
    },
    noteActivity: (payload) => order.push(['activity', payload.kind]),
    now: () => 1_000,
  });

  assert.deepEqual(router.enqueue(records.get('image-save')), { ok: true, scheduled: true });
  await Promise.resolve();
  assert.deepEqual(order, [['activity', 'save'], ['enrich', 'image-save']]);
  assert.deepEqual(router.enqueue(records.get('video-save')), { ok: true, scheduled: true });
  assert.equal(jobs.get('video-save').state, 'pending');
  assert.equal(router.notify(records.get('video-save'), { backgroundRouted: true }), null);
  assert.deepEqual(router.enqueue(records.get('legacy-save') || { id: 'legacy-save' }, { duplicate: true }), {
    ok: true, skipped: 'duplicate',
  });
  enrichGate.resolve();
  await Promise.all(tasks);

  assert.deepEqual(order, [
    ['activity', 'save'],
    ['enrich', 'image-save'],
    ['activity', 'save'],
    ['activity', 'duplicate'],
    ['route', 'image-save', { changed: true }],
    ['route', 'video-save', { changed: false }],
  ]);
  assert.equal(jobs.get('image-save').state, 'completed');
  assert.equal(jobs.get('video-save').state, 'completed');

  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(indexSource, /isForegroundBusy: \(\) => foregroundActivity\.isBusy\(\)/);
  assert.match(indexSource, /function notifySaved\(record, options = \{\}\)[\s\S]*routeNewSaveToBackground\(record, options\)/);
});

test('failed route stays durable and startup recovery heals it without user action', async () => {
  const save = { id: 'durable-retry', kind: 'video', file_path: '/tmp/retry.mp4' };
  const job = { save_id: save.id, state: 'pending', available_at: 100 };
  const repository = {
    getSaveBackgroundRoute(saveId) { return saveId === save.id ? job : undefined; },
    claimSaveBackgroundRoute(saveId, now) {
      if (saveId !== save.id || job.state !== 'pending' || job.available_at > now) return undefined;
      job.state = 'running';
      return job;
    },
    completeSaveBackgroundRoute() { job.state = 'completed'; return { ok: true }; },
    failSaveBackgroundRoute({ error }) {
      job.state = 'pending'; job.error = error; job.available_at = 200; return { ok: true, availableAt: 200 };
    },
    listPendingSaveBackgroundRoutes(now) {
      return job.state === 'pending' && job.available_at <= now ? [job] : [];
    },
  };
  let firstTask;
  const first = createSaveBackgroundRouter({
    backgroundRuntime: {
      routeSave: async () => { throw new Error('disk temporarily locked'); },
      scheduleForegroundTask: (task) => {
        firstTask = Promise.resolve().then(() => task({ isCurrent: () => true }));
        return { ok: true, scheduled: true };
      },
    },
    repository,
    getSave: () => save,
    now: () => 100,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  assert.deepEqual(first.enqueue(save), { ok: true, scheduled: true });
  await assert.rejects(firstTask, /disk temporarily locked/);
  assert.equal(job.state, 'pending');
  assert.equal(job.error, 'disk temporarily locked');

  let dispatched = 0;
  let restartedTask;
  const restarted = createSaveBackgroundRouter({
    backgroundRuntime: {
      routeSave: async () => { dispatched += 1; return { ok: true }; },
      scheduleForegroundTask: (task) => {
        restartedTask = Promise.resolve().then(() => task({
          isCurrent: () => true,
          routeSave: async () => { dispatched += 1; return { ok: true }; },
        }));
        return { ok: true, scheduled: true };
      },
    },
    repository,
    getSave: () => save,
    now: () => 200,
  });
  assert.deepEqual(await restarted.recover(), { ok: true, count: 1 });
  await restartedTask;
  assert.equal(dispatched, 1);
  assert.equal(job.state, 'completed');
});

test('shared save notifiers preserve already-routed options', () => {
  const calls = [];
  saveNotifications.setSaveNotifier((record, options) => calls.push(['save', record.id, options]));
  saveNotifications.setBookmarkNotifier((record, options) => calls.push(['bookmark', record.id, options]));
  saveNotifications.setSaveChangedNotifier((saveId, context) => calls.push(['changed', saveId, context]));
  try {
    saveNotifications.notifySaved({ id: 'save-1' }, { backgroundRouted: true });
    saveNotifications.notifyBookmarkSaved({ id: 'save-2' }, { backgroundRouted: true });
    saveNotifications.notifySaveChanged('save-3', { kind: 'tag' });
  } finally {
    saveNotifications.setSaveNotifier(null);
    saveNotifications.setBookmarkNotifier(null);
    saveNotifications.setSaveChangedNotifier(null);
  }
  assert.deepEqual(calls, [
    ['save', 'save-1', { backgroundRouted: true }],
    ['bookmark', 'save-2', { backgroundRouted: true }],
    ['changed', 'save-3', { kind: 'tag' }],
  ]);
  const captureSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'capture.js'), 'utf8');
  assert.match(captureSource, /duplicateOf[\s\S]*notifySaveChanged\(imgData\.existing\.id/);
});

test('video routing rejects when its durable queue write fails', async () => {
  const error = new Error('video queue unavailable');
  const harness = createHarness({ videoPrepareError: error });
  const save = { id: 'video-write-failure', kind: 'video', file_path: '/tmp/failure.mp4' };
  harness.saves.set(save.id, save);
  harness.runtime.start();

  await assert.rejects(harness.runtime.routeSave(save), error);
  assert.equal(harness.events.some(({ event }) => event === 'video-analysis:updated'), true);
});

test('tracked image enrichment defers coordinator and lifecycle transition until old epoch drains', async () => {
  const gate = deferred();
  const taskStarted = deferred();
  const harness = createHarness();
  const save = { id: 'slow-image', kind: 'image', file_path: '/tmp/slow.png' };
  harness.saves.set(save.id, save);
  harness.rebuildQueue.push({ id: 'must-wait-for-enrichment' });
  harness.runtime.start();

  const scheduled = harness.runtime.scheduleForegroundTask(async ({ routeSave }) => {
    taskStarted.resolve();
    await gate.promise;
    await routeSave(save, { changed: true });
  });
  assert.deepEqual(scheduled, { ok: true, scheduled: true });
  await taskStarted.promise;
  const switching = harness.runtime.rebind(async () => harness.switchLibrary('library-b'));
  await Promise.resolve();
  assert.deepEqual(harness.recovery.map(({ library }) => library), ['library-a']);
  assert.deepEqual(harness.order, ['semantic-rebuild']);

  gate.resolve();
  await switching;
  assert.deepEqual(harness.recovery.map(({ library }) => library), ['library-a', 'library-b']);
  assert.deepEqual(harness.completions, []);
});

test('rapid foreground tasks run FIFO with concurrency one and lifecycle waits for the whole queue', async () => {
  const firstGate = deferred();
  const firstStarted = deferred();
  const taskOrder = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const harness = createHarness();
  harness.runtime.start();

  function track(name, wait = null) {
    return async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      taskOrder.push(`${name}:start`);
      if (name === 'first') firstStarted.resolve();
      try {
        if (wait) await wait;
      } finally {
        taskOrder.push(`${name}:end`);
        concurrent -= 1;
      }
    };
  }

  assert.deepEqual(harness.runtime.scheduleForegroundTask(track('first', firstGate.promise)), {
    ok: true, scheduled: true,
  });
  assert.deepEqual(harness.runtime.scheduleForegroundTask(track('second')), {
    ok: true, scheduled: true,
  });
  await firstStarted.promise;
  await Promise.resolve();
  assert.deepEqual(taskOrder, ['first:start']);

  const switching = harness.runtime.rebind(async () => {
    taskOrder.push('switch');
    harness.switchLibrary('library-b');
  });
  await Promise.resolve();
  assert.deepEqual(taskOrder, ['first:start']);

  firstGate.resolve();
  await switching;

  assert.deepEqual(taskOrder, [
    'first:start', 'first:end', 'second:start', 'second:end', 'switch',
  ]);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(harness.recovery.map(({ library }) => library), ['library-a', 'library-b']);
});

test('concurrent rebind requests serialize complete transitions in request order', async () => {
  const firstActionGate = deferred();
  const firstActionStarted = deferred();
  const order = [];
  const harness = createHarness();
  harness.runtime.setLifecycleHooks({
    beforeTransition: async () => { order.push('before'); },
    afterTransition: async () => { order.push('after'); },
  });
  harness.runtime.start();

  const first = harness.runtime.rebind(async () => {
    order.push('first:start');
    firstActionStarted.resolve();
    await firstActionGate.promise;
    harness.switchLibrary('library-b');
    order.push('first:end');
    return { ok: true, activeId: 'library-b' };
  });
  await firstActionStarted.promise;
  const second = harness.runtime.rebind(async () => {
    order.push('second:start');
    harness.switchLibrary('library-c');
    order.push('second:end');
    return { ok: true, activeId: 'library-c' };
  });

  await Promise.resolve();
  assert.deepEqual(order, ['before', 'first:start']);
  assert.deepEqual(harness.recovery.map(({ library }) => library), ['library-a']);

  firstActionGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { ok: true, activeId: 'library-b' });
  assert.deepEqual(secondResult, { ok: true, activeId: 'library-c' });
  assert.deepEqual(order, [
    'before', 'first:start', 'first:end', 'after',
    'before', 'second:start', 'second:end', 'after',
  ]);
  assert.deepEqual(
    harness.recovery.map(({ library }) => library),
    ['library-a', 'library-b', 'library-c'],
  );
});

test('automatic trash purge attempts derived cleanup for every purged save', async () => {
  const cleaned = [];
  const errors = [];
  const result = await cleanupPurgedSaveDerived({
    saveIds: ['save-a', 'save-b', 'save-c'],
    cleanupSaveDerived: async (saveId) => {
      cleaned.push(saveId);
      if (saveId === 'save-b') throw new Error('locked cache');
    },
    onError: (error, saveId) => errors.push([saveId, error.message]),
  });

  assert.deepEqual(cleaned, ['save-a', 'save-b', 'save-c']);
  assert.deepEqual(errors, [['save-b', 'locked cache']]);
  assert.deepEqual(result, { attempted: 3, failed: 1 });

  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(indexSource, /cleanupPurgedSaveDerived\(\{[\s\S]*saveIds: result\.ids/);
});

test('library rebind drains active old-library work before switch', async () => {
  const gate = deferred();
  const harness = createHarness({
    videoRun: async ({ job, repository }) => {
      await gate.promise;
      repository.completeVideoAnalysis({ id: job.id, fingerprint: job.fingerprint });
    },
  });
  const save = { id: 'epoch-video', kind: 'video', file_path: '/tmp/epoch.mp4' };
  harness.saves.set(save.id, save);
  harness.runtime.start();
  await harness.runtime.routeSave(save);
  await new Promise((resolve) => setImmediate(resolve));

  const switching = harness.runtime.rebind(async () => harness.switchLibrary('library-b'));
  gate.resolve();
  await switching;
  await harness.runtime.whenIdle();

  assert.equal(harness.completions.length, 1);
  assert.equal(harness.completions[0].library, 'library-a');
  assert.deepEqual(harness.recovery.map(({ library }) => library), ['library-a', 'library-b']);
});

test('semantic health is cached/nonblocking and cleanup/restore use lifecycle runtime', async () => {
  const healthGate = deferred();
  const harness = createHarness({ ollamaHealth: () => healthGate.promise });
  harness.runtime.start();

  assert.deepEqual(harness.runtime.getSemanticHealth(), {
    ok: null, status: 'checking', model: 'embeddinggemma', reason: null, setupAction: null,
  });
  healthGate.resolve({ ok: true, model: 'embeddinggemma' });
  await harness.runtime.refreshSemanticHealth();
  assert.equal(harness.runtime.getSemanticHealth().status, 'connected');
  assert.equal(
    harness.events.some(({ event, payload }) => (
      event === 'semantic-index:status' && payload.status === 'connected'
    )),
    true,
  );

  await harness.runtime.cleanupSaveDerived('save-1');
  await harness.runtime.cleanupAllDerived();
  assert.deepEqual(harness.cleanups, [
    { directory: '/derived/library-a', saveId: 'save-1' },
    { directory: '/derived/library-a', all: true },
  ]);
  assert.deepEqual(await harness.runtime.restoreBackup('/tmp/snapshot.db'), { ok: true });
  assert.equal(harness.restores.length, 1);
  assert.equal(harness.recovery.length, 2);
  assert.equal(harness.events.some(({ event }) => event === 'library:switched'), true);
});

test('semantic health refresh detects outage and recovery and emits only changes', async () => {
  let healthMode = 'connected';
  const harness = createHarness({
    ollamaHealth: async () => {
      if (healthMode === 'outage') {
        const error = new Error('Ollama stopped');
        error.code = 'ollama_unavailable';
        throw error;
      }
      return { ok: true, model: 'embeddinggemma' };
    },
  });
  harness.runtime.start();
  await harness.runtime.refreshSemanticHealth();
  const initialEvents = harness.events.filter(({ event }) => event === 'semantic-index:status').length;

  await harness.runtime.refreshSemanticHealth();
  assert.equal(harness.events.filter(({ event }) => event === 'semantic-index:status').length, initialEvents);
  healthMode = 'outage';
  await harness.runtime.refreshSemanticHealth();
  assert.equal(harness.runtime.getSemanticHealth().status, 'unavailable');
  healthMode = 'connected';
  await harness.runtime.refreshSemanticHealth();
  assert.equal(harness.runtime.getSemanticHealth().status, 'connected');
  assert.equal(
    harness.events.filter(({ event }) => event === 'semantic-index:status').length,
    initialEvents + 2,
  );
});

test('MP4 and video saves never enter image AI or topic-profile image evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-media-guard-'));
  const binaryPath = path.join(directory, 'file.bin');
  const mp4Path = path.join(directory, 'file.MP4');
  fs.writeFileSync(binaryPath, 'video-bytes');
  fs.writeFileSync(mp4Path, 'video-bytes');
  for (const save of [
    { id: 'kind-video', kind: 'video', file_path: binaryPath },
    { id: 'mp4-video', kind: 'image', file_path: mp4Path },
  ]) {
    assert.equal(isVideoSave(save), true);
    assert.equal(shouldUseImageAi(save), false);
    assert.equal(buildSaveTopicEvidence(save).imagePath, null);
  }

  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.doesNotMatch(indexSource, /\bembedText\b/);
  fs.rmSync(directory, { recursive: true, force: true });
});
