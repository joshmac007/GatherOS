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
    PRAGMA user_version = ${targetVersion - 2};
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
    metadata: {
      deferred_merges: [{ category_ids: ['cat-ai', 'cat-design'], proposed_name: 'Creative systems' }],
      deferred_splits: [],
    },
  }).ok, true);
  assert.equal(db.listSmartCategoryRuns()[0].id, 'run-1');
  assert.deepEqual(
    JSON.parse(db.listSmartCategoryRuns()[0].metadata).deferred_merges[0].category_ids,
    ['cat-ai', 'cat-design'],
  );
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

test('smart category navigation only lists useful visible categories', withTempDb((db) => {
  db.initDatabase();
  for (let i = 1; i <= 6; i += 1) {
    db.insertSave({
      id: `save-ai-${i}`,
      filePath: `/tmp/ai-${i}.png`,
      thumbPath: `/tmp/ai-${i}-thumb.png`,
      title: `AI workflow ${i}`,
      createdAt: 1000 + i,
    });
  }
  for (let i = 1; i <= 5; i += 1) {
    db.insertSave({
      id: `save-hidden-${i}`,
      filePath: `/tmp/hidden-${i}.png`,
      thumbPath: `/tmp/hidden-${i}-thumb.png`,
      title: `Hidden workflow ${i}`,
      createdAt: 2000 + i,
    });
  }
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI workflow tools',
    status: 'visible',
    visibilityScore: 0.8,
  });
  db.createSmartCategory({
    id: 'cat-small',
    name: 'Small cluster',
    status: 'visible',
    visibilityScore: 0.9,
  });
  db.createSmartCategory({
    id: 'cat-candidate',
    name: 'Candidate cluster',
    status: 'candidate',
    visibilityScore: 0.95,
  });
  db.createSmartCategory({
    id: 'cat-hidden',
    name: 'Hidden cluster',
    status: 'hidden',
    visibilityScore: 0.95,
  });
  for (let i = 1; i <= 5; i += 1) {
    db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: `save-ai-${i}`, weight: 0.8 });
    db.upsertSmartCategoryMembership({ categoryId: 'cat-hidden', saveId: `save-hidden-${i}`, weight: 0.9 });
  }
  db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: 'save-ai-6', weight: 0.6 });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-small', saveId: 'save-ai-1', weight: 0.91 });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-candidate', saveId: 'save-ai-2', weight: 0.91 });

  assert.deepEqual(
    db.listNavigableSmartCategories().map((category) => [
      category.id,
      category.member_count,
      category.primary_member_count,
    ]),
    [['cat-ai', 6, 5]],
  );
}));

test('smart category rename preserves old names as aliases and recent metadata', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI tools',
    status: 'visible',
    visibilityScore: 0.9,
    createdAt: 1000,
    updatedAt: 1000,
    lastChangedAt: 1000,
    changeKind: null,
  });

  const renamed = db.renameSmartCategory({
    id: 'cat-ai',
    name: 'AI workflow tools',
    changedAt: 5000,
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.renamed, true);

  const category = db.getSmartCategory('cat-ai');
  assert.equal(category.name, 'AI workflow tools');
  assert.equal(category.last_changed_at, 5000);
  assert.equal(category.change_kind, 'renamed');
  assert.deepEqual(
    db.getSmartCategoryAliases('cat-ai').map((alias) => [alias.alias, alias.source]),
    [['AI tools', 'old_name']],
  );
}));

test('pinned smart category names reject automatic renames', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI tools',
    status: 'visible',
    frozenName: true,
  });

  const skipped = db.renameSmartCategory({
    id: 'cat-ai',
    name: 'AI workflow tools',
    automatic: true,
  });

  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'name-frozen');
  assert.equal(db.getSmartCategory('cat-ai').name, 'AI tools');
  assert.deepEqual(db.getSmartCategoryAliases('cat-ai'), []);
}));

test('taxonomy apply rolls back all rename and alias changes when one change fails', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI tools',
    status: 'visible',
  });
  db.createSmartCategory({
    id: 'cat-pinned',
    name: 'Pinned name',
    status: 'visible',
    frozenName: true,
  });

  const result = db.applySmartCategoryTaxonomyChanges({
    renames: [
      { id: 'cat-ai', name: 'AI workflow tools', automatic: true, changedAt: 5000 },
      { id: 'cat-pinned', name: 'Pinned workflows', automatic: true, changedAt: 5000 },
    ],
    aliases: [
      { categoryId: 'cat-ai', alias: 'AI systems', source: 'model_synonym', createdAt: 5000 },
    ],
    changedAt: 5000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'name-frozen');
  assert.equal(db.getSmartCategory('cat-ai').name, 'AI tools');
  assert.deepEqual(db.getSmartCategoryAliases('cat-ai'), []);
}));

