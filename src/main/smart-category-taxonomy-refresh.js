'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TAXONOMY_REFRESH_CONFIG = {
  renameCooldownMs: 14 * DAY_MS,
  minRenameConfidence: 0.9,
  minAliasConfidence: 0.8,
  minStructuralProposalConfidence: 0.9,
  maxCategories: 80,
};

const SMART_CATEGORY_TAXONOMY_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    renames: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          category_id: { type: 'string', minLength: 1, maxLength: 120 },
          new_name: { type: 'string', minLength: 1, maxLength: 160 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 400 },
        },
        required: ['category_id', 'new_name', 'confidence', 'reason'],
      },
    },
    aliases: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          category_id: { type: 'string', minLength: 1, maxLength: 120 },
          alias: { type: 'string', minLength: 1, maxLength: 160 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          source: { type: 'string', maxLength: 40 },
        },
        required: ['category_id', 'alias', 'confidence', 'source'],
      },
    },
    merges: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          category_ids: {
            type: 'array', minItems: 2, maxItems: 80,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
          proposed_name: { type: ['string', 'null'], maxLength: 160 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 400 },
        },
        required: ['category_ids', 'proposed_name', 'confidence', 'reason'],
      },
    },
    splits: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          category_id: { type: 'string', minLength: 1, maxLength: 120 },
          proposed_names: {
            type: 'array', minItems: 2, maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 400 },
        },
        required: ['category_id', 'proposed_names', 'confidence', 'reason'],
      },
    },
  },
  required: ['renames', 'aliases', 'merges', 'splits'],
});

function clean(value, max = 1000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function canonicalName(value) {
  return clean(value, 200).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean).map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token).join(' ');
}

function isCosmeticRename(oldName, newName) {
  return !!canonicalName(oldName) && canonicalName(oldName) === canonicalName(newName);
}

