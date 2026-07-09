const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  vectorToBuffer,
  bufferToVector,
} = require('../src/main/smart-category-vectors');

const {
  PRIMARY_MEMBERSHIP_THRESHOLD,
  SECONDARY_MEMBERSHIP_THRESHOLD,
  buildMembershipScoringInput,
  validateSmartCategoryMemberships,
  assignSmartCategoryMemberships,
} = require('../src/main/smart-category-memberships');

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
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-memberships-'));
    const db = loadDb(userData);
    try {
      db.initDatabase();
      await fn(db);
    } finally {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

function profile(overrides = {}) {
  return {
    save_id: 'save-1',
    summary: 'Tweet shows AI image tooling for ad campaign concept boards.',
    concepts: ['ai image generation', 'ad creative workflows', 'campaign testing'],
    content_type: 'tweet',
    intent_guess: 'inspiration',
    confidence: 0.91,
    ...overrides,
  };
}

function candidates() {
  return [
    {
      id: 'cat-ai',
      name: 'AI image generation',
      description: 'Visual AI examples and workflows',
      aliases: ['AI creative'],
    },
    {
      id: 'cat-ads',
      name: 'Ad creative workflows',
      description: 'Campaign ideation and ad systems',
      aliases: [],
    },
    {
      id: 'cat-marketing',
      name: 'Marketing systems',
      description: 'Marketing operations and automation',
      aliases: [],
    },
  ];
}

test('builds the bounded membership scoring input from a save topic profile and candidates', () => {
  const input = buildMembershipScoringInput(profile(), candidates());

  assert.deepEqual(input.save, {
    summary: 'Tweet shows AI image tooling for ad campaign concept boards.',
    concepts: ['ai image generation', 'ad creative workflows', 'campaign testing'],
    content_type: 'tweet',
    intent: 'inspiration',
  });
  assert.deepEqual(input.candidate_categories[0], {
    id: 'cat-ai',
    name: 'AI image generation',
    description: 'Visual AI examples and workflows',
    aliases: ['AI creative'],
  });
});

test('validates memberships with primary and secondary thresholds and omits low-confidence fits', () => {
  const result = validateSmartCategoryMemberships({
    memberships: [
      { category_id: 'cat-ai', weight: 0.91, evidence: 'Direct AI image generation fit.' },
      { category_id: 'cat-ads', weight: 0.58, evidence: 'Useful ad concept workflow overlap.' },
      { category_id: 'cat-marketing', weight: 0.42, evidence: 'Only broad marketing relation.' },
    ],
    needs_new_category: true,
    new_category_hint: 'AI ad concept boards',
  }, {
    candidateCategories: candidates(),
  });

  assert.equal(result.ok, true);
  assert.equal(PRIMARY_MEMBERSHIP_THRESHOLD, 0.75);
  assert.equal(SECONDARY_MEMBERSHIP_THRESHOLD, 0.45);
  assert.deepEqual(result.memberships.map((m) => [m.categoryId, m.weight, m.strength]), [
    ['cat-ai', 0.91, 'primary'],
    ['cat-ads', 0.58, 'secondary'],
  ]);
  assert.equal(result.needsNewCategory, true);
  assert.equal(result.newCategoryHint, 'AI ad concept boards');
});

test('assigns one save to multiple weighted categories and stores compact evidence', withTempDb(async (db) => {
  const save = db.insertSave({
    id: 'save-1',
    filePath: '/tmp/save.png',
    thumbPath: '/tmp/save-thumb.png',
    title: 'AI ad concept',
    createdAt: 1000,
  });
  for (const category of candidates()) {
    db.createSmartCategory({
      id: category.id,
      name: category.name,
      description: category.description,
      status: 'visible',
      createdAt: 1100,
      updatedAt: 1100,
    });
    for (const alias of category.aliases) {
      db.upsertSmartCategoryAlias({ categoryId: category.id, alias, createdAt: 1200 });
    }
  }

  const savedProfile = db.upsertSaveTopicProfile({
    saveId: save.id,
    concepts: profile().concepts,
    contentType: profile().content_type,
    intentGuess: profile().intent_guess,
    summary: profile().summary,
    confidence: profile().confidence,
    updatedAt: 1300,
  }).profile;

  let providerInput = null;
  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: savedProfile,
    candidateCategories: db.listSmartCategories().map((category) => ({
      ...category,
      aliases: db.getSmartCategoryAliases(category.id).map((alias) => alias.alias),
    })),
    provider: {
      async generateSmartCategoryMemberships(input) {
        providerInput = input;
        return {
          memberships: [
            { category_id: 'cat-ai', weight: 0.88, evidence: 'Concepts directly match AI image workflows.' },
            { category_id: 'cat-ads', weight: 0.63, evidence: 'Ad campaign ideation is a secondary use.' },
            { category_id: 'cat-marketing', weight: 0.2, evidence: 'Too broad to assign.' },
          ],
          needs_new_category: false,
          new_category_hint: null,
        };
      },
    },
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
    now: () => 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.assignedCount, 2);
  assert.equal(providerInput.candidate_categories.length, 3);

  const memberships = db.getSmartCategoriesForSave(save.id);
  assert.deepEqual(memberships.map((m) => [m.category_id, m.weight]), [
    ['cat-ai', 0.88],
    ['cat-ads', 0.63],
  ]);
  assert.deepEqual(memberships[0].evidence, {
    source: 'codex-membership',
    strength: 'primary',
    reason: 'Concepts directly match AI image workflows.',
  });
  assert.deepEqual(memberships[1].evidence, {
    source: 'codex-membership',
    strength: 'secondary',
    reason: 'Ad campaign ideation is a secondary use.',
  });
}));

