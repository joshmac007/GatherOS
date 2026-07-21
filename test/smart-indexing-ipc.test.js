'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createForegroundActivityTracker } = require('../src/main/foreground-activity');
const { createSaveBackgroundRouter } = require('../src/main/save-background-router');

const ROOT = path.join(__dirname, '..');

function functionModule(overrides = {}) {
  return new Proxy(overrides, {
    get(target, key) { return key in target ? target[key] : () => undefined; },
  });
}

function loadIpc({ db = {}, settings = {}, openai = {}, windows = [], shell = {} } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const electron = {
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
    },
    shell: functionModule(shell),
    dialog: functionModule(),
    BrowserWindow: {
      getAllWindows: () => windows,
      fromWebContents: () => null,
    },
    nativeImage: functionModule({ createEmpty: () => ({}) }),
    clipboard: functionModule(),
    app: { isPackaged: false },
    Menu: functionModule(),
  };
  const modules = {
    './db': functionModule(db),
    './settings': functionModule({ getPref: () => true, ...settings }),
    './openai': functionModule({ hasSession: () => false, ...openai }),
    './notify': functionModule(),
    './storage': functionModule(),
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    if (parent?.filename?.endsWith(`${path.sep}src${path.sep}main${path.sep}ipc.js`)) {
      if (modules[request]) return modules[request];
      if (request.startsWith('./') || request.startsWith('../')) return functionModule();
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const ipcPath = path.join(ROOT, 'src', 'main', 'ipc.js');
  delete require.cache[require.resolve(ipcPath)];
  let loaded;
  try { loaded = require(ipcPath); } finally { Module._load = originalLoad; }
  return { ...loaded, handlers, listeners };
}

test('semantic IPC uses generation service and keeps palette fallback', async () => {
  const palette = [{ id: 'palette-fallback' }];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSave: (id) => ({ id, title: id }),
      getAllSaves: () => [],
      filterByColor: (rows) => rows,
      findSimilarByPalette: () => palette,
    },
  });
  const searches = [];
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({ active_generation_id: 'active', building_generation_id: null, total: 3, indexed: 2 }),
      queue: () => [{ id: 'job', generation_id: 'active', save_id: 'save-a' }],
      startRebuild: () => ({ ok: true, generation: 'next' }),
    },
    semanticSearch: {
      search: async (query) => { searches.push(query); return { results: [{ id: 'semantic' }] }; },
      findSimilar: async () => { throw new Error('provider unavailable'); },
    },
  });
  assert.deepEqual(await handlers.get('saves:get-all')(null, { search: 'aircraft' }), [{ id: 'semantic' }]);
  assert.deepEqual(searches, ['aircraft']);
  assert.deepEqual(await handlers.get('saves:find-similar')(null, 'save-a', 5), palette);
  assert.equal(await handlers.get('ai:unindexed-count')(), 1);
  assert.equal((await handlers.get('ai:reindex-library')()).ok, true);
  assert.equal((await handlers.get('semantic-index:queue')())[0].title, 'save-a');
});

test('canonical mutations enqueue generation work once per affected save', async () => {
  const enqueued = [];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSave: () => ({ id: 'save-a', kind: 'image' }),
      updateSave: () => ({ ok: true }),
      addTagToSave: () => ({ ok: true }),
      removeTagFromSave: () => ({ ok: true }),
      getSaveIdsForTag: () => ['save-a', 'save-b', 'save-a'],
      renameTag: () => ({ ok: true }),
      deleteTag: () => ({ ok: true }),
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}),
      queue: () => [],
      enqueue: async (saveId) => { enqueued.push(saveId); return { ok: true }; },
    },
  });
  await handlers.get('saves:update')(null, { id: 'save-a', title: 'Changed' });
  await handlers.get('tags:add-to-save')(null, { saveId: 'save-a', name: 'design' });
  await handlers.get('tags:remove-from-save')(null, { saveId: 'save-a', tagId: 'tag-a' });
  await handlers.get('tags:rename')(null, { id: 'tag-global', name: 'layout' });
  await handlers.get('tags:delete')(null, 'tag-global');
  assert.deepEqual(enqueued, [
    'save-a', 'save-a', 'save-a',
    'save-a', 'save-b',
    'save-a', 'save-b',
  ]);
});

test('video suggestion acceptance enqueues semantic work while dismissal does not', async () => {
  const suggestions = [{ id: 'one', state: 'suggested' }, { id: 'two', state: 'suggested' }];
  let enqueued = 0;
  const sent = [];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      listVideoTagSuggestions: () => suggestions,
      acceptVideoTagSuggestion: ({ suggestionId }) => ({ ok: true, saveId: 'video', suggestionId }),
      dismissVideoTagSuggestion: ({ suggestionId }) => ({ ok: true, saveId: 'video', suggestionId }),
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}), queue: () => [],
      enqueue: () => { enqueued += 1; return { ok: true }; },
    },
  });
  const event = { sender: { send: (...args) => sent.push(args) } };
  assert.equal((await handlers.get('video-analysis:accept')(event, 'one')).ok, true);
  assert.equal(enqueued, 1);
  assert.equal((await handlers.get('video-analysis:dismiss')(event, 'two')).ok, true);
  assert.equal(enqueued, 1);
  assert.equal((await handlers.get('video-analysis:accept-all')(event, 'video')).accepted, 2);
  assert.equal(enqueued, 2);
  assert.equal(sent.every(([channel]) => channel === 'video-analysis:updated'), true);
});

