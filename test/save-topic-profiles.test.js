const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSaveTopicEvidence,
  createSaveTopicProfile,
  enrichSaveTopicProfile,
  validateSaveTopicProfile,
} = require('../src/main/save-topic-profiles');
const { assignSaveToExistingSmartCategories } = require('../src/main/smart-category-memberships');

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

function floatBuffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

test('enrichment entrypoint uses active semantic vectors without Codex membership or embedText', async () => {
  let codexMembershipCalls = 0;
  const memberships = [];
  const result = await enrichSaveTopicProfile({
    record: { id: 'save-target', title: 'Target' },
    getSave: () => ({ id: 'save-target', title: 'Target' }),
    getTagsForSave: () => [],
    topicProvider: { generateSaveTopicProfile: async () => validProfile() },
    upsertSaveTopicProfile: (profile) => ({
      ok: true,
      profile: { save_id: profile.saveId, concepts: profile.concepts, summary: profile.summary },
    }),
    assignMemberships: assignSaveToExistingSmartCategories,
    membershipProvider: {
      generateSmartCategoryMemberships: async () => {
        codexMembershipCalls += 1;
        throw new Error('Codex membership should not run');
      },
    },
    listSmartCategories: () => [{ id: 'cat-a', name: 'Aviation', status: 'visible' }],
    getSmartCategoryAliases: () => [],
    upsertSmartCategoryMembership: (membership) => memberships.push(membership),
    getSemanticIndexState: () => ({ active_generation_id: 'gen-active' }),
    getSemanticVector: () => ({
      generation_id: 'gen-active', save_id: 'save-target', model: 'embeddinggemma', dimension: 2,
      source_hash: 'target-hash', vector: floatBuffer([1, 0]),
    }),
    getActiveSemanticVectors: () => [
      {
        generation_id: 'gen-active', save_id: 'save-target', model: 'embeddinggemma', dimension: 2,
        source_hash: 'target-hash', vector: floatBuffer([1, 0]),
      },
      {
        generation_id: 'gen-active', save_id: 'save-member', model: 'embeddinggemma', dimension: 2,
        source_hash: 'member-hash', vector: floatBuffer([1, 0]),
      },
    ],
    getSmartCategoryMembers: () => [{ save_id: 'save-member', weight: 1 }],
    now: () => 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.membership.provider, 'ollama-semantic-index');
  assert.equal(codexMembershipCalls, 0);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].categoryId, 'cat-a');
});

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

test('successful topic-profile persistence notifies canonical semantic change', async () => {
  const changed = [];
  const result = await createSaveTopicProfile({
    save: { id: 'topic-change', kind: 'url', title: 'A title' },
    provider: {
      async generateSaveTopicProfile() {
        return {
          summary: 'A concrete searchable summary.',
          concepts: ['pricing', 'layout', 'saas'],
          content_type: 'article',
          intent: 'research',
          visible_text: '',
          confidence: 0.9,
        };
      },
    },
    upsertSaveTopicProfile: (profile) => ({ ok: true, profile }),
    onProfilePersisted: async (saveId) => changed.push(saveId),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(changed, ['topic-change']);
});
