const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

function functionModule(overrides = {}) {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key];
      return () => undefined;
    },
  });
}

function loadIpc({
  db = {},
  settings = {},
  notify = {},
  storage = {},
  openai = {},
  dialog = {},
  windows = [],
} = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const electron = {
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
    },
    shell: functionModule(),
    dialog: functionModule(dialog),
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
    './notify': functionModule(notify),
    './storage': functionModule(storage),
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
  try {
    loaded = require(ipcPath);
  } finally {
    Module._load = originalLoad;
  }
  return { ...loaded, handlers, listeners };
}

function senderEvents() {
  const events = [];
  return {
    events,
    event: { sender: { send: (channel, payload) => events.push([channel, payload]) } },
  };
}

test('registers scoped semantic queue controls and uses semantic search without Codex gate', async () => {
  const saves = new Map([
    ['save-a', { id: 'save-a', title: 'Aviation reference' }],
    ['save-b', { id: 'save-b', title: 'Brand board' }],
  ]);
  const semanticIndex = {
    status: () => ({
      active_generation_id: 'active',
      building_generation_id: 'building',
      searchReady: true,
    }),
    queue: () => [
      { id: 'a', generation_id: 'active', save_id: 'save-a', kind: 'incremental' },
      { id: 'b', generation_id: 'building', save_id: 'save-b', kind: 'rebuild' },
      { id: 'old', generation_id: 'retired', save_id: 'save-a', kind: 'incremental' },
    ],
    pause: () => ({ ok: true }),
    resume: () => ({ ok: true }),
    retryFailed: () => ({ ok: true }),
    dismissFailed: () => ({ ok: true }),
    startRebuild: () => ({ ok: true }),
    cancelRebuild: () => ({ ok: true }),
  };
  let searches = 0;
  const semanticSearch = {
    search: async () => { searches += 1; return { results: [{ id: 'save-a' }] }; },
    findSimilar: () => ({ results: [{ id: 'save-b' }] }),
  };
  let healthRefreshes = 0;
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSave: (id) => saves.get(id),
      getAllSaves: () => [],
      filterByColor: (rows) => rows,
    },
  });
  registerIpcHandlers({
    semanticIndex,
    semanticSearch,
    backgroundRuntime: {
      getSemanticHealth: () => ({ ok: true, status: 'connected', model: 'embeddinggemma' }),
      refreshSemanticHealth: async () => { healthRefreshes += 1; },
    },
  });

  const status = await handlers.get('semantic-index:status')();
  assert.equal(healthRefreshes, 1);
  assert.equal(status.connected, true);
  assert.equal(status.modelInstalled, true);
  const queue = await handlers.get('semantic-index:queue')();
  assert.deepEqual(queue.map((job) => [job.id, job.title]), [
    ['a', 'Aviation reference'],
    ['b', 'Brand board'],
  ]);
  assert.deepEqual(await handlers.get('saves:get-all')(null, { search: 'aviation' }), [{ id: 'save-a' }]);
  assert.equal(searches, 1);
  assert.deepEqual(await handlers.get('saves:find-similar')(null, 'save-a', 5), [{ id: 'save-b' }]);
  await handlers.get('semantic-index:resume')();
  assert.equal(healthRefreshes, 2);
  for (const channel of [
    'semantic-index:pause', 'semantic-index:resume', 'semantic-index:retry-failed',
    'semantic-index:dismiss-failed', 'semantic-index:start-rebuild', 'semantic-index:cancel-rebuild',
  ]) {
    assert.equal(typeof handlers.get(channel), 'function', channel);
  }
});