function confidence(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function buildTaxonomyRefreshInput({ categories = [], maxCategories = 80 } = {}) {
  return {
    categories: (Array.isArray(categories) ? categories : [])
      .filter((category) => category?.status === 'visible' || category?.status === 'candidate')
      .slice(0, Math.max(1, Number(maxCategories) || 80))
      .map((category) => ({
        id: clean(category.id, 120),
        name: clean(category.name, 160),
        description: clean(category.description, 400),
        status: category.status,
        frozen_name: !!category.frozen_name,
        last_changed_at: Number(category.last_changed_at) || null,
        member_count: Math.max(0, Number(category.member_count) || 0),
        aliases: Array.isArray(category.aliases) ? category.aliases.map((alias) => clean(alias, 160)).filter(Boolean).slice(0, 16) : [],
      })).filter((category) => category.id && category.name),
  };
}

function validateTaxonomyRefreshOutput(parsed, { categories = [], config = DEFAULT_TAXONOMY_REFRESH_CONFIG } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not-object' };
  for (const key of ['renames', 'aliases', 'merges', 'splits']) {
    if (!Array.isArray(parsed[key])) return { ok: false, reason: `missing-${key}` };
  }
  const byId = new Map(categories.map((category) => [clean(category.id, 120), category]));
  const renames = [];
  for (const item of parsed.renames) {
    const categoryId = clean(item?.category_id || item?.categoryId, 120);
    if (!byId.has(categoryId)) return { ok: false, reason: 'unknown-rename-category' };
    const newName = clean(item?.new_name || item?.newName, 160);
    const score = confidence(item?.confidence);
    const reason = clean(item?.reason, 400);
    if (!newName) return { ok: false, reason: 'missing-rename-name' };
    if (score == null) return { ok: false, reason: 'invalid-rename-confidence' };
    if (!reason) return { ok: false, reason: 'missing-rename-reason' };
    renames.push({ categoryId, newName, confidence: score, reason });
  }
  const aliases = [];
  for (const item of parsed.aliases) {
    const categoryId = clean(item?.category_id || item?.categoryId, 120);
    if (!byId.has(categoryId)) return { ok: false, reason: 'unknown-alias-category' };
    const alias = clean(item?.alias, 160);
    const score = confidence(item?.confidence, 1);
    if (!alias) return { ok: false, reason: 'missing-alias' };
    aliases.push({ categoryId, alias, confidence: score, source: clean(item?.source, 40) || 'model_synonym' });
  }
  const minStructural = confidence(config.minStructuralProposalConfidence, 0.9);
  const merges = [];
  for (const item of parsed.merges) {
    const categoryIds = Array.isArray(item?.category_ids) ? [...new Set(item.category_ids.map((id) => clean(id, 120)).filter(Boolean))] : [];
    if (categoryIds.length < 2 || categoryIds.some((id) => !byId.has(id))) return { ok: false, reason: 'invalid-merge-categories' };
    const score = confidence(item.confidence);
    if (score == null || score < minStructural) return { ok: false, reason: 'low-merge-confidence' };
    const reason = clean(item.reason, 400);
    if (!reason) return { ok: false, reason: 'missing-merge-reason' };
    merges.push({ category_ids: categoryIds, proposed_name: clean(item.proposed_name, 160) || null, confidence: score, reason });
  }
  const splits = [];
  for (const item of parsed.splits) {
    const categoryId = clean(item?.category_id, 120);
    const names = Array.isArray(item?.proposed_names) ? item.proposed_names.map((name) => clean(name, 160)).filter(Boolean) : [];
    if (!byId.has(categoryId) || names.length < 2) return { ok: false, reason: 'invalid-split-category' };
    const score = confidence(item.confidence);
    if (score == null || score < minStructural) return { ok: false, reason: 'low-split-confidence' };
    const reason = clean(item.reason, 400);
    if (!reason) return { ok: false, reason: 'missing-split-reason' };
    splits.push({ category_id: categoryId, proposed_names: names.slice(0, 8), confidence: score, reason });
  }
  return { ok: true, renames, aliases, merges, splits };
}

async function runSmartCategoryTaxonomyRefresh({
  categories = [],
  structuredProvider,
  providerName = null,
  storage = {},
  now = Date.now,
  runType = 'taxonomy_refresh',
  config = DEFAULT_TAXONOMY_REFRESH_CONFIG,
  signal,
} = {}) {
  const startedAt = now();
  const input = buildTaxonomyRefreshInput({ categories, maxCategories: config.maxCategories });
  const finish = (summary) => {
    const run = {
      runType, startedAt, finishedAt: now(),
      inputSaveCount: input.categories.reduce((sum, category) => sum + category.member_count, 0),
      createdCount: 0, renamedCount: summary.renamedCount || 0, mergedCount: 0, splitCount: 0,
      failedCount: summary.failedCount || 0, provider: providerName, error: summary.error || null,
      metadata: {
        skipped_renames: summary.skippedRenames || [],
        deferred_merges: summary.deferredMerges || [],
        deferred_splits: summary.deferredSplits || [],
      },
    };
    if (!signal?.aborted) storage.recordSmartCategoryRun?.(run);
    return {
      ok: summary.ok !== false,
      reason: summary.reason || null,
      retryable: summary.retryable === true,
      processedCount: Number(summary.processedCount) || 0,
      completedCount: Number(summary.completedCount) || 0,
      failedCount: Number(summary.failedCount) || 0,
      ...summary,
      ok: summary.ok !== false,
      retryable: summary.retryable === true,
      processedCount: Number(summary.processedCount) || 0,
      completedCount: Number(summary.completedCount) || 0,
      failedCount: Number(summary.failedCount) || 0,
      run,
    };
  };
  if (signal?.aborted) return finish({ ok: false, reason: 'aborted', failedCount: 0 });
  if (!input.categories.length) return finish({ ok: true, reason: 'no-categories', renamedCount: 0, aliasCount: 0, failedCount: 0 });
  if (typeof structuredProvider?.completeJson !== 'function') return finish({ ok: false, reason: 'unsupported-provider', failedCount: 1, error: 'unsupported-provider' });
  let parsed;
  try {
    parsed = await structuredProvider.completeJson({
      system:
        'Review learned categories conservatively. Return JSON only: ' +
        '{"renames":[],"aliases":[],"merges":[],"splits":[]}. ' +
        'Each proposal needs category IDs, confidence, and reason. Prefer aliases over renames. Do not apply merges or splits.',
      input: JSON.stringify(input),
      maxOutputTokens: 1200,
      outputSchema: SMART_CATEGORY_TAXONOMY_OUTPUT_SCHEMA,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return finish({ ok: false, reason: 'aborted', failedCount: 0 });
    return finish({
      ok: false,
      reason: error?.code || 'provider-error',
      retryable: error?.retryable === true,
      failedCount: 1,
      error: error?.message || String(error),
    });
  }
  if (signal?.aborted) return finish({ ok: false, reason: 'aborted', failedCount: 0 });
  const validation = validateTaxonomyRefreshOutput(parsed, { categories: input.categories, config });
  if (!validation.ok) return finish({ ok: false, reason: validation.reason, failedCount: 1, error: validation.reason });

  const byId = new Map(input.categories.map((category) => [category.id, category]));
  const names = new Set(input.categories.map((category) => canonicalName(category.name)));
  const timestamp = now();
  const skippedRenames = [];
  const renames = [];
  const aliases = [];
  for (const rename of validation.renames) {
    const category = byId.get(rename.categoryId);
    let reason = null;
    if (category.frozen_name) reason = 'name-frozen';
    else if (rename.confidence < confidence(config.minRenameConfidence, 0.9)) reason = 'low-confidence';
    else if (isCosmeticRename(category.name, rename.newName)) reason = 'cosmetic-rename';
    else if (category.last_changed_at && timestamp - category.last_changed_at < config.renameCooldownMs) reason = 'rename-cooldown';
    else if (names.has(canonicalName(rename.newName)) && canonicalName(rename.newName) !== canonicalName(category.name)) reason = 'duplicate-name';
    if (reason) skippedRenames.push({ categoryId: rename.categoryId, reason, proposedName: rename.newName });
    else {
      renames.push({ id: rename.categoryId, name: rename.newName, automatic: true, changedAt: timestamp });
      names.delete(canonicalName(category.name));
      names.add(canonicalName(rename.newName));
    }
  }
  for (const alias of validation.aliases) {
    const category = byId.get(alias.categoryId);
    if (alias.confidence < confidence(config.minAliasConfidence, 0.8)) continue;
    if (canonicalName(alias.alias) === canonicalName(category.name)) continue;
    if (category.aliases.some((existing) => canonicalName(existing) === canonicalName(alias.alias))) continue;
    aliases.push({ categoryId: alias.categoryId, alias: alias.alias, source: alias.source, createdAt: timestamp });
  }
  let renamedCount = 0;
  let aliasCount = 0;
  if (renames.length || aliases.length) {
    if (signal?.aborted) return finish({ ok: false, reason: 'aborted', failedCount: 0 });
    if (typeof storage.applySmartCategoryTaxonomyChanges !== 'function') {
      return finish({ ok: false, reason: 'missing-taxonomy-storage', failedCount: 1, error: 'missing-taxonomy-storage', skippedRenames, deferredMerges: validation.merges, deferredSplits: validation.splits });
    }
    let result;
    try {
      result = storage.applySmartCategoryTaxonomyChanges({ renames, aliases, changedAt: timestamp });
    } catch (error) {
      return finish({ ok: false, reason: 'taxonomy-apply-failed', failedCount: 1, error: error?.message || String(error) });
    }
    if (!result?.ok) return finish({ ok: false, reason: result?.reason || 'taxonomy-apply-failed', failedCount: 1, error: result?.reason || 'taxonomy-apply-failed' });
    renamedCount = Number(result.renamedCount) || 0;
    aliasCount = Number(result.aliasCount) || 0;
  }
  return finish({ ok: true, renamedCount, aliasCount, skippedRenames, deferredMerges: validation.merges, deferredSplits: validation.splits, failedCount: 0, error: null });
}

module.exports = {
  DEFAULT_TAXONOMY_REFRESH_CONFIG,
  SMART_CATEGORY_TAXONOMY_OUTPUT_SCHEMA,
  isCosmeticRename,
  buildTaxonomyRefreshInput,
  validateTaxonomyRefreshOutput,
  runSmartCategoryTaxonomyRefresh,
};
