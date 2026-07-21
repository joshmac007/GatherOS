const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'src', 'main', 'extension-server.js');
const TOKEN = 't'.repeat(32);

function loadServer({ storage = {}, db = {}, settings = {}, tweetCardCapture, urlCapture } = {}) {
  const originalLoad = Module._load;
  const fakeDb = {
    insertSave: () => ({ id: 'saved' }),
    isTweetDismissed: () => false,
    sourceKeyFromUrl: () => null,
    enrichActiveSaveBySourceKey: () => ({ record: null, changed: false }),
    ...db,
  };
  const fakeStorage = {
    saveImageFromUrl: async () => ({ id: 'img', filePath: '/tmp/img', thumbPath: '/tmp/thumb' }),
    saveVideoFromUrl: async () => ({ id: 'vid', filePath: '/tmp/video', thumbPath: '/tmp/poster' }),
    saveAuxMedia: async () => null,
    ...storage,
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent?.filename === SERVER_FILE) {
      if (request === './settings') return {
        getPref: (name, fallback) => name === 'extensionToken'
          ? TOKEN
          : Object.prototype.hasOwnProperty.call(settings, name) ? settings[name] : fallback,
        setPref() {},
      };
      if (request === './storage') return fakeStorage;
      if (request === './db') return fakeDb;
      if (request === './notify') return {
        notifySaved() {}, notifyDuplicate() {}, notifyBookmarkSaved() {}, notifyBookmarkFailed() {}, notifyError() {},
      };
      if (request === './tweetCardCapture') return { captureTweetCard: tweetCardCapture || fakeStorage.captureTweetCard };
      if (request === './urlCapture') return { captureUrl: urlCapture || fakeStorage.captureUrl };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(SERVER_FILE)];
  const server = require(SERVER_FILE);
  server.__restoreTestModules = () => {
    Module._load = originalLoad;
    delete require.cache[require.resolve(SERVER_FILE)];
  };
  return server;
}

function invoke(server, body) {
  const req = new EventEmitter();
  req.headers = { origin: 'chrome-extension://test', 'x-gatheros-token': server.getOrCreateToken() };
  const response = new Promise((resolve) => {
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status; },
      end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload || '{}') }); },
    };
    server.handleSave(req, res);
  });
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return { req, response };
}

function freshPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-save-cancel-')), name);
}

test('download cancellation returns failure before insert', async (t) => {
  let started;
  const reachedDownload = new Promise((resolve) => { started = resolve; });
  let inserts = 0;
  const server = loadServer({
    storage: {
      saveImageFromUrl: (_url, { signal }) => new Promise((resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted download'), { name: 'AbortError' })), { once: true });
      }),
    },
    db: { insertSave: () => { inserts += 1; return { id: 'saved' }; } },
  });
  t.after(server.__restoreTestModules);
  const call = invoke(server, { imageUrl: 'https://cdn.example/image.jpg' });
  await reachedDownload;
  call.req.emit('aborted');
  const response = await call.response;
  assert.equal(response.status, 504);
  assert.equal(inserts, 0);
});

test('processing cancellation removes only request-created files before insert', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-save-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requestFile = path.join(directory, 'request.webp');
  const requestThumb = path.join(directory, 'request.jpg');
  const existingFile = path.join(directory, 'existing.webp');
  fs.writeFileSync(existingFile, 'keep');
  let inserts = 0;
  let currentReq;
  const server = loadServer({
    storage: {
      saveImageFromUrl: async (_url, { signal, onCreated }) => {
        fs.writeFileSync(requestFile, 'request'); fs.writeFileSync(requestThumb, 'thumb');
        onCreated(requestFile); onCreated(requestThumb);
        await new Promise((resolve) => setImmediate(resolve));
        currentReq.emit('aborted');
        assert.equal(signal.aborted, true);
        throw Object.assign(new Error('aborted processing'), { name: 'AbortError' });
      },
    },
    db: { insertSave: () => { inserts += 1; return { id: 'saved' }; } },
  });
  t.after(server.__restoreTestModules);
  const call = invoke(server, { imageUrl: 'https://cdn.example/image.jpg' });
  currentReq = call.req;
  const response = await call.response;
  assert.equal(response.status, 504);
  assert.equal(inserts, 0);
  assert.equal(fs.existsSync(requestFile), false);
  assert.equal(fs.existsSync(requestThumb), false);
  assert.equal(fs.existsSync(existingFile), true);
});

test('cancellation immediately before insert prevents commit and cleans returned files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-save-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'pending.webp');
  const thumbPath = path.join(directory, 'pending.jpg');
  fs.writeFileSync(filePath, 'pending'); fs.writeFileSync(thumbPath, 'pending');
  let inserts = 0;
  let currentReq;
  const server = loadServer({
    storage: {
      saveImageFromUrl: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        currentReq.emit('aborted');
        return { id: 'pending', filePath, thumbPath, width: 1, height: 1, fileSize: 7 };
      },
    },
    db: { insertSave: () => { inserts += 1; return { id: 'saved' }; } },
  });
  t.after(server.__restoreTestModules);
  const call = invoke(server, { imageUrl: 'https://cdn.example/image.jpg' });
  currentReq = call.req;
  const response = await call.response;
  assert.equal(response.status, 504);
  assert.equal(inserts, 0);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(thumbPath), false);
});

