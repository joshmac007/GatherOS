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
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-x-article-'));
    const db = loadDb(userData);
    try { db.initDatabase(); await fn(db); }
    finally { try { db.closeDatabase(); } catch {} fs.rmSync(userData, { recursive: true, force: true }); }
  };
}

test('social duplicate enrichment fills missing structured data without replacing user data', withTempDb((db) => {
  db.insertSave({
    id: 'saved', filePath: '/tmp/kept.png', thumbPath: '/tmp/kept-thumb.png',
    sourceUrl: 'https://x.com/example/status/100', title: 'Kept title', notes: 'Kept notes',
    kind: 'image', tweetMeta: {
      caption: 'Original caption',
      thread: [{ text: 'Original thread' }],
      media: [{ url: 'https://cdn.example/kept.jpg' }],
      tweetCreatedAt: 1700000000000,
    },
  });

  const result = db.enrichActiveSaveBySourceKey('tw:100', {
    article: { title: 'Article title', excerpt: 'Article excerpt' },
    quoted: { caption: 'Quoted caption' },
    caption: 'Incoming caption must not replace',
    thread: [{ text: 'Incoming thread must not replace' }],
    media: [{ url: 'https://cdn.example/incoming.jpg' }],
    tweetCreatedAt: 1800000000000,
  });

  assert.equal(result.changed, true);
  assert.equal(result.record.id, 'saved');
  assert.equal(result.record.file_path, '/tmp/kept.png');
  assert.equal(result.record.title, 'Kept title');
  assert.equal(result.record.notes, 'Kept notes');
  assert.equal(result.record.kind, 'image');
  const meta = JSON.parse(result.record.tweet_meta);
  assert.deepEqual(meta.article, { title: 'Article title', excerpt: 'Article excerpt' });
  assert.deepEqual(meta.quoted, { caption: 'Quoted caption' });
  assert.equal(meta.caption, 'Original caption');
  assert.deepEqual(meta.thread, [{ text: 'Original thread' }]);
  assert.deepEqual(meta.media, [{ url: 'https://cdn.example/kept.jpg' }]);
  assert.equal(meta.tweetCreatedAt, 1700000000000);

  const unchanged = db.enrichActiveSaveBySourceKey('tw:100', {
    article: { title: 'Different article title' },
    quoted: { caption: 'Different quote' },
    thread: [{ text: 'Different thread' }],
    media: [{ url: 'https://cdn.example/different.jpg' }],
    tweetCreatedAt: 1900000000000,
  });
  assert.equal(unchanged.changed, false);
}));

test('social duplicate enrichment fills absent arrays and invalid tweet dates', withTempDb((db) => {
  db.insertSave({
    id: 'saved', filePath: '/tmp/a.png', thumbPath: '/tmp/a-thumb.png',
    sourceUrl: 'https://x.com/example/status/101', tweetMeta: { tweetCreatedAt: 0, thread: [], media: [] },
  });
  const result = db.enrichActiveSaveBySourceKey('tw:101', {
    thread: [{ text: 'Imported thread' }], media: [{ url: 'https://cdn.example/photo.jpg' }],
    tweetCreatedAt: 1800000000000,
  });
  assert.equal(result.changed, true);
  const meta = JSON.parse(result.record.tweet_meta);
  assert.deepEqual(meta.thread, [{ text: 'Imported thread' }]);
  assert.deepEqual(meta.media, [{ url: 'https://cdn.example/photo.jpg' }]);
  assert.equal(meta.tweetCreatedAt, 1800000000000);
}));

test('social duplicate enrichment replaces blank structured placeholders but preserves real values', withTempDb((db) => {
  db.insertSave({
    id: 'saved', filePath: '/tmp/a.png', thumbPath: '/tmp/a-thumb.png',
    sourceUrl: 'https://x.com/example/status/102',
    tweetMeta: {
      article: { title: '   ', excerpt: 'Keep this excerpt' },
      quoted: { caption: '\n', authorName: 'Keep this author' },
    },
  });
  const result = db.enrichActiveSaveBySourceKey('tw:102', {
    article: { title: 'Imported Article', excerpt: 'Incoming excerpt must not replace' },
    quoted: { caption: 'Imported quote', authorName: 'Incoming author must not replace' },
  });
  assert.equal(result.changed, true);
  const meta = JSON.parse(result.record.tweet_meta);
  assert.deepEqual(meta.article, { title: 'Imported Article', excerpt: 'Keep this excerpt' });
  assert.deepEqual(meta.quoted, { caption: 'Imported quote', authorName: 'Keep this author' });
}));

test('semantic source includes Article title and excerpt', () => {
  const { buildSemanticSource } = require('../src/main/semantic-source');
  const source = buildSemanticSource({
    save: { tweet_meta: JSON.stringify({ article: { title: 'Durable article title', excerpt: 'Article body teaser' } }) },
  });
  assert.match(source.text, /Article: Durable article title/);
  assert.match(source.text, /Article excerpt: Article body teaser/);
});