test('hidden smart categories require explicit restore before becoming visible', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({
    id: 'cat-hidden',
    name: 'Hidden cluster',
    status: 'hidden',
  });

  const implicit = db.setSmartCategoryStatus('cat-hidden', 'visible');
  assert.equal(implicit.ok, false);
  assert.equal(implicit.reason, 'hidden-requires-restore');
  assert.equal(db.getSmartCategory('cat-hidden').status, 'hidden');

  const restored = db.restoreSmartCategory('cat-hidden');
  assert.equal(restored.ok, true);
  assert.equal(db.getSmartCategory('cat-hidden').status, 'visible');
}));

test('smart category nav exposes recent rename only inside configured window', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI workflow tools',
    status: 'visible',
    visibilityScore: 0.9,
    createdAt: 1000,
    updatedAt: 1000,
    lastChangedAt: 1000,
    changeKind: null,
  });
  for (let i = 1; i <= 5; i += 1) {
    db.insertSave({
      id: `save-ai-${i}`,
      filePath: `/tmp/recent-${i}.png`,
      thumbPath: `/tmp/recent-${i}-thumb.png`,
      title: `AI workflow ${i}`,
      createdAt: 2000 + i,
    });
    db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: `save-ai-${i}`, weight: 0.85 });
  }
  db.renameSmartCategory({
    id: 'cat-ai',
    name: 'AI workflow systems',
    changedAt: 10_000,
  });

  const recent = db.listNavigableSmartCategories({
    now: 12_000,
    recentChangeWindowMs: 5_000,
  })[0];
  assert.equal(recent.recent_change, true);
  assert.equal(recent.recent_change_kind, 'renamed');
  assert.equal(recent.recent_change_note, 'Renamed from "AI workflow tools". Old name still works in search.');

  const stale = db.listNavigableSmartCategories({
    now: 20_001,
    recentChangeWindowMs: 5_000,
  })[0];
  assert.equal(stale.recent_change, false);
  assert.equal(stale.recent_change_note, null);
}));

test('smart category saves default to primary members ranked by strength then recency', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI workflow tools',
    status: 'visible',
    visibilityScore: 0.8,
  });
  db.insertSave({
    id: 'save-older-strong',
    filePath: '/tmp/older.png',
    thumbPath: '/tmp/older-thumb.png',
    title: 'Older strong',
    createdAt: 1000,
  });
  db.insertSave({
    id: 'save-newer-strong',
    filePath: '/tmp/newer.png',
    thumbPath: '/tmp/newer-thumb.png',
    title: 'Newer strong',
    createdAt: 2000,
  });
  db.insertSave({
    id: 'save-secondary',
    filePath: '/tmp/secondary.png',
    thumbPath: '/tmp/secondary-thumb.png',
    title: 'Secondary',
    createdAt: 3000,
  });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: 'save-older-strong', weight: 0.9 });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: 'save-newer-strong', weight: 0.9 });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: 'save-secondary', weight: 0.6 });

  assert.deepEqual(
    db.getSmartCategorySaves('cat-ai').map((save) => [save.id, save.smart_category_weight]),
    [
      ['save-newer-strong', 0.9],
      ['save-older-strong', 0.9],
    ],
  );
  assert.deepEqual(
    db.getSmartCategorySaves('cat-ai', { minWeight: 0.45 }).map((save) => save.id),
    ['save-newer-strong', 'save-older-strong', 'save-secondary'],
  );
}));

test('pending smart category saves include live rows without topic profiles or memberships', withTempDb((db) => {
  db.initDatabase();
  db.createSmartCategory({ id: 'cat-ai', name: 'AI workflow tools', status: 'visible' });
  for (const id of ['save-new-profiled', 'save-new-unprofiled', 'save-done', 'save-trash']) {
    db.insertSave({
      id,
      filePath: `/tmp/${id}.png`,
      thumbPath: `/tmp/${id}-thumb.png`,
      title: id,
      createdAt: id === 'save-new-unprofiled' ? 4000 : id === 'save-new-profiled' ? 3000 : 2000,
    });
  }
  db.upsertSaveTopicProfile({
    saveId: 'save-new-profiled',
    concepts: ['ai workflow tools', 'automation', 'reference'],
    contentType: 'tweet',
    intentGuess: 'reference',
    summary: 'Profile exists but no category membership exists.',
    confidence: 0.8,
  });
  db.upsertSaveTopicProfile({
    saveId: 'save-done',
    concepts: ['ai workflow tools', 'automation', 'reference'],
    contentType: 'tweet',
    intentGuess: 'reference',
    summary: 'Already assigned.',
    confidence: 0.8,
  });
  db.upsertSmartCategoryMembership({ categoryId: 'cat-ai', saveId: 'save-done', weight: 0.85 });
  db.deleteSave('save-trash');

  assert.deepEqual(
    db.getPendingSmartCategorySaves({ limit: 10 }).map((save) => save.id),
    ['save-new-unprofiled', 'save-new-profiled'],
  );
}));