test('video accept enqueues semantic work once while dismiss never enqueues', async () => {
  const suggestions = [
    { id: 'one', save_id: 'video-save', state: 'suggested' },
    { id: 'two', save_id: 'video-save', state: 'suggested' },
  ];
  let enqueued = 0;
  const accepted = [];
  const dismissed = [];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSave: () => ({ id: 'video-save', title: 'Video' }),
      getVideoAnalysis: () => ({ save_id: 'video-save', state: 'completed' }),
      listVideoTagSuggestions: () => suggestions,
      acceptVideoTagSuggestion: ({ suggestionId }) => {
        accepted.push(suggestionId);
        return { ok: true, saveId: 'video-save' };
      },
      dismissVideoTagSuggestion: ({ suggestionId }) => {
        dismissed.push(suggestionId);
        return { ok: true, saveId: 'video-save' };
      },
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}), queue: () => [],
      enqueue: () => { enqueued += 1; return { ok: true }; },
    },
  });
  const sent = senderEvents();

  assert.equal((await handlers.get('video-analysis:accept')(sent.event, 'one')).ok, true);
  assert.equal(enqueued, 1);
  assert.equal((await handlers.get('video-analysis:dismiss')(sent.event, 'two')).ok, true);
  assert.equal(enqueued, 1);
  enqueued = 0;
  accepted.length = 0;
  assert.equal((await handlers.get('video-analysis:accept-all')(sent.event, 'video-save')).accepted, 2);
  assert.deepEqual(accepted, ['one', 'two']);
  assert.equal(enqueued, 1);
  assert.equal((await handlers.get('video-analysis:dismiss-all')(sent.event, 'video-save')).dismissed, 2);
  assert.equal(enqueued, 1);
  assert.equal(sent.events.every(([channel]) => channel === 'video-analysis:updated'), true);
});

test('canonical save and tag mutations enqueue incremental semantic work after success', async () => {
  const enqueued = [];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      updateSave: ({ id }) => ({ ok: id !== 'failed' }),
      addTagToSave: ({ saveId }) => ({ ok: saveId !== 'failed' }),
      removeTagFromSave: ({ saveId }) => ({ ok: saveId !== 'failed' }),
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}),
      queue: () => [],
      enqueue: (saveId) => { enqueued.push(saveId); return { ok: true }; },
    },
  });

  await handlers.get('saves:update')(null, { id: 'save-a', title: 'Updated' });
  await handlers.get('tags:add-to-save')(null, { saveId: 'save-a', name: 'aviation' });
  await handlers.get('tags:remove-from-save')(null, { saveId: 'save-a', tagId: 'tag-a' });
  await handlers.get('saves:update')(null, { id: 'failed', title: 'No write' });
  await handlers.get('tags:add-to-save')(null, { saveId: 'failed', name: 'no write' });
  await handlers.get('tags:remove-from-save')(null, { saveId: 'failed', tagId: 'tag-a' });

  assert.deepEqual(enqueued, ['save-a', 'save-a', 'save-a']);
});

test('video context edits reprepare analysis while ordinary tag changes stay semantic-only', async () => {
  const routes = [];
  const semantic = [];
  const video = { id: 'video-context', kind: 'video', file_path: '/tmp/context.mp4', title: 'Before' };
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSave: () => video,
      updateSave: (payload) => { Object.assign(video, payload); return { ok: true }; },
      addTagToSave: () => ({ ok: true }),
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}),
      queue: () => [],
      enqueue: async (saveId) => { semantic.push(saveId); return { ok: true }; },
    },
    backgroundRuntime: {
      routeSave: async (save, options) => { routes.push([save.id, options]); return { ok: true }; },
    },
  });

  await handlers.get('saves:update')(null, { id: video.id, title: 'After' });
  await handlers.get('saves:update')(null, { id: video.id, notes: 'New context' });
  await handlers.get('tags:add-to-save')(null, { saveId: video.id, name: 'accepted tag' });

  assert.deepEqual(routes, [
    [video.id, { changed: true, reanalyzeVideo: true }],
    [video.id, { changed: true, reanalyzeVideo: true }],
  ]);
  assert.deepEqual(semantic, [video.id]);
});

test('global tag mutations enqueue every affected save once', async () => {
  const enqueued = [];
  const affected = {
    'tag-rename': ['save-a', 'save-b', 'save-a'],
    'tag-delete': ['save-b', 'save-c'],
  };
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSaveIdsForTag: (tagId) => affected[tagId] || [],
      renameTag: () => ({ ok: true, tag: { id: 'tag-rename', name: 'renamed' } }),
      deleteTag: () => ({ ok: true, removed: 2 }),
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}),
      queue: () => [],
      enqueue: (saveId) => { enqueued.push(saveId); return { ok: true }; },
    },
  });

  assert.equal((await handlers.get('tags:rename')(null, {
    id: 'tag-rename', name: 'renamed',
  })).ok, true);
  assert.equal((await handlers.get('tags:delete')(null, 'tag-delete')).ok, true);

  assert.deepEqual(enqueued, ['save-a', 'save-b', 'save-b', 'save-c']);
});

