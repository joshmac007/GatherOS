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

test('duplicate routing retries missing durable semantic and video work', async () => {
  const harness = createHarness({ foregroundBusy: true });
  const save = { id: 'new-video', kind: 'video', file_path: '/tmp/new.mp4' };
  harness.saves.set(save.id, save);
  harness.runtime.start();

  const routed = await harness.runtime.routeSave(save, { duplicate: true });
  assert.equal(routed.ok, true);
  assert.equal(harness.videoQueue.length, 1);
  assert.equal(harness.incrementalQueue.length, 1);
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

test('extension success response waits once and marks notification as already routed', async () => {
  const gate = deferred();
  const order = [];
  let responseBody = null;
  const response = {
    writeHead() {},
    end(body) { order.push('response'); responseBody = JSON.parse(body); },
  };
  const completing = completeSavedResponse({
    res: response,
    record: { id: 'extension-video', kind: 'video' },
    notify: (_record, options) => order.push(['notify', options]),
    routeSave: async () => { await gate.promise; order.push('route'); },
  });
  await Promise.resolve();
  assert.equal(responseBody, null);

  gate.resolve();
  await completing;

  assert.deepEqual(order, [
    'route',
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

test('save router enriches images before one route, routes video immediately, and honors routed notifications', async () => {
  const order = [];
  const records = new Map([
    ['image-save', { id: 'image-save', kind: 'image', file_path: '/tmp/image.png' }],
    ['video-save', { id: 'video-save', kind: 'video', file_path: '/tmp/video.mp4' }],
  ]);
  const router = createSaveBackgroundRouter({
    backgroundRuntime: {
      async routeSave(record, options) {
        order.push(['route', record.id, options]);
        return { ok: true };
      },
    },
    getSave: (id) => records.get(id),
    enrichImageSave: async (record) => order.push(['enrich', record.id]),
    noteActivity: (payload) => order.push(['activity', payload.kind]),
  });

  await router.route(records.get('image-save'));
  await router.route(records.get('video-save'));
  assert.equal(router.notify(records.get('video-save'), { backgroundRouted: true }), null);
  await router.route(records.get('image-save'), { duplicate: true });

  assert.deepEqual(order, [
    ['activity', 'save'],
    ['enrich', 'image-save'],
    ['route', 'image-save', { duplicate: false, changed: true }],
    ['activity', 'save'],
    ['route', 'video-save', { duplicate: false, changed: false }],
    ['activity', 'duplicate'],
    ['route', 'image-save', { duplicate: true, changed: false }],
  ]);

  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(indexSource, /isForegroundBusy: \(\) => foregroundActivity\.isBusy\(\)/);
  assert.match(indexSource, /function notifySaved\(record, options = \{\}\)[\s\S]*routeNewSaveToBackground\(record, options\)/);
});

test('shared save notifiers preserve already-routed options', () => {
  const calls = [];
  saveNotifications.setSaveNotifier((record, options) => calls.push(['save', record.id, options]));
  saveNotifications.setBookmarkNotifier((record, options) => calls.push(['bookmark', record.id, options]));
  try {
    saveNotifications.notifySaved({ id: 'save-1' }, { backgroundRouted: true });
    saveNotifications.notifyBookmarkSaved({ id: 'save-2' }, { backgroundRouted: true });
  } finally {
    saveNotifications.setSaveNotifier(null);
    saveNotifications.setBookmarkNotifier(null);
  }
  assert.deepEqual(calls, [
    ['save', 'save-1', { backgroundRouted: true }],
    ['bookmark', 'save-2', { backgroundRouted: true }],
  ]);
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

test('library rebind invalidates active epoch before switch and stale completion cannot write', async () => {
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

  assert.deepEqual(harness.completions, []);
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
