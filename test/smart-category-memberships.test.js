const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  vectorToBuffer,
} = require('../src/main/smart-category-vectors');

const {
  PRIMARY_MEMBERSHIP_THRESHOLD,
  SECONDARY_MEMBERSHIP_THRESHOLD,
  buildMembershipScoringInput,
  computeSemanticCategoryCentroid,
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

test('computes deterministic category centroid identity from matching active-generation members', () => {
  const identity = {
    generationId: 'gen-active',
    model: 'embeddinggemma',
    dimension: 3,
  };
  const rows = [
    {
      save_id: 'save-b',
      weight: 0.7,
      generation_id: 'gen-active',
      model: 'embeddinggemma',
      dimension: 3,
      source_hash: 'hash-b',
      vector: vectorToBuffer([0.6, 0.8, 0]),
    },
    {
      save_id: 'save-a',
      weight: 0.9,
      generation_id: 'gen-active',
      model: 'embeddinggemma',
      dimension: 3,
      source_hash: 'hash-a',
      vector: vectorToBuffer([1, 0, 0]),
    },
    {
      save_id: 'wrong-model',
      weight: 1,
      generation_id: 'gen-active',
      model: 'other-model',
      dimension: 3,
      source_hash: 'wrong-model-hash',
      vector: vectorToBuffer([0, 0, 1]),
    },
  ];

  const first = computeSemanticCategoryCentroid({ categoryId: 'cat-ai', identity, members: rows });
  const reordered = computeSemanticCategoryCentroid({
    categoryId: 'cat-ai',
    identity,
    members: [rows[1], rows[0], rows[2]],
  });

  assert.equal(first.ok, true);
  assert.deepEqual(first.identity, {
    generationId: 'gen-active',
    model: 'embeddinggemma',
    dimension: 3,
    sourceHash: reordered.identity.sourceHash,
  });
  assert.deepEqual(Array.from(first.vector), Array.from(reordered.vector));
  assert.equal(first.memberCount, 2);
});

test('uses active semantic generation vectors without calling Codex scoring or embedding', async () => {
  const activeVectors = [
    {
      save_id: 'member-ai', generation_id: 'gen-active', model: 'embeddinggemma', dimension: 3,
      source_hash: 'hash-ai', vector: vectorToBuffer([1, 0, 0]),
    },
    {
      save_id: 'member-ads', generation_id: 'gen-active', model: 'embeddinggemma', dimension: 3,
      source_hash: 'hash-ads', vector: vectorToBuffer([0.6, 0.8, 0]),
    },
    {
      save_id: 'member-marketing', generation_id: 'gen-active', model: 'embeddinggemma', dimension: 3,
      source_hash: 'hash-marketing', vector: vectorToBuffer([0, 0, 1]),
    },
  ];
  const membersByCategory = {
    'cat-ai': [{ save_id: 'member-ai', weight: 0.9 }],
    'cat-ads': [{ save_id: 'member-ads', weight: 0.8 }],
    'cat-marketing': [{ save_id: 'member-marketing', weight: 0.7 }],
  };
  const stored = [];
  let embedCalls = 0;
  let codexCalls = 0;

  const result = await assignSmartCategoryMemberships({
    saveId: 'save-local',
    profile: profile({ save_id: 'save-local', embedding: vectorToBuffer([0, 0, 1]) }),
    candidateCategories: candidates(),
    provider: {
      async embedText() { embedCalls += 1; throw new Error('must not be called'); },
      async generateSmartCategoryMemberships() { codexCalls += 1; throw new Error('must not be called'); },
    },
    getSemanticIndexState: () => ({ active_generation_id: 'gen-active' }),
    getSemanticVector: () => ({
      save_id: 'save-local', generation_id: 'gen-active', model: 'embeddinggemma', dimension: 3,
      source_hash: 'hash-target', vector: vectorToBuffer([1, 0, 0]),
    }),
    getActiveSemanticVectors: () => activeVectors,
    getSmartCategoryMembers: (categoryId) => membersByCategory[categoryId] || [],
    upsertSmartCategoryMembership: (entry) => { stored.push(entry); return { ok: true }; },
    now: () => 2500,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'ollama-semantic-index');
  assert.equal(result.assignedCount, 2);
  assert.equal(embedCalls, 0);
  assert.equal(codexCalls, 0);
  assert.deepEqual(result.memberships.map((m) => [m.categoryId, m.weight, m.strength]), [
    ['cat-ai', 1, 'primary'],
    ['cat-ads', 0.6, 'secondary'],
  ]);
  assert.equal(stored[0].evidence.source, 'ollama-semantic-membership');
  assert.equal(stored[0].evidence.generationId, 'gen-active');
  assert.equal(stored[0].evidence.model, 'embeddinggemma');
  assert.equal(stored[0].evidence.dimension, 3);
  assert.match(stored[0].evidence.centroidSourceHash, /^[a-f0-9]{64}$/);
});

test('never compares mismatched vector identities and falls back to Codex membership scoring', withTempDb(async (db) => {
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
  });

  let codexCalls = 0;
  const result = await assignSmartCategoryMemberships({
    saveId: save.id,
    profile: profile({ save_id: save.id }),
    candidateCategories: [db.getSmartCategory('cat-ai')],
    provider: {
      async generateSmartCategoryMemberships() {
        codexCalls += 1;
        return {
          memberships: [
            { category_id: 'cat-ai', weight: 0.82, evidence: 'Codex fallback fit.' },
          ],
          needs_new_category: false,
          new_category_hint: null,
        };
      },
    },
    getSemanticIndexState: () => ({ active_generation_id: 'gen-active' }),
    getSemanticVector: () => ({
      save_id: save.id, generation_id: 'gen-active', model: 'embeddinggemma', dimension: 3,
      source_hash: 'target-hash', vector: vectorToBuffer([1, 0, 0]),
    }),
    getActiveSemanticVectors: () => [{
      save_id: 'member-old', generation_id: 'gen-old', model: 'embeddinggemma', dimension: 3,
      source_hash: 'old-hash', vector: vectorToBuffer([1, 0, 0]),
    }],
    getSmartCategoryMembers: () => [{ save_id: 'member-old', weight: 0.9 }],
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'codex-membership');
  assert.equal(codexCalls, 1);
  assert.equal(result.assignedCount, 1);
  assert.deepEqual(db.getSmartCategoriesForSave(save.id)[0].evidence, {
    source: 'codex-membership',
    strength: 'primary',
    reason: 'Codex fallback fit.',
  });
}));

test('Codex fallback never creates vectors or legacy centroids', withTempDb(async (db) => {
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
    profile: profile({ save_id: save.id, embedding: vectorToBuffer([1, 0, 0]) }),
    candidateCategories: [db.getSmartCategory('cat-ai')],
    provider: {
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
    upsertSmartCategoryMembership: db.upsertSmartCategoryMembership,
    now: () => 3000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'codex-membership');
  assert.equal(db.getSaveTopicProfile(save.id), null);
  assert.equal(db.getSmartCategory('cat-ai').centroid_embedding, null);
}));

test('smart category membership module contains no generic embedText path', () => {
  const source = fs.readFileSync(require.resolve('../src/main/smart-category-memberships'), 'utf8');
  assert.doesNotMatch(source, /embedText/);
  assert.doesNotMatch(source, /getSmartCategoryMemberTopicEmbeddings/);
  assert.doesNotMatch(source, /centroid_embedding/);
});

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