test('search expands matching smart category aliases after direct save matches', withTempDb((db) => {
  db.initDatabase();
  db.insertSave({
    id: 'save-direct',
    filePath: '/tmp/direct.png',
    thumbPath: '/tmp/direct-thumb.png',
    title: 'AI design checklist',
    createdAt: 1000,
  });
  db.insertSave({
    id: 'save-category-high',
    filePath: '/tmp/category-high.png',
    thumbPath: '/tmp/category-high-thumb.png',
    title: 'Campaign storyboard',
    createdAt: 3000,
  });
  db.insertSave({
    id: 'save-category-low',
    filePath: '/tmp/category-low.png',
    thumbPath: '/tmp/category-low-thumb.png',
    title: 'Loose reference',
    createdAt: 4000,
  });
  db.createSmartCategory({
    id: 'cat-visual-generation',
    name: 'Visual generation tools',
    status: 'visible',
    visibilityScore: 0.9,
  });
  db.upsertSmartCategoryAlias({
    categoryId: 'cat-visual-generation',
    alias: 'AI design',
    source: 'search_synonym',
  });
  db.upsertSmartCategoryMembership({
    categoryId: 'cat-visual-generation',
    saveId: 'save-category-high',
    weight: 0.95,
  });
  db.upsertSmartCategoryMembership({
    categoryId: 'cat-visual-generation',
    saveId: 'save-category-low',
    weight: 0.62,
  });

  assert.deepEqual(
    db.getAllSaves({ search: 'AI design' }).map((save) => save.id),
    ['save-direct', 'save-category-high'],
  );
}));

test('search uses old category names stored as aliases', withTempDb((db) => {
  db.initDatabase();
  db.insertSave({
    id: 'save-old-name-match',
    filePath: '/tmp/old-name.png',
    thumbPath: '/tmp/old-name-thumb.png',
    title: 'Storyboard set',
    createdAt: 1000,
  });
  db.createSmartCategory({
    id: 'cat-renamed',
    name: 'Visual generation tools',
    status: 'visible',
    visibilityScore: 0.9,
  });
  db.upsertSmartCategoryAlias({
    categoryId: 'cat-renamed',
    alias: 'AI tools',
    source: 'old_name',
  });
  db.upsertSmartCategoryMembership({
    categoryId: 'cat-renamed',
    saveId: 'save-old-name-match',
    weight: 0.88,
  });

  assert.deepEqual(
    db.getAllSaves({ search: 'AI tools' }).map((save) => save.id),
    ['save-old-name-match'],
  );
  assert.deepEqual(
    db.getAllSaves({ search: 'visual generation' }).map((save) => save.id),
    ['save-old-name-match'],
  );
}));

test('structural filters constrain smart category search expansion', withTempDb((db) => {
  db.initDatabase();
  db.insertSave({
    id: 'save-in-bucket',
    filePath: '/tmp/in-bucket.png',
    thumbPath: '/tmp/in-bucket-thumb.png',
    title: 'Storyboard in bucket',
    createdAt: 1000,
  });
  db.insertSave({
    id: 'save-outside-bucket',
    filePath: '/tmp/outside-bucket.png',
    thumbPath: '/tmp/outside-bucket-thumb.png',
    title: 'Storyboard outside bucket',
    createdAt: 2000,
  });
  const collection = db.createCollection({ name: 'References', color: '#007aff' });
  db.addSaveToCollection({ collectionId: collection.id, saveId: 'save-in-bucket' });
  db.createSmartCategory({
    id: 'cat-generation',
    name: 'Visual generation tools',
    status: 'visible',
    visibilityScore: 0.9,
  });
  db.upsertSmartCategoryAlias({
    categoryId: 'cat-generation',
    alias: 'generative design',
    source: 'search_synonym',
  });
  db.upsertSmartCategoryMembership({
    categoryId: 'cat-generation',
    saveId: 'save-in-bucket',
    weight: 0.9,
  });
  db.upsertSmartCategoryMembership({
    categoryId: 'cat-generation',
    saveId: 'save-outside-bucket',
    weight: 0.95,
  });

  assert.deepEqual(
    db.getAllSaves({ search: 'generative design bucket:references' }).map((save) => save.id),
    ['save-in-bucket'],
  );
}));