test('uses local embeddings to assign weighted memberships without Codex scoring', withTempDb(async (db) => {
  const save = db.insertSave({
    id: 'save-local',
    filePath: '/tmp/local.png',
    thumbPath: '/tmp/local-thumb.png',
    title: 'AI ad concept',
    createdAt: 1000,
  });
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI image generation',
    status: 'visible',
    centroidEmbedding: vectorToBuffer([1, 0, 0]),
  });
  db.createSmartCategory({
    id: 'cat-ads',
    name: 'Ad creative workflows',
    status: 'visible',
    centroidEmbedding: vectorToBuffer([0.6, 0.8, 0]),
  });
  db.createSmartCategory({
    id: 'cat-marketing',
    name: 'Marketing systems',
    status: 'visible',
    centroidEmbedding: vectorToBuffer([0, 0, 1]),
  });

  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: profile({ save_id: save.id, embedding: null }),
    candidateCategories: db.listSmartCategories(),
    provider: {
      async embedText(input) {
        assert.match(input, /AI image tooling/);
        return [1, 0, 0];
      },
      async generateSmartCategoryMemberships() {
        throw new Error('Codex scoring should not run when local centroids score the save');
      },
    },
    upsertSaveTopicProfile: db.upsertSaveTopicProfile,
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
    getSmartCategoryMemberTopicEmbeddings: db.getSmartCategoryMemberTopicEmbeddings,
    updateSmartCategoryCentroidEmbedding: db.updateSmartCategoryCentroidEmbedding,
    now: () => 2500,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'local-embeddings');
  assert.equal(result.assignedCount, 2);
  assert.deepEqual(result.memberships.map((m) => [m.categoryId, m.weight, m.strength]), [
    ['cat-ai', 1, 'primary'],
    ['cat-ads', 0.6, 'secondary'],
  ]);

  const memberships = db.getSmartCategoriesForSave(save.id);
  assert.deepEqual(memberships.map((m) => [m.category_id, m.weight]), [
    ['cat-ai', 1],
    ['cat-ads', 0.6],
  ]);
  assert.equal(memberships[0].evidence.source, 'local-embedding-membership');
  assert.equal(memberships[0].evidence.strength, 'primary');
  assert.equal(memberships[1].evidence.strength, 'secondary');
  assert.deepEqual(Array.from(bufferToVector(db.getSaveTopicProfile(save.id).embedding)), [1, 0, 0]);
}));