test('cancellation after synchronous commit remains successful and keeps committed files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-save-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'committed.webp');
  const thumbPath = path.join(directory, 'committed.jpg');
  fs.writeFileSync(filePath, 'committed'); fs.writeFileSync(thumbPath, 'committed');
  let currentReq;
  const server = loadServer({
    storage: { saveImageFromUrl: async () => ({ id: 'committed', filePath, thumbPath, width: 1, height: 1, fileSize: 9 }) },
    db: { insertSave: () => { currentReq.emit('aborted'); return { id: 'saved' }; } },
  });
  t.after(server.__restoreTestModules);
  const call = invoke(server, { imageUrl: 'https://cdn.example/image.jpg' });
  currentReq = call.req;
  const response = await call.response;
  assert.deepEqual(response, { status: 200, body: { ok: true, id: 'saved' } });
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(thumbPath), true);
});

test('a social request cancelled while waiting for its post lock cannot enrich metadata', async (t) => {
  let releaseFirst;
  let firstStarted;
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  let enrichCalls = 0;
  const media = { id: 'image', filePath: '/tmp/image', thumbPath: '/tmp/thumb', width: 1, height: 1, fileSize: 1 };
  const server = loadServer({
    storage: {
      saveImageFromUrl: async () => new Promise((resolve) => {
        releaseFirst = () => resolve(media);
        firstStarted();
      }),
    },
    db: {
      sourceKeyFromUrl: () => 'tw:lock',
      enrichActiveSaveBySourceKey: () => { enrichCalls += 1; return { record: null, changed: false }; },
    },
  });
  t.after(server.__restoreTestModules);
  const body = { imageUrl: 'https://cdn.example/image.jpg', pageUrl: 'https://x.com/user/status/1', tweetMeta: { caption: 'Post' } };
  const first = invoke(server, body);
  await firstReady;
  const second = invoke(server, body);
  await new Promise((resolve) => setImmediate(resolve));
  second.req.emit('aborted');
  releaseFirst();
  assert.equal((await first.response).status, 200);
  assert.equal((await second.response).status, 504);
  assert.equal(enrichCalls, 1);
});

test('disabled social sync does not lock, enrich, requeue, or save a duplicate', async (t) => {
  let enrichCalls = 0;
  let storageCalls = 0;
  const server = loadServer({
    settings: { syncXEnabled: false },
    storage: { saveImageFromUrl: async () => { storageCalls += 1; throw new Error('must not save'); } },
    db: {
      sourceKeyFromUrl: () => 'tw:disabled',
      enrichActiveSaveBySourceKey: () => { enrichCalls += 1; return { record: { id: 'existing' }, changed: true }; },
      insertSave: () => { throw new Error('must not insert'); },
    },
  });
  t.after(server.__restoreTestModules);
  const response = await invoke(server, {
    imageUrl: 'https://cdn.example/image.jpg', pageUrl: 'https://x.com/user/status/1',
    tweetMeta: { article: { title: 'New metadata' } },
  }).response;
  assert.deepEqual(response, { status: 200, body: { ok: true, skipped: true, syncDisabled: true } });
  assert.equal(enrichCalls, 0);
  assert.equal(storageCalls, 0);
});

test('every /save capture branch receives one request signal', async (t) => {
  const calls = [];
  const signalFor = (name) => (_value, options = {}) => {
    calls.push([name, options.signal]);
    return { id: name, filePath: `/tmp/${name}`, thumbPath: `/tmp/${name}-thumb`, width: 1, height: 1, fileSize: 1 };
  };
  const server = loadServer({
    storage: {
      saveImageFromUrl: signalFor('image'),
      saveVideoFromUrl: (url, poster, options) => signalFor('video')(url, options),
      saveAuxMedia: async (_url, options) => { calls.push(['aux', options.signal]); return { path: '/tmp/aux' }; },
    },
    tweetCardCapture: signalFor('tweet-card'),
    urlCapture: signalFor('url-capture'),
  });
  t.after(server.__restoreTestModules);
  for (const body of [
    { imageUrl: 'https://cdn.example/image.jpg' },
    { videoUrl: 'https://cdn.example/video.mp4', posterUrl: 'https://cdn.example/poster.jpg' },
    { imageUrl: 'https://cdn.example/ig.jpg', pageUrl: 'https://instagram.com/p/1', source: 'instagram', tweetMeta: { media: [{ url: 'https://cdn.example/ig.jpg' }, { url: 'https://cdn.example/ig-2.jpg', poster: 'https://cdn.example/ig-2.jpg' }] } },
    { pageUrl: 'https://x.com/user/status/1', tweetMeta: { caption: 'Text only' } },
    { pageUrl: 'https://x.com/user/status/2', tweetMeta: { article: { title: 'Article' } } },
  ]) {
    assert.equal((await invoke(server, body).response).status, 200);
  }
  assert.deepEqual(calls.map(([name]) => name), ['image', 'video', 'image', 'aux', 'aux', 'tweet-card', 'url-capture']);
  assert.ok(calls.every(([, signal]) => signal && typeof signal.aborted === 'boolean'));
  assert.strictEqual(calls[2][1], calls[3][1]);
  assert.strictEqual(calls[3][1], calls[4][1]);
});
