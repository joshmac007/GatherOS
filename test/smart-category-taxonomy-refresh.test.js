const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TAXONOMY_REFRESH_CONFIG,
  isCosmeticRename,
  validateTaxonomyRefreshOutput,
  runSmartCategoryTaxonomyRefresh,
} = require('../src/main/smart-category-taxonomy-refresh');

const baseCategories = [
  {
    id: 'cat-ai',
    name: 'AI tools',
    description: 'Tools and examples for applied AI workflows',
    status: 'visible',
    frozen_name: false,
    last_changed_at: 1_000,
    member_count: 12,
    aliases: ['AI apps'],
  },
  {
    id: 'cat-design',
    name: 'Design references',
    description: 'Visual references for product and web design',
    status: 'visible',
    frozen_name: false,
    last_changed_at: 1_000,
    member_count: 9,
    aliases: [],
  },
];

test('cosmetic rename detection rejects casing punctuation plural-only changes', () => {
  assert.equal(isCosmeticRename('AI tools', 'AI Tools!'), true);
  assert.equal(isCosmeticRename('AI tool', 'AI tools'), true);
  assert.equal(isCosmeticRename('AI tools', 'AI workflow tools'), false);
});

test('taxonomy output validation rejects invalid shape before mutation', () => {
  const result = validateTaxonomyRefreshOutput({
    renames: [{ category_id: 'cat-ai', new_name: 'AI workflow tools', confidence: 1.2, reason: 'clearer' }],
    aliases: [],
    merges: [],
    splits: [],
  }, { categories: baseCategories });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-rename-confidence');
});

test('taxonomy refresh applies conservative aliases and non-cosmetic rename', async () => {
  const calls = [];
  const runs = [];
  const result = await runSmartCategoryTaxonomyRefresh({
    categories: baseCategories,
    providerName: 'codex',
    provider: {
      async generateSmartCategoryTaxonomyRefresh(input) {
        assert.equal(input.categories[0].id, 'cat-ai');
        assert.deepEqual(input.categories[0].aliases, ['AI apps']);
        return {
          renames: [{
            category_id: 'cat-ai',
            new_name: 'AI workflow tools',
            old_name_alias: 'AI tools',
            confidence: 0.94,
            reason: 'Recent members are consistently about AI workflow tooling.',
          }],
          aliases: [{
            category_id: 'cat-design',
            alias: 'web design inspiration',
            confidence: 0.91,
            reason: 'Common user search language.',
          }],
          merges: [],
          splits: [],
        };
      },
    },
    storage: {
      applySmartCategoryTaxonomyChanges: (payload) => {
        calls.push(payload);
        return {
          ok: true,
          renamedCount: payload.renames.length,
          aliasCount: payload.aliases.length,
        };
      },
      recordSmartCategoryRun: (record) => {
        runs.push(record);
        return { ok: true, run: record };
      },
    },
    now: () => 20 * 24 * 60 * 60 * 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.renamedCount, 1);
  assert.equal(result.aliasCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].renames[0].automatic, true);
  assert.equal(calls[0].renames[0].changedAt, 20 * 24 * 60 * 60 * 1000);
  assert.equal(calls[0].aliases[0].source, 'model_synonym');
  assert.equal(runs[0].runType, 'taxonomy_refresh');
  assert.equal(runs[0].renamedCount, 1);
  assert.equal(runs[0].failedCount, 0);
});

