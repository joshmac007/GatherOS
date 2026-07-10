const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadDb(userData) {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app: { getPath(name) { if (name !== 'userData') throw new Error('unexpected path'); return userData; } } },
  };
  for (const mod of ['../src/main/db.js', '../src/main/library-registry.js']) delete require.cache[require.resolve(mod)];
  return require('../src/main/db.js');
}

function withTempDb(fn) {
  return async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-x-status-'));
    const db = loadDb(userData);
    try { db.initDatabase(); await fn(db, userData); }
    finally { try { db.closeDatabase(); } catch {} fs.rmSync(userData, { recursive: true, force: true }); }
  };
}

test('classifyXBookmarkUrls returns ordered active, dismissed, and new statuses', withTempDb((db) => {
  db.insertSave({ id: 'active', filePath: '/tmp/a.png', thumbPath: '/tmp/a.png', sourceUrl: 'https://x.com/a/status/101' });
  db.dismissTweet('tw:202');
  assert.deepEqual(db.classifyXBookmarkUrls([
    'https://x.com/a/status/101',
    'https://x.com/b/status/202',
    'https://x.com/c/status/303',
  ]), {
    hasKnownHistory: true,
    statuses: ['known-active', 'known-dismissed', 'new'],
  });
}));

test('classifyXBookmarkUrls reports no boundary on empty history and invalid URLs as new', withTempDb((db) => {
  assert.deepEqual(db.classifyXBookmarkUrls([]), { hasKnownHistory: false, statuses: [] });
  assert.deepEqual(db.classifyXBookmarkUrls(['https://example.com/nope', 'not a url']), {
    hasKnownHistory: false,
    statuses: ['new', 'new'],
  });
}));

test('classifyXBookmarkUrls rejects non-array and batches over 100', withTempDb((db) => {
  assert.throws(() => db.classifyXBookmarkUrls(null), /tweetUrls must be an array/);
  assert.throws(() => db.classifyXBookmarkUrls(Array.from({ length: 101 }, () => 'https://x.com/a/status/1')), /too large/);
  assert.throws(() => db.classifyXBookmarkUrls(['https://x.com/a/status/1', null]), /strings/);
}));

test('x-bookmark-status HTTP handler authenticates and returns exact contract', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-x-server-'));
  const db = loadDb(userData);
  db.initDatabase();
  const server = require('../src/main/extension-server');
  const { EventEmitter } = require('node:events');
  function invoke(headers, body) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      req.headers = headers;
      const res = {
        statusCode: 0,
        writeHead(status, responseHeaders) { this.statusCode = status; this.headers = responseHeaders; },
        end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload || '{}') }); },
      };
      server.handleXBookmarkStatus(req, res);
      process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
    });
  }
  try {
    const token = server.getOrCreateToken();
    const response = await invoke({ 'x-gatheros-token': token, origin: 'chrome-extension://test' }, { tweetUrls: ['https://x.com/a/status/1'] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, hasKnownHistory: false, statuses: ['new'] });
    const bad = await invoke({ 'x-gatheros-token': 'bad' }, {});
    assert.equal(bad.status, 401);
    const invalidElement = await invoke(
      { 'x-gatheros-token': token, origin: 'chrome-extension://test' },
      { tweetUrls: ['https://x.com/a/status/1', 2] },
    );
    assert.equal(invalidElement.status, 400);
  } finally {
    db.closeDatabase();
    fs.rmSync(userData, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/main/extension-server')];
  }
});