test('backup restore drains and rebinds through background runtime', async () => {
  const { registerIpcHandlers, handlers } = loadIpc();
  const restored = [];
  registerIpcHandlers({
    backgroundRuntime: {
      restoreBackup: async (snapshotPath) => {
        restored.push(snapshotPath);
        return { ok: true };
      },
    },
  });
  assert.deepEqual(
    await handlers.get('backup:restore')(null, '/tmp/snapshot.db'),
    { ok: true },
  );
  assert.deepEqual(restored, ['/tmp/snapshot.db']);
});

test('preload exposes smart categories, semantic controls, existing video bridge, and notices', () => {
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
    ipcRenderer: functionModule({ sendSync: () => null }),
    webUtils: { getPathForFile: () => null },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadPath = path.join(ROOT, 'src', 'main', 'preload.js');
  delete require.cache[require.resolve(preloadPath)];
  try { require(preloadPath); } finally { Module._load = originalLoad; }
  assert.equal(typeof exposed.smartCategories.listNav, 'function');
  assert.equal(typeof exposed.semanticIndex.startRebuild, 'function');
  assert.equal(typeof exposed.videoAnalysis.acceptAll, 'function');
  for (const channel of ['semantic-index:status', 'semantic-index:progress', 'semantic-index:notice', 'video-analysis:updated']) {
    assert.doesNotThrow(() => exposed.on(channel, () => {}));
  }
});

test('AI auth IPC returns only sanitized state and keeps completion credentials private', async () => {
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  let state = 'signed_out';
  const sent = [];
  let refreshed = 0;
  const auth = {
    snapshot: () => ({ state, authenticated: state === 'authenticated', accessToken: 'secret' }),
    beginAuthorization: async () => {
      state = 'authorizing';
      return { url: 'https://auth.openai.com/oauth/authorize', completion };
    },
    cancelAuthorization: () => { state = 'signed_out'; },
    logout: () => { state = 'signed_out'; return auth.snapshot(); },
  };
  const { registerIpcHandlers, handlers } = loadIpc({
    windows: [{ webContents: { send: (...args) => sent.push(args) } }],
    shell: { openExternal: async () => {} },
  });
  registerIpcHandlers({
    aiFacade: { hasSession: () => false, getAccess: () => ({}), getUsage: async () => null },
    aiAuth: auth,
    onAiAuthenticated: () => { refreshed += 1; },
  });
  assert.deepEqual(await handlers.get('ai:auth:login')(), {
    state: 'authorizing', authenticated: false, error: null,
  });
  state = 'authenticated';
  resolveCompletion({ accessToken: 'must-not-cross-ipc', refreshToken: 'also-secret' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, 1);
  assert.deepEqual(sent.at(-1), ['ai:auth:status', {
    state: 'authenticated', authenticated: true, error: null,
  }]);
  assert.equal(JSON.stringify(sent).includes('secret'), false);
});

test('second AI login click preserves first pending authorization', async () => {
  const completion = new Promise(() => {});
  let state = 'signed_out';
  let begins = 0;
  let cancels = 0;
  let opened = 0;
  const auth = {
    snapshot: () => ({ state }),
    beginAuthorization: async () => {
      begins += 1;
      if (begins > 1) {
        const error = new Error('Sign in already in progress');
        error.code = 'AI_AUTH_BUSY';
        throw error;
      }
      state = 'authorizing';
      return { url: 'https://auth.openai.com/oauth/authorize', completion };
    },
    cancelAuthorization: () => { cancels += 1; state = 'signed_out'; },
  };
  const { registerIpcHandlers, handlers } = loadIpc({
    shell: { openExternal: async () => { opened += 1; } },
  });
  registerIpcHandlers({
    aiFacade: { hasSession: () => false, getAccess: () => ({}), getUsage: async () => null },
    aiAuth: auth,
  });
  assert.equal((await handlers.get('ai:auth:login')()).state, 'authorizing');
  assert.deepEqual(await handlers.get('ai:auth:login')(), {
    state: 'authorizing', authenticated: false, error: null,
  });
  assert.equal(opened, 1);
  assert.equal(cancels, 0);
});

test('AI logout failure preserves authentication and broadcasts sanitized error', () => {
  const sent = [];
  const auth = {
    snapshot: () => ({ state: 'authenticated', authenticated: true, accessToken: 'secret' }),
    logout: () => {
      const error = new Error('disk details must stay private');
      error.code = 'AI_AUTH_PERSIST_FAILED';
      throw error;
    },
  };
  const { registerIpcHandlers, handlers } = loadIpc({
    windows: [{ webContents: { send: (...args) => sent.push(args) } }],
  });
  registerIpcHandlers({
    aiFacade: { hasSession: () => true, getAccess: () => ({}), getUsage: async () => null },
    aiAuth: auth,
  });
  const status = handlers.get('ai:auth:logout')();
  assert.deepEqual(status, {
    state: 'authenticated', authenticated: true,
    error: { code: 'AI_AUTH_PERSIST_FAILED', message: 'Could not securely save sign in' },
  });
  assert.deepEqual(sent.at(-1), ['ai:auth:status', status]);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('disk details'), false);
});