test('taxonomy refresh rejects cosmetic rename and obeys cooldown and pinned rules', async () => {
  const calls = [];
  const categories = [
    { ...baseCategories[0], last_changed_at: 10_000 },
    { ...baseCategories[1], last_changed_at: 10_000 },
    { id: 'cat-pinned', name: 'Pinned name', status: 'visible', frozen_name: true, last_changed_at: 1_000 },
  ];
  const result = await runSmartCategoryTaxonomyRefresh({
    categories,
    providerName: 'codex',
    provider: {
      async generateSmartCategoryTaxonomyRefresh() {
        return {
          renames: [
            {
              category_id: 'cat-ai',
              new_name: 'AI Tools!',
              old_name_alias: 'AI tools',
              confidence: 0.99,
              reason: 'Capitalization.',
            },
            {
              category_id: 'cat-design',
              new_name: 'Product design references',
              old_name_alias: 'Design references',
              confidence: 0.96,
              reason: 'Too soon after last accepted name change.',
            },
            {
              category_id: 'cat-pinned',
              new_name: 'Pinned workflows',
              old_name_alias: 'Pinned name',
              confidence: 0.96,
              reason: 'Pinned categories keep user-selected labels.',
            },
          ],
          aliases: [],
          merges: [],
          splits: [],
        };
      },
    },
    storage: {
      applySmartCategoryTaxonomyChanges: (payload) => calls.push(payload),
      recordSmartCategoryRun: () => ({ ok: true }),
    },
    now: () => 20_000,
    config: { ...DEFAULT_TAXONOMY_REFRESH_CONFIG, renameCooldownMs: 60_000 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.renamedCount, 0);
  assert.deepEqual(result.skippedRenames.map((skip) => [skip.categoryId, skip.reason]), [
    ['cat-ai', 'cosmetic-rename'],
    ['cat-design', 'rename-cooldown'],
    ['cat-pinned', 'name-frozen'],
  ]);
  assert.deepEqual(calls, []);
});

test('invalid taxonomy output records failure and keeps prior taxonomy untouched', async () => {
  const calls = [];
  const runs = [];
  const result = await runSmartCategoryTaxonomyRefresh({
    categories: baseCategories,
    providerName: 'codex',
    provider: {
      async generateSmartCategoryTaxonomyRefresh() {
        return {
          renames: [{ category_id: 'missing', new_name: 'Unknown', confidence: 0.95, reason: 'bad id' }],
          aliases: [],
          merges: [],
          splits: [],
        };
      },
    },
    storage: {
      applySmartCategoryTaxonomyChanges: (payload) => calls.push(payload),
      recordSmartCategoryRun: (record) => {
        runs.push(record);
        return { ok: true, run: record };
      },
    },
    now: () => 50_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-rename-category');
  assert.deepEqual(calls, []);
  assert.equal(runs[0].failedCount, 1);
  assert.match(runs[0].error, /unknown-rename-category/);
});

test('merge and split proposals are deferred into run metadata only', async () => {
  const calls = [];
  const runs = [];
  const result = await runSmartCategoryTaxonomyRefresh({
    categories: baseCategories,
    providerName: 'codex',
    provider: {
      async generateSmartCategoryTaxonomyRefresh() {
        return {
          renames: [],
          aliases: [],
          merges: [{
            category_ids: ['cat-ai', 'cat-design'],
            proposed_name: 'Creative systems',
            confidence: 0.93,
            reason: 'Overlap exists, but assignment behavior is not stable enough.',
          }],
          splits: [{
            category_id: 'cat-design',
            proposed_names: ['SaaS UI examples', 'Brand references'],
            confidence: 0.91,
            reason: 'Two repeated subtopics appeared.',
          }],
        };
      },
    },
    storage: {
      applySmartCategoryTaxonomyChanges: (payload) => calls.push(payload),
      recordSmartCategoryRun: (record) => {
        runs.push(record);
        return { ok: true, run: record };
      },
    },
    now: () => 100_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferredMerges.length, 1);
  assert.equal(result.deferredSplits.length, 1);
  assert.deepEqual(calls, []);
  assert.equal(runs[0].mergedCount, 0);
  assert.equal(runs[0].splitCount, 0);
  const metadata = runs[0].metadata;
  assert.equal(metadata.deferred_merges[0].proposed_name, 'Creative systems');
  assert.deepEqual(metadata.deferred_splits[0].proposed_names, ['SaaS UI examples', 'Brand references']);
});

test('taxonomy refresh applies no changes when atomic storage apply fails', async () => {
  const calls = [];
  const runs = [];
  const result = await runSmartCategoryTaxonomyRefresh({
    categories: baseCategories,
    providerName: 'codex',
    provider: {
      async generateSmartCategoryTaxonomyRefresh() {
        return {
          renames: [{
            category_id: 'cat-ai',
            new_name: 'AI workflow tools',
            old_name_alias: 'AI tools',
            confidence: 0.95,
            reason: 'Clearer durable category meaning.',
          }],
          aliases: [{
            category_id: 'cat-design',
            alias: 'web design inspiration',
            confidence: 0.95,
            reason: 'Common search language.',
          }],
          merges: [],
          splits: [],
        };
      },
    },
    storage: {
      applySmartCategoryTaxonomyChanges: (payload) => {
        calls.push(payload);
        return { ok: false, reason: 'apply-failed' };
      },
      recordSmartCategoryRun: (record) => {
        runs.push(record);
        return { ok: true, run: record };
      },
    },
    now: () => 100_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'apply-failed');
  assert.equal(result.renamedCount, 0);
  assert.equal(result.aliasCount, 0);
  assert.equal(calls.length, 1);
  assert.equal(runs[0].failedCount, 1);
});

test('low-confidence merge and split proposals are invalid', () => {
  const result = validateTaxonomyRefreshOutput({
    renames: [],
    aliases: [],
    merges: [{
      category_ids: ['cat-ai', 'cat-design'],
      proposed_name: 'Creative systems',
      confidence: 0.4,
      reason: 'Too weak.',
    }],
    splits: [],
  }, { categories: baseCategories });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'low-merge-confidence');
});