test('auto-tag enqueues its save once after committed tag mutations', async () => {
  const enqueued = [];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      getSave: () => ({ id: 'save-a', kind: 'image', file_path: '/tmp/a.png' }),
      addTagToSave: ({ name }) => ({ ok: true, tag: { id: `tag-${name}`, name } }),
    },
    openai: {
      hasSession: () => true,
      autoTagImage: async () => ['aviation', 'cockpit'],
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}),
      queue: () => [],
      enqueue: (saveId) => { enqueued.push(saveId); return { ok: true }; },
    },
  });

  const result = await handlers.get('ai:auto-tag')(null, 'save-a');

  assert.equal(result.ok, true);
  assert.equal(result.tags.length, 2);
  assert.deepEqual(enqueued, ['save-a']);
});

test('semantic enqueue failures warn without rejecting committed mutations or broadcasts', async () => {
  const suggestions = [{ id: 'one', save_id: 'save-a', state: 'suggested' }];
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      updateSave: () => ({ ok: true }),
      addTagToSave: () => ({ ok: true, tag: { id: 'tag-a', name: 'aviation' } }),
      removeTagFromSave: () => ({ ok: true }),
      getSave: () => ({ id: 'save-a', kind: 'image', file_path: '/tmp/a.png' }),
      getVideoAnalysis: () => ({ save_id: 'save-a', state: 'completed' }),
      listVideoTagSuggestions: () => suggestions,
      acceptVideoTagSuggestion: () => ({ ok: true, saveId: 'save-a' }),
    },
  });
  registerIpcHandlers({
    semanticIndex: {
      status: () => ({}),
      queue: () => [],
      enqueue: () => { throw new Error('index queue unavailable'); },
    },
  });
  const sent = senderEvents();

  for (const [channel, payload] of [
    ['saves:update', { id: 'save-a', title: 'Updated' }],
    ['tags:add-to-save', { saveId: 'save-a', name: 'aviation' }],
    ['tags:remove-from-save', { saveId: 'save-a', tagId: 'tag-a' }],
  ]) {
    const result = await handlers.get(channel)(null, payload);
    assert.equal(result.ok, true, channel);
    assert.equal(result.semanticWarning?.reason, 'semantic-enqueue-failed', channel);
  }

  const accepted = await handlers.get('video-analysis:accept')(sent.event, 'one');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.semanticWarning?.reason, 'semantic-enqueue-failed');
  assert.deepEqual(sent.events, [['video-analysis:updated', { saveId: 'save-a' }]]);

  sent.events.length = 0;
  const acceptedAll = await handlers.get('video-analysis:accept-all')(sent.event, 'save-a');
  assert.equal(acceptedAll.ok, true);
  assert.equal(acceptedAll.accepted, 1);
  assert.equal(acceptedAll.semanticWarning?.reason, 'semantic-enqueue-failed');
  assert.deepEqual(sent.events, [['video-analysis:updated', { saveId: 'save-a' }]]);
});

test('permanent delete reports success and broadcasts when derived cleanup fails', async () => {
  const broadcasts = [];
  let trayRefreshes = 0;
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      permanentlyDeleteSave: () => ({
        ok: true,
        filePath: '/tmp/image.png',
        thumbPath: '/tmp/thumb.png',
      }),
    },
    notify: { refreshTray: () => { trayRefreshes += 1; } },
    storage: { deleteImageFiles: () => undefined },
    windows: [{ webContents: { send: (...args) => broadcasts.push(args) } }],
  });
  registerIpcHandlers({
    backgroundRuntime: {
      cleanupSaveDerived: async () => { throw new Error('cache unavailable'); },
    },
  });

  const result = await handlers.get('saves:permanent-delete')(null, 'save-a');

  assert.equal(result.ok, true);
  assert.equal(result.cleanupWarning?.reason, 'derived-cleanup-failed');
  assert.deepEqual(broadcasts, [['save:deleted', { ids: ['save-a'] }]]);
  assert.equal(trayRefreshes, 1);
});

