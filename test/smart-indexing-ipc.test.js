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

function loadIpc({ db = {}, settings = {}, openai = {}, windows = [] } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const electron = {
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
    },
    shell: functionModule(),
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
  let backfills = 0;
  let claimed = true;
  const repository = {
    backfillSaveBackgroundRoutes: () => { backfills += 1; return { ok: true, count: 1 }; },
    claimSaveBackgroundRoute: () => {
      if (!claimed) return undefined;
      claimed = false;
      return { save_id: 'save-image' };
    },
    completeSaveBackgroundRoute: (saveId) => completed.push(saveId),
    failSaveBackgroundRoute: () => ({ availableAt: 200 }),
    listPendingSaveBackgroundRoutes: () => [],
    getNextSaveBackgroundRouteReadyAt: () => null,
  };
  const router = createSaveBackgroundRouter({
    repository,
    backgroundRuntime: {
      routeSave: async () => ({ ok: true }),
      scheduleForegroundTask: async (task) => task({
        isCurrent: () => true,
        routeSave: async (save, options) => { calls.push([save.id, options]); return { ok: true }; },
      }),
    },
    enrichImageSave: async (save) => calls.push(['enrich', save.id]),
    isImageSave: () => true,
    getSave: (id) => ({ id, kind: 'image' }),
    now: () => 100,
  });
  await router.route({ id: 'save-image', kind: 'image' });
  assert.deepEqual(calls, [
    ['enrich', 'save-image'],
    ['save-image', { changed: true }],
  ]);
  assert.deepEqual(completed, ['save-image']);
  assert.equal((await router.route({ id: 'save-image' })).skipped, 'duplicate');
  await router.recover();
  assert.equal(backfills, 1);
});