test('falls back to Codex membership scoring when local embeddings fail', withTempDb(async (db) => {
  const save = db.insertSave({
    id: 'save-fallback',
    filePath: '/tmp/fallback.png',
    thumbPath: '/tmp/fallback-thumb.png',
    title: 'Fallback save',
    createdAt: 1000,
  });
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI image generation',
    status: 'visible',
    centroidEmbedding: vectorToBuffer([1, 0, 0]),
  });

  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: profile({ save_id: save.id }),
    candidateCategories: [db.getSmartCategory('cat-ai')],
    provider: {
      async embedText() {
        const err = new Error('local server unavailable');
        err.code = 'local_ai_error';
        throw err;
      },
      async generateSmartCategoryMemberships() {
        return {
          memberships: [
            { category_id: 'cat-ai', weight: 0.82, evidence: 'Codex fallback fit.' },
          ],
          needs_new_category: false,
          new_category_hint: null,
        };
      },
    },
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'codex-membership');
  assert.equal(result.assignedCount, 1);
  assert.deepEqual(db.getSmartCategoriesForSave(save.id)[0].evidence, {
    source: 'codex-membership',
    strength: 'primary',
    reason: 'Codex fallback fit.',
  });
}));

test('Codex fallback bootstraps topic embeddings and centroids for later local scoring', withTempDb(async (db) => {
  const save = db.insertSave({
    id: 'save-bootstrap',
    filePath: '/tmp/bootstrap.png',
    thumbPath: '/tmp/bootstrap-thumb.png',
    title: 'Bootstrap save',
    createdAt: 1000,
  });
  db.createSmartCategory({
    id: 'cat-ai',
    name: 'AI image generation',
    status: 'visible',
  });

  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: profile({ save_id: save.id, embedding: null }),
    candidateCategories: [db.getSmartCategory('cat-ai')],
    provider: {
      async embedText() {
        return [1, 0, 0];
      },
      async generateSmartCategoryMemberships() {
        return {
          memberships: [
            { category_id: 'cat-ai', weight: 0.86, evidence: 'Codex assignment seeds centroid.' },
          ],
          needs_new_category: false,
          new_category_hint: null,
        };
      },
    },
    upsertSaveTopicProfile: db.upsertSaveTopicProfile,
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
    getSmartCategoryMemberTopicEmbeddings: db.getSmartCategoryMemberTopicEmbeddings,
    updateSmartCategoryCentroidEmbedding: db.updateSmartCategoryCentroidEmbedding,
    now: () => 3000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'codex-membership');
  assert.deepEqual(Array.from(bufferToVector(db.getSaveTopicProfile(save.id).embedding)), [1, 0, 0]);
  assert.deepEqual(Array.from(bufferToVector(db.getSmartCategory('cat-ai').centroid_embedding)), [1, 0, 0]);
}));

test('low-confidence saves remain unassigned instead of being forced into categories', withTempDb(async (db) => {
  const save = db.insertSave({
    id: 'save-low',
    filePath: '/tmp/low.png',
    thumbPath: '/tmp/low-thumb.png',
    title: 'Ambiguous save',
    createdAt: 1000,
  });
  db.createSmartCategory({ id: 'cat-ai', name: 'AI image generation', status: 'visible' });

  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: profile({ save_id: save.id }),
    candidateCategories: [db.getSmartCategory('cat-ai')],
    provider: {
      async generateSmartCategoryMemberships() {
        return {
          memberships: [
            { category_id: 'cat-ai', weight: 0.44, evidence: 'Weak generic AI mention.' },
          ],
          needs_new_category: true,
          new_category_hint: 'pricing screenshots',
        };
      },
    },
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
  });

  assert.equal(result.ok, true);
  assert.equal(result.assignedCount, 0);
  assert.equal(result.needsNewCategory, true);
  assert.equal(result.newCategoryHint, 'pricing screenshots');
  assert.deepEqual(db.getSmartCategoriesForSave(save.id), []);
}));

test('invalid provider membership JSON fails without changing category state', withTempDb(async (db) => {
  const save = db.insertSave({
    id: 'save-invalid',
    filePath: '/tmp/invalid.png',
    thumbPath: '/tmp/invalid-thumb.png',
    title: 'Invalid response',
    createdAt: 1000,
  });
  db.createSmartCategory({ id: 'cat-ai', name: 'AI image generation', status: 'visible' });

  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: profile({ save_id: save.id }),
    candidateCategories: [db.getSmartCategory('cat-ai')],
    provider: {
      async generateSmartCategoryMemberships() {
        return { memberships: [{ category_id: 'cat-ai', weight: 1.2, evidence: 'bad' }] };
      },
    },
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-weight');
  assert.deepEqual(db.getSmartCategoriesForSave(save.id), []);
}));
