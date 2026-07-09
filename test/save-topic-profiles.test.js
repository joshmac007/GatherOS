const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSaveTopicEvidence,
  createSaveTopicProfile,
  validateSaveTopicProfile,
} = require('../src/main/save-topic-profiles');

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
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-topic-profile-'));
    const db = loadDb(userData);
    try {
      db.initDatabase();
      await fn(db, userData);
    } finally {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

function validProfile(overrides = {}) {
  return {
    summary: 'Screenshot shows a compact AI ad concept board for campaign testing.',
    concepts: ['ai ad concepts', 'campaign testing', 'visual ideation'],
    content_type: 'tweet',
    intent: 'inspiration',
    visible_text: '',
    confidence: 0.88,
    ...overrides,
  };
}

test('builds image-backed topic profile evidence for weak X bookmarks', withTempDb(async (db, userData) => {
  const imagePath = path.join(userData, 'bookmark.png');
  fs.writeFileSync(imagePath, 'not-real-png-but-present');
  const save = db.insertSave({
    id: 'save-image-only',
    filePath: imagePath,
    thumbPath: imagePath,
    title: '',
    sourceUrl: 'https://x.com/example/status/123',
    tweetMeta: {
      caption: '',
      authorName: 'Example Author',
      authorHandle: '@example',
      quoted: { caption: '' },
    },
    createdAt: 1000,
  });
  db.addTagToSave({ saveId: save.id, name: 'bookmark' });

  let providerInput = null;
  let providerOptions = null;
  const result = await createSaveTopicProfile({
    save: db.getSave(save.id),
    manualTags: db.getTagsForSave(save.id),
    provider: {
      async generateSaveTopicProfile(input, options) {
        providerInput = input;
        providerOptions = options;
        return validProfile();
      },
    },
    upsertSaveTopicProfile: db.upsertSaveTopicProfile,
    now: () => 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(providerOptions.imagePath, imagePath);
  assert.deepEqual(providerInput.manualTags, ['bookmark']);
  assert.equal(providerInput.author, 'Example Author @example');
  assert.deepEqual(db.getSaveTopicProfile(save.id), {
    save_id: save.id,
    concepts: ['ai ad concepts', 'campaign testing', 'visual ideation'],
    content_type: 'tweet',
    intent_guess: 'inspiration',
    summary: 'Screenshot shows a compact AI ad concept board for campaign testing.',
    embedding: null,
    confidence: 0.88,
    updated_at: 2000,
  });
  assert.deepEqual(db.getTagsForSave(save.id).map((tag) => tag.name), ['bookmark']);
}));

test('uses text-only topic evidence when no image file is available', () => {
  const { promptInput, imagePath } = buildSaveTopicEvidence({
    id: 'save-text',
    file_path: '/tmp/gatherlocal-missing-image.png',
    title: 'Pricing teardown',
    source_url: 'https://example.com/pricing',
    kind: 'url',
    tweet_meta: JSON.stringify({
      caption: 'Great breakdown of pricing page information hierarchy.',
      authorHandle: '@pm',
      quoted: { caption: 'Original thread on SaaS pricing' },
    }),
  }, ['research']);

  assert.equal(imagePath, null);
  assert.equal(promptInput.tweetText, 'Great breakdown of pricing page information hierarchy.');
  assert.equal(promptInput.quotedTweetText, 'Original thread on SaaS pricing');
  assert.equal(promptInput.existingTitle, 'Pricing teardown');
  assert.deepEqual(promptInput.manualTags, ['research']);
});

test('rejects incomplete Codex JSON and leaves profiles and category state unchanged', withTempDb(async (db, userData) => {
  const imagePath = path.join(userData, 'save.png');
  fs.writeFileSync(imagePath, 'image');
  const save = db.insertSave({
    id: 'save-invalid',
    filePath: imagePath,
    thumbPath: imagePath,
    title: 'Existing title',
    createdAt: 1000,
  });
  db.createSmartCategory({ id: 'cat-existing', name: 'Existing category', status: 'visible' });
  db.upsertSaveTopicProfile({
    saveId: save.id,
    concepts: ['existing profile', 'classifier fuel', 'stable state'],
    contentType: 'article',
    intentGuess: 'research',
    summary: 'Existing profile should remain.',
    confidence: 0.7,
    updatedAt: 1500,
  });

  const beforeProfile = db.getSaveTopicProfile(save.id);
  const beforeCategory = db.getSmartCategory('cat-existing');
  const result = await createSaveTopicProfile({
    save: db.getSave(save.id),
    provider: {
      async generateSaveTopicProfile() {
        return { summary: 'Missing fields', concepts: ['one'] };
      },
    },
    upsertSaveTopicProfile: db.upsertSaveTopicProfile,
    now: () => 2500,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-concepts');
  assert.deepEqual(db.getSaveTopicProfile(save.id), beforeProfile);
  assert.deepEqual(db.getSmartCategory('cat-existing'), beforeCategory);
  assert.deepEqual(db.getSmartCategoriesForSave(save.id), []);
}));

test('provider parse failures do not write topic profile state', withTempDb(async (db, userData) => {
  const imagePath = path.join(userData, 'parse-fail.png');
  fs.writeFileSync(imagePath, 'image');
  const save = db.insertSave({
    id: 'save-parse-fail',
    filePath: imagePath,
    thumbPath: imagePath,
    title: 'Parse fail',
    createdAt: 1000,
  });

  const result = await createSaveTopicProfile({
    save: db.getSave(save.id),
    provider: {
      async generateSaveTopicProfile() {
        throw new Error('Codex response was not valid JSON');
      },
    },
    upsertSaveTopicProfile: db.upsertSaveTopicProfile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'provider-error');
  assert.equal(db.getSaveTopicProfile(save.id), null);
}));

test('validates save topic profile prompt contract shape', () => {
  assert.equal(validateSaveTopicProfile(validProfile()).ok, true);
  assert.equal(validateSaveTopicProfile(validProfile({ content_type: 'tag' })).reason, 'invalid-content-type');
  assert.equal(validateSaveTopicProfile(validProfile({ intent: 'folder' })).reason, 'invalid-intent');
  assert.equal(validateSaveTopicProfile(validProfile({ confidence: 1.5 })).reason, 'invalid-confidence');
  assert.equal(validateSaveTopicProfile(validProfile({ visible_text: undefined })).reason, 'missing-visible-text');
});