test('preload AI auth status subscription validates callback and unsubscribes', () => {
  let exposed;
  const listeners = new Map();
  const removed = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
    ipcRenderer: functionModule({
      sendSync: () => null,
      on: (channel, handler) => listeners.set(channel, handler),
      removeListener: (channel, handler) => removed.push([channel, handler]),
    }),
    webUtils: { getPathForFile: () => null },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadPath = path.join(ROOT, 'src', 'main', 'preload.js');
  delete require.cache[require.resolve(preloadPath)];
  try { require(preloadPath); } finally { Module._load = originalLoad; }
  assert.throws(() => exposed.ai.auth.onStatus(null), /callback/);
  let observed;
  const off = exposed.ai.auth.onStatus((status) => { observed = status; });
  listeners.get('ai:auth:status')(null, { state: 'authenticated' });
  assert.deepEqual(observed, { state: 'authenticated' });
  off();
  assert.deepEqual(removed, [['ai:auth:status', listeners.get('ai:auth:status')]]);
});

test('foreground activity extends quiet window and wakes once idle', () => {
  let timestamp = 100;
  let timer;
  let idle = 0;
  const tracker = createForegroundActivityTracker({
    quietMs: 50,
    now: () => timestamp,
    setTimer: (callback) => { timer = callback; return { unref() {} }; },
    clearTimer: () => {},
    onIdle: () => { idle += 1; },
  });
  assert.equal(tracker.noteActivity(), 150);
  assert.equal(tracker.isBusy(), true);
  timestamp = 150;
  timer();
  assert.equal(tracker.isBusy(), false);
  assert.equal(idle, 1);
});

test('durable router claims once, enriches images, and completes outbox', async () => {
  const completed = [];
  const calls = [];
  const tasks = [];
  let backfills = 0;
  const route = { save_id: 'save-image', state: 'pending', available_at: 100 };
  const repository = {
    backfillSaveBackgroundRoutes: () => { backfills += 1; return { ok: true, count: 1 }; },
    getSaveBackgroundRoute: () => route,
    claimSaveBackgroundRoute: () => {
      if (route.state !== 'pending') return undefined;
      route.state = 'running';
      return route;
    },
    completeSaveBackgroundRoute: (saveId) => { route.state = 'completed'; completed.push(saveId); },
    failSaveBackgroundRoute: () => ({ availableAt: 200 }),
    listPendingSaveBackgroundRoutes: () => [],
    getNextSaveBackgroundRouteReadyAt: () => null,
  };
  const router = createSaveBackgroundRouter({
    repository,
    backgroundRuntime: {
      routeSave: async () => ({ ok: true }),
      scheduleForegroundTask: (task) => {
        tasks.push(Promise.resolve().then(() => task({
          isCurrent: () => true,
          routeSave: async (save, options) => { calls.push([save.id, options]); return { ok: true }; },
        })));
        return { ok: true, scheduled: true };
      },
    },
    enrichImageSave: async (save) => calls.push(['enrich', save.id]),
    isImageSave: () => true,
    getSave: (id) => ({ id, kind: 'image' }),
    now: () => 100,
  });
  assert.deepEqual(router.enqueue({ id: 'save-image', kind: 'image' }), { ok: true, scheduled: true });
  assert.equal(route.state, 'pending');
  await Promise.all(tasks);
  assert.deepEqual(calls, [
    ['enrich', 'save-image'],
    ['save-image', { changed: true }],
  ]);
  assert.deepEqual(completed, ['save-image']);
  assert.equal(router.enqueue({ id: 'save-image' }).skipped, 'duplicate');
  await router.recover();
  assert.equal(backfills, 1);
});

test('durable router marks a changed non-image duplicate for semantic re-indexing', async () => {
  const calls = [];
  const route = { save_id: 'article-save', state: 'pending', available_at: 100 };
  const router = createSaveBackgroundRouter({
    repository: {
      getSaveBackgroundRoute: () => route,
      claimSaveBackgroundRoute: () => { route.state = 'running'; return route; },
      completeSaveBackgroundRoute: () => { route.state = 'completed'; },
      failSaveBackgroundRoute: () => ({ availableAt: 200 }),
      getNextSaveBackgroundRouteReadyAt: () => null,
    },
    backgroundRuntime: {
      routeSave: async () => ({ ok: true }),
      scheduleForegroundTask: (task) => {
        Promise.resolve().then(() => task({
          isCurrent: () => true,
          routeSave: async (_save, options) => { calls.push(options); return { ok: true }; },
        }));
        return { ok: true };
      },
    },
    isImageSave: () => false,
    now: () => 100,
  });
  router.enqueue({ id: 'article-save', kind: 'url' }, { duplicate: true, changed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ changed: true }]);
});