test('empty trash reports deleted count and broadcasts when derived cleanup fails', async () => {
  const broadcasts = [];
  let trayRefreshes = 0;
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      emptyTrash: () => ({
        ok: true,
        ids: ['save-a', 'save-b'],
        files: [
          { filePath: '/tmp/a.png', thumbPath: '/tmp/a-thumb.png' },
          { filePath: '/tmp/b.png', thumbPath: '/tmp/b-thumb.png' },
        ],
      }),
    },
    notify: { refreshTray: () => { trayRefreshes += 1; } },
    storage: { deleteImageFiles: () => undefined },
    windows: [{ webContents: { send: (...args) => broadcasts.push(args) } }],
  });
  registerIpcHandlers({
    backgroundRuntime: {
      cleanupSaveDerived: async () => { throw new Error('cache unavailable'); },
    },
  });

  const result = await handlers.get('saves:empty-trash')();

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.cleanupWarning?.reason, 'derived-cleanup-failed');
  assert.equal(result.cleanupWarning?.count, 2);
  assert.deepEqual(broadcasts, [['save:deleted', { ids: ['save-a', 'save-b'] }]]);
  assert.equal(trayRefreshes, 1);
});

test('wipe returns committed success with warning when derived cleanup fails', async () => {
  const { registerIpcHandlers, handlers } = loadIpc({
    db: {
      wipeLibrary: () => ({
        ok: true,
        files: [{ filePath: '/tmp/a.png', thumbPath: '/tmp/a-thumb.png' }],
      }),
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    storage: { deleteImageFiles: () => undefined },
  });
  registerIpcHandlers({
    backgroundRuntime: {
      cleanupAllDerived: async () => { throw new Error('cache unavailable'); },
    },
  });

  const result = await handlers.get('library:wipe-all')({ sender: {} });

  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(result.cleanupWarning?.reason, 'derived-cleanup-failed');
});

test('preload exposes exact semantic and video APIs and allowed events', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  for (const method of [
    'status', 'queue', 'pause', 'resume', 'retryFailed', 'dismissFailed',
    'startRebuild', 'cancelRebuild',
  ]) assert.match(preload, new RegExp(`${method}:`));
  for (const method of ['getForSave', 'accept', 'dismiss', 'acceptAll', 'dismissAll']) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  for (const event of [
    'semantic-index:status', 'semantic-index:progress', 'semantic-index:notice',
    'video-analysis:updated',
  ]) assert.match(preload, new RegExp(event));

  const runtime = fs.readFileSync(
    path.join(ROOT, 'src', 'main', 'video-semantic-workflows.js'), 'utf8',
  );
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.jsx'), 'utf8');
  assert.doesNotMatch(runtime, /emit\(['"]semantic-index:health['"]/);
  assert.match(runtime, /emit\(['"]semantic-index:status['"]/);
  assert.match(app, /on\?\.\(['"]semantic-index:status['"],\s*refreshSemanticStatus\)/);
  assert.match(app, /subscribeSemanticNotices\(window\.moodmark/);
  assert.match(app, /showActionToast\(\{ message, durationMs: 4200 \}\)/);
});

test('ipc removes legacy embedding consumers and guards image-only AI for video', () => {
  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  assert.doesNotMatch(ipc, /\bembedText\b/);
  assert.doesNotMatch(ipc, /\bgetSaveEmbeddingsCached\b/);
  assert.doesNotMatch(ipc, /\bgetUnindexedSaves\b/);
  assert.match(ipc, /image-ai-unavailable-for-video/);
  assert.match(ipc, /cleanupSaveDerived|cleanupDerivedCache/);
  assert.match(ipc, /restoreBackup/);
});

test('app semantic availability derives from semantic status, not Codex session', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.jsx'), 'utf8');
  assert.match(app, /semanticStatus\?\.searchReady/);
  assert.doesNotMatch(
    app,
    /semanticSearchActive\s*=\s*aiConfigured\s*&&/,
  );
});
