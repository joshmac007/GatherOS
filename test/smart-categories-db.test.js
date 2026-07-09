const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function loadDb(userData) {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        getPath(name) {
          if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
          return userData;
        },
      },
    },
  };

  for (const mod of ['../src/main/db.js', '../src/main/library-registry.js']) {
    delete require.cache[require.resolve(mod)];
  }
  return require('../src/main/db.js');
}

function withTempDb(fn) {
  return async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-smart-cats-'));
    const db = loadDb(userData);
    try {
      await fn(db, userData);
    } finally {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

function sqlitePath(userData) {
  return path.join(userData, 'libraries', 'library_default', 'moodmark.db');
}

function tableNames(database) {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all().map((row) => row.name);
}

test('migration adds smart category foundation tables to upgraded databases', withTempDb((db, userData) => {
  db.initDatabase();
  const targetVersion = db.getDatabase().pragma('user_version', { simple: true });
  db.closeDatabase();

  const raw = new Database(sqlitePath(userData));
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE IF EXISTS smart_category_aliases;
    DROP TABLE IF EXISTS smart_category_members;
    DROP TABLE IF EXISTS save_topic_profiles;
    DROP TABLE IF EXISTS smart_category_runs;
    DROP TABLE IF EXISTS smart_categories;
    PRAGMA user_version = ${targetVersion - 1};
  `);
  raw.close();

  db.initDatabase();
  const names = tableNames(db.getDatabase());
  assert.ok(names.includes('smart_categories'));
  assert.ok(names.includes('smart_category_aliases'));
  assert.ok(names.includes('smart_category_members'));
  assert.ok(names.includes('save_topic_profiles'));
  assert.ok(names.includes('smart_category_runs'));
  assert.equal(db.getDatabase().pragma('user_version', { simple: true }), targetVersion);
}));

test('smart categories support internal controls, aliases, topic profiles, memberships, and runs', withTempDb((db) => {
  db.initDatabase();
  const save = db.insertSave({
    id: 'save-1',
    filePath: '/tmp/image.png',
    thumbPath: '/tmp/thumb.png',
    title: 'AI ad concept',
    createdAt: 1000,
  });

  const created = db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI image generation',
    description: 'Visual AI examples and workflows',
    status: 'visible',
    visibilityScore: 0.86,
    createdAt: 2000,
    updatedAt: 2000,
  });
  assert.equal(created.ok, true);
  assert.equal(db.getSmartCategory('cat-ai').status, 'visible');

  assert.equal(db.pinSmartCategory('cat-ai').ok, true);
  assert.equal(db.getSmartCategory('cat-ai').frozen_name, true);
  assert.equal(db.hideSmartCategory('cat-ai').ok, true);
  assert.equal(db.getSmartCategory('cat-ai').status, 'hidden');
  assert.equal(db.archiveSmartCategory('cat-ai').ok, true);
  assert.equal(db.listSmartCategories().length, 0);
  assert.equal(db.listSmartCategories({ includeArchived: true })[0].id, 'cat-ai');

  assert.equal(db.upsertSmartCategoryAlias({
    categoryId: 'cat-ai',
    alias: 'AI creative',
    source: 'search_synonym',
    createdAt: 3000,
  }).ok, true);
  assert.equal(db.findSmartCategoryAliases('ai creative')[0].category_id, 'cat-ai');

  assert.equal(db.upsertSaveTopicProfile({
    saveId: save.id,
    concepts: ['image generation', 'ad concepts'],
    contentType: 'tweet',
    intentGuess: 'inspiration',
    summary: 'Tweet about AI-made ad concepts.',
    confidence: 0.91,
    updatedAt: 4000,
  }).ok, true);
  assert.deepEqual(db.getSaveTopicProfile(save.id).concepts, ['image generation', 'ad concepts']);

  assert.equal(db.upsertSmartCategoryMembership({
    categoryId: 'cat-ai',
    saveId: save.id,
    weight: 0.82,
    evidence: 'Strong visual AI workflow fit',
    assignedAt: 5000,
    updatedAt: 5000,
  }).ok, true);
  assert.equal(db.getSmartCategoryMembers('cat-ai', { minWeight: 0.75 })[0].save_id, save.id);
  assert.equal(db.getSmartCategoryMembers('cat-ai', { minWeight: 0.75 })[0].evidence, 'Strong visual AI workflow fit');
  assert.equal(db.getSmartCategoriesForSave(save.id)[0].category_id, 'cat-ai');
  assert.equal(db.getSmartCategory('cat-ai').member_count, 1);

  assert.equal(db.recordSmartCategoryRun({
    id: 'run-1',
    runType: 'incremental_assignment',
    startedAt: 6000,
    finishedAt: 7000,
    inputSaveCount: 1,
    createdCount: 1,
    provider: 'codex',
  }).ok, true);
  assert.equal(db.listSmartCategoryRuns()[0].id, 'run-1');
}));

test('smart category foundation does not change existing library queries', withTempDb((db) => {
  db.initDatabase();
  const save = db.insertSave({
    id: 'save-legacy',
    filePath: '/tmp/legacy.png',
    thumbPath: '/tmp/legacy-thumb.png',
    title: 'Mountain moodboard',
    sourceUrl: 'https://x.com/example/status/123',
    createdAt: 1000,
  });
  const collection = db.createCollection({ name: 'References', color: '#007aff' });
  db.addSaveToCollection({ collectionId: collection.id, saveId: save.id });
  db.addTagToSave({ saveId: save.id, name: 'bookmark' });

  db.createSmartCategory({ id: 'cat-hidden', name: 'Landscape references', status: 'hidden' });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-hidden', saveId: save.id, weight: 0.9 });

  assert.equal(db.getAllSaves({ search: 'Mountain' }).length, 1);
  assert.equal(db.getAllSaves({ search: 'tag:bookmark' }).length, 1);
  assert.equal(db.getAllSaves({ search: 'bucket:references' }).length, 1);
  assert.equal(db.getSmartViewCounts().bookmarks, 1);
  assert.equal(db.getAllCollections()[0].save_count, 1);
  assert.deepEqual(db.getTagsForSave(save.id).map((tag) => tag.name), ['bookmark']);
}));
