const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TAXONOMY_REFRESH_CONFIG = {
  renameCooldownMs: 14 * DAY_MS,
  minRenameConfidence: 0.9,
  minAliasConfidence: 0.8,
  minStructuralProposalConfidence: 0.9,
  maxCategories: 80,
};

function cleanString(value, max = 1000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function singularToken(token) {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

function canonicalName(value) {
  return cleanString(value, 200)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularToken)
    .join(' ');
}

function isCosmeticRename(oldName, newName) {
  const oldCanonical = canonicalName(oldName);
  const nextCanonical = canonicalName(newName);
  return !!oldCanonical && oldCanonical === nextCanonical;
}

function confidenceValue(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function categoryIndex(categories = []) {
  return new Map(
    (Array.isArray(categories) ? categories : [])
      .map((category) => [cleanString(category?.id, 120), category])
      .filter(([id]) => id),
  );
}

function normalizeMergeProposal(item, categoriesById, config = DEFAULT_TAXONOMY_REFRESH_CONFIG) {
  const categoryIds = Array.isArray(item?.category_ids || item?.categoryIds)
    ? (item.category_ids || item.categoryIds).map((id) => cleanString(id, 120)).filter(Boolean)
    : [];
  if (categoryIds.length < 2) return { ok: false, reason: 'invalid-merge-categories' };
  for (const id of categoryIds) {
    if (!categoriesById.has(id)) return { ok: false, reason: 'unknown-merge-category' };
  }
  const confidence = confidenceValue(item?.confidence);
  if (confidence == null) return { ok: false, reason: 'invalid-merge-confidence' };
  const minConfidence = confidenceValue(
    config.minStructuralProposalConfidence,
    DEFAULT_TAXONOMY_REFRESH_CONFIG.minStructuralProposalConfidence,
  );
  if (confidence < minConfidence) return { ok: false, reason: 'low-merge-confidence' };
  const reason = cleanString(item?.reason, 400);
  if (!reason) return { ok: false, reason: 'missing-merge-reason' };
  return {
    ok: true,
    proposal: {
      category_ids: [...new Set(categoryIds)],
      proposed_name: cleanString(item?.proposed_name || item?.proposedName, 160) || null,
      confidence,
      reason,
    },
  };
}

function normalizeSplitProposal(item, categoriesById, config = DEFAULT_TAXONOMY_REFRESH_CONFIG) {
  const categoryId = cleanString(item?.category_id || item?.categoryId, 120);
  if (!categoryId) return { ok: false, reason: 'missing-split-category' };
  if (!categoriesById.has(categoryId)) return { ok: false, reason: 'unknown-split-category' };
  const proposedNames = Array.isArray(item?.proposed_names || item?.proposedNames)
    ? (item.proposed_names || item.proposedNames).map((name) => cleanString(name, 160)).filter(Boolean)
    : [];
  if (proposedNames.length < 2) return { ok: false, reason: 'invalid-split-names' };
  const confidence = confidenceValue(item?.confidence);
  if (confidence == null) return { ok: false, reason: 'invalid-split-confidence' };
  const minConfidence = confidenceValue(
    config.minStructuralProposalConfidence,
    DEFAULT_TAXONOMY_REFRESH_CONFIG.minStructuralProposalConfidence,
  );
  if (confidence < minConfidence) return { ok: false, reason: 'low-split-confidence' };
  const reason = cleanString(item?.reason, 400);
  if (!reason) return { ok: false, reason: 'missing-split-reason' };
  return {
    ok: true,
    proposal: {
      category_id: categoryId,
      proposed_names: proposedNames.slice(0, 8),
      confidence,
      reason,
    },
  };
}

function validateTaxonomyRefreshOutput(parsed, { categories = [], config = DEFAULT_TAXONOMY_REFRESH_CONFIG } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-object' };
  }
  for (const key of ['renames', 'aliases', 'merges', 'splits']) {
    if (!Array.isArray(parsed[key])) return { ok: false, reason: `missing-${key}` };
  }

  const categoriesById = categoryIndex(categories);
  const renames = [];
  for (const item of parsed.renames) {
    const categoryId = cleanString(item?.category_id || item?.categoryId, 120);
    if (!categoryId) return { ok: false, reason: 'missing-rename-category' };
    if (!categoriesById.has(categoryId)) return { ok: false, reason: 'unknown-rename-category' };
    const newName = cleanString(item?.new_name || item?.newName, 160);
    if (!newName) return { ok: false, reason: 'missing-rename-name' };
    const confidence = confidenceValue(item?.confidence);
    if (confidence == null) return { ok: false, reason: 'invalid-rename-confidence' };
    const reason = cleanString(item?.reason, 400);
    if (!reason) return { ok: false, reason: 'missing-rename-reason' };
    renames.push({
      categoryId,
      newName,
      oldNameAlias: cleanString(item?.old_name_alias || item?.oldNameAlias, 160) || null,
      confidence,
      reason,
    });
  }

  const aliases = [];
  for (const item of parsed.aliases) {
    const categoryId = cleanString(item?.category_id || item?.categoryId, 120);
    if (!categoryId) return { ok: false, reason: 'missing-alias-category' };
    if (!categoriesById.has(categoryId)) return { ok: false, reason: 'unknown-alias-category' };
    const alias = cleanString(item?.alias, 160);
    if (!alias) return { ok: false, reason: 'missing-alias' };
    const confidence = confidenceValue(item?.confidence, 1);
    if (confidence == null) return { ok: false, reason: 'invalid-alias-confidence' };
    aliases.push({
      categoryId,
      alias,
      confidence,
      reason: cleanString(item?.reason, 400) || null,
      source: cleanString(item?.source, 40) || 'model_synonym',
    });
  }

  const merges = [];
  for (const item of parsed.merges) {
    const normalized = normalizeMergeProposal(item, categoriesById, config);
    if (!normalized.ok) return normalized;
    merges.push(normalized.proposal);
  }

  const splits = [];
  for (const item of parsed.splits) {
    const normalized = normalizeSplitProposal(item, categoriesById, config);
    if (!normalized.ok) return normalized;
    splits.push(normalized.proposal);
  }

  return { ok: true, renames, aliases, merges, splits };
}

function buildTaxonomyRefreshInput({ categories = [], maxCategories = DEFAULT_TAXONOMY_REFRESH_CONFIG.maxCategories } = {}) {
  return {
    categories: (Array.isArray(categories) ? categories : [])
      .filter((category) => category?.status === 'visible' || category?.status === 'candidate')
      .slice(0, Math.max(1, Number(maxCategories) || DEFAULT_TAXONOMY_REFRESH_CONFIG.maxCategories))
      .map((category) => ({
        id: cleanString(category.id, 120),
        name: cleanString(category.name, 160),
        description: cleanString(category.description, 400),
        status: category.status,
        frozen_name: !!category.frozen_name,
        last_changed_at: Number(category.last_changed_at) || null,
        member_count: Math.max(0, Number(category.member_count) || 0),
        aliases: Array.isArray(category.aliases)
          ? category.aliases.map((alias) => cleanString(alias, 160)).filter(Boolean).slice(0, 16)
          : [],
      }))
      .filter((category) => category.id && category.name),
  };
}

function runMetadata(value) {
  const metadata = {
    skipped_renames: value.skippedRenames || [],
    deferred_merges: value.deferredMerges || [],
    deferred_splits: value.deferredSplits || [],
  };
  if (
    metadata.skipped_renames.length === 0
    && metadata.deferred_merges.length === 0
    && metadata.deferred_splits.length === 0
  ) return null;
  return metadata;
}

async function runSmartCategoryTaxonomyRefresh({
  categories = [],
  provider,
  providerName = null,
  storage = {},
  now = Date.now,
  runType = 'taxonomy_refresh',
  config = DEFAULT_TAXONOMY_REFRESH_CONFIG,
} = {}) {
  const startedAt = now();
  const input = buildTaxonomyRefreshInput({
    categories,
    maxCategories: config.maxCategories,
  });
  const byId = categoryIndex(input.categories);
  const nameSet = new Set(input.categories.map((category) => canonicalName(category.name)).filter(Boolean));

  const finish = (summary) => {
    const record = {
      runType,
      startedAt,
      finishedAt: now(),
      inputSaveCount: input.categories.reduce((sum, category) => sum + (Number(category.member_count) || 0), 0),
      createdCount: 0,
      renamedCount: summary.renamedCount || 0,
      mergedCount: 0,
      splitCount: 0,
      failedCount: summary.failedCount || 0,
      provider: providerName,
      error: summary.error || null,
      metadata: runMetadata(summary),
    };
    if (typeof storage.recordSmartCategoryRun === 'function') storage.recordSmartCategoryRun(record);
    return { ...summary, run: record };
  };

  if (input.categories.length === 0) {
    return finish({
      ok: true,
      reason: 'no-categories',
      renamedCount: 0,
      aliasCount: 0,
      skippedRenames: [],
      deferredMerges: [],
      deferredSplits: [],
      failedCount: 0,
      error: null,
    });
  }

  if (!provider?.generateSmartCategoryTaxonomyRefresh) {
    return finish({
      ok: false,
      reason: 'unsupported-provider',
      failedCount: 1,
      error: 'unsupported-provider',
      skippedRenames: [],
      deferredMerges: [],
      deferredSplits: [],
    });
  }

  let parsed;
  try {
    parsed = await provider.generateSmartCategoryTaxonomyRefresh(input);
  } catch (err) {
    return finish({
      ok: false,
      reason: err?.code || 'provider-error',
      failedCount: 1,
      error: err?.message || String(err),
      skippedRenames: [],
      deferredMerges: [],
      deferredSplits: [],
    });
  }

  const validation = validateTaxonomyRefreshOutput(parsed, { categories: input.categories, config });
  if (!validation.ok) {
    return finish({
      ok: false,
      reason: validation.reason,
      failedCount: 1,
      error: validation.reason,
      skippedRenames: [],
      deferredMerges: [],
      deferredSplits: [],
    });
  }

  const at = now();
  const skippedRenames = [];
  const acceptedRenames = [];
  const acceptedAliases = [];
  let renamedCount = 0;
  let aliasCount = 0;
  const renameCooldownMs = Math.max(0, Number(config.renameCooldownMs) || 0);
  const minRenameConfidence = confidenceValue(config.minRenameConfidence, DEFAULT_TAXONOMY_REFRESH_CONFIG.minRenameConfidence);
  const minAliasConfidence = confidenceValue(config.minAliasConfidence, DEFAULT_TAXONOMY_REFRESH_CONFIG.minAliasConfidence);

  for (const rename of validation.renames) {
    const category = byId.get(rename.categoryId);
    const skip = (reason) => {
      skippedRenames.push({ categoryId: rename.categoryId, reason, proposedName: rename.newName });
    };

    if (!category) {
      skip('not-found');
    } else if (category.frozen_name) {
      skip('name-frozen');
    } else if (rename.confidence < minRenameConfidence) {
      skip('low-confidence');
    } else if (isCosmeticRename(category.name, rename.newName)) {
      skip('cosmetic-rename');
    } else if (
      category.last_changed_at
      && at - Number(category.last_changed_at) < renameCooldownMs
    ) {
      skip('rename-cooldown');
    } else {
      const oldCanonical = canonicalName(category.name);
      const nextCanonical = canonicalName(rename.newName);
      if (nameSet.has(nextCanonical) && nextCanonical !== oldCanonical) {
        skip('duplicate-name');
      } else {
        acceptedRenames.push({
          id: rename.categoryId,
          name: rename.newName,
          automatic: true,
          changedAt: at,
        });
        nameSet.delete(oldCanonical);
        nameSet.add(nextCanonical);
      }
    }
  }

  for (const alias of validation.aliases) {
    const category = byId.get(alias.categoryId);
    if (!category || alias.confidence < minAliasConfidence) continue;
    const aliasCanonical = canonicalName(alias.alias);
    const existingAliases = Array.isArray(category.aliases) ? category.aliases : [];
    if (!aliasCanonical || aliasCanonical === canonicalName(category.name)) continue;
    if (existingAliases.some((existing) => canonicalName(existing) === aliasCanonical)) continue;
    acceptedAliases.push({
      categoryId: alias.categoryId,
      alias: alias.alias,
      source: alias.source || 'model_synonym',
      createdAt: at,
    });
  }

  if (acceptedRenames.length > 0 || acceptedAliases.length > 0) {
    if (typeof storage.applySmartCategoryTaxonomyChanges !== 'function') {
      return finish({
        ok: false,
        reason: 'missing-taxonomy-storage',
        renamedCount: 0,
        aliasCount: 0,
        skippedRenames,
        deferredMerges: validation.merges,
        deferredSplits: validation.splits,
        failedCount: 1,
        error: 'missing-taxonomy-storage',
      });
    }
    try {
      const result = storage.applySmartCategoryTaxonomyChanges({
        renames: acceptedRenames,
        aliases: acceptedAliases,
        changedAt: at,
      });
      if (!result?.ok) {
        return finish({
          ok: false,
          reason: result?.reason || 'taxonomy-apply-failed',
          renamedCount: 0,
          aliasCount: 0,
          skippedRenames,
          deferredMerges: validation.merges,
          deferredSplits: validation.splits,
          failedCount: 1,
          error: result?.reason || 'taxonomy-apply-failed',
        });
      }
      renamedCount = Number(result.renamedCount) || 0;
      aliasCount = Number(result.aliasCount) || 0;
    } catch (err) {
      return finish({
        ok: false,
        reason: 'taxonomy-apply-failed',
        renamedCount: 0,
        aliasCount: 0,
        skippedRenames,
        deferredMerges: validation.merges,
        deferredSplits: validation.splits,
        failedCount: 1,
        error: err?.message || String(err),
      });
    }
  }

  return finish({
    ok: true,
    renamedCount,
    aliasCount,
    skippedRenames,
    deferredMerges: validation.merges,
    deferredSplits: validation.splits,
    failedCount: 0,
    error: null,
  });
}

module.exports = {
  DEFAULT_TAXONOMY_REFRESH_CONFIG,
  isCosmeticRename,
  buildTaxonomyRefreshInput,
  validateTaxonomyRefreshOutput,
  runSmartCategoryTaxonomyRefresh,
};
