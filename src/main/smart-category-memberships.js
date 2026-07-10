const crypto = require('node:crypto');

const PRIMARY_MEMBERSHIP_THRESHOLD = 0.75;
const SECONDARY_MEMBERSHIP_THRESHOLD = 0.45;

const {
  normalizeVector,
  cosineSimilarity,
  meanEmbedding,
} = require('./smart-category-vectors');

function cleanString(value, max = 1000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function normalizeConcepts(concepts) {
  return Array.isArray(concepts)
    ? concepts.map((concept) => cleanString(concept, 80)).filter(Boolean).slice(0, 8)
    : [];
}

function normalizeCategory(category) {
  return {
    id: cleanString(category?.id, 120),
    name: cleanString(category?.name, 160),
    description: cleanString(category?.description, 400),
    aliases: Array.isArray(category?.aliases)
      ? category.aliases.map((alias) => cleanString(alias, 120)).filter(Boolean).slice(0, 12)
      : [],
  };
}

function buildMembershipScoringInput(profile, candidateCategories = []) {
  return {
    save: {
      summary: cleanString(profile?.summary, 600),
      concepts: normalizeConcepts(profile?.concepts),
      content_type: cleanString(profile?.content_type || profile?.contentType, 80),
      intent: cleanString(profile?.intent_guess || profile?.intent, 80),
    },
    candidate_categories: candidateCategories
      .map(normalizeCategory)
      .filter((category) => category.id && category.name)
      .slice(0, 40),
  };
}

function membershipStrength(weight) {
  return weight >= PRIMARY_MEMBERSHIP_THRESHOLD ? 'primary' : 'secondary';
}

function clampWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function roundWeight(value) {
  return Math.round(clampWeight(value) * 1000) / 1000;
}

function semanticIdentity(row, activeGenerationId) {
  const generationId = cleanString(row?.generation_id, 160);
  const model = cleanString(row?.model, 160);
  const dimension = Number(row?.dimension);
  if (
    !activeGenerationId
    || generationId !== activeGenerationId
    || !model
    || !Number.isInteger(dimension)
    || dimension < 1
  ) {
    return null;
  }
  const vector = normalizeVector(row?.vector);
  if (!vector || vector.length !== dimension) return null;
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) return null;
  }
  return { generationId, model, dimension, vector };
}

function matchesSemanticIdentity(row, identity) {
  return row?.generation_id === identity?.generationId
    && row?.model === identity?.model
    && row?.dimension === identity?.dimension;
}

function computeSemanticCategoryCentroid({ categoryId, identity, members = [] } = {}) {
  if (!categoryId || !identity?.generationId || !identity?.model || !identity?.dimension) {
    return { ok: false, reason: 'missing-semantic-identity' };
  }

  const bySave = new Map();
  for (const row of members) {
    const saveId = cleanString(row?.save_id, 160);
    const sourceHash = cleanString(row?.source_hash, 160);
    if (!saveId || !sourceHash || !matchesSemanticIdentity(row, identity)) continue;
    const vector = normalizeVector(row.vector);
    if (!vector || vector.length !== identity.dimension) continue;
    let valid = true;
    for (let i = 0; i < vector.length; i += 1) {
      if (!Number.isFinite(vector[i])) { valid = false; break; }
    }
    if (!valid) continue;
    bySave.set(saveId, {
      saveId,
      sourceHash,
      weight: roundWeight(row.weight),
      vector,
    });
  }

  const accepted = [...bySave.values()].sort((a, b) => a.saveId.localeCompare(b.saveId));
  const centroid = meanEmbedding(accepted.map((row) => row.vector));
  if (!centroid || centroid.length !== identity.dimension) {
    return { ok: false, reason: 'no-active-member-vectors' };
  }
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({
    categoryId,
    generationId: identity.generationId,
    model: identity.model,
    dimension: identity.dimension,
    members: accepted.map((row) => ({
      saveId: row.saveId,
      weight: row.weight,
      sourceHash: row.sourceHash,
    })),
  })).digest('hex');

  return {
    ok: true,
    vector: centroid,
    memberCount: accepted.length,
    identity: {
      generationId: identity.generationId,
      model: identity.model,
      dimension: identity.dimension,
      sourceHash,
    },
  };
}

function validateSmartCategoryMemberships(parsed, { candidateCategories = [] } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-object' };
  }
  if (!Array.isArray(parsed.memberships)) {
    return { ok: false, reason: 'missing-memberships' };
  }

  const candidateIds = new Set(
    candidateCategories.map((category) => cleanString(category?.id, 120)).filter(Boolean),
  );
  const byCategory = new Map();

  for (const item of parsed.memberships) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'invalid-membership' };
    }
    const categoryId = cleanString(item.category_id || item.categoryId, 120);
    if (!categoryId) return { ok: false, reason: 'missing-category-id' };
    if (!candidateIds.has(categoryId)) return { ok: false, reason: 'unknown-category' };

    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      return { ok: false, reason: 'invalid-weight' };
    }
    if (weight < SECONDARY_MEMBERSHIP_THRESHOLD) continue;

    const evidence = cleanString(item.evidence, 220);
    const membership = {
      categoryId,
      weight,
      evidence,
      strength: membershipStrength(weight),
    };
    const existing = byCategory.get(categoryId);
    if (!existing || membership.weight > existing.weight) byCategory.set(categoryId, membership);
  }

  const memberships = [...byCategory.values()]
    .sort((a, b) => b.weight - a.weight || a.categoryId.localeCompare(b.categoryId));

  const hint = cleanString(parsed.new_category_hint, 120);
  return {
    ok: true,
    memberships,
    needsNewCategory: parsed.needs_new_category === true,
    newCategoryHint: hint || null,
  };
}

async function assignSmartCategoryMembershipsWithSemanticIndex({
  saveId,
  candidateCategories = [],
  upsertSmartCategoryMembership,
  getSemanticIndexState,
  getSemanticVector,
  getActiveSemanticVectors,
  getSmartCategoryMembers,
  now = Date.now,
} = {}) {
  if (
    typeof getSemanticIndexState !== 'function'
    || typeof getSemanticVector !== 'function'
    || typeof getActiveSemanticVectors !== 'function'
    || typeof getSmartCategoryMembers !== 'function'
  ) {
    return { ok: false, reason: 'semantic-index-unavailable' };
  }

  const input = buildMembershipScoringInput({}, candidateCategories);
  if (input.candidate_categories.length === 0) {
    return { ok: true, provider: 'ollama-semantic-index', assignedCount: 0, memberships: [] };
  }

  const activeGenerationId = cleanString(getSemanticIndexState()?.active_generation_id, 160);
  const target = semanticIdentity(getSemanticVector(saveId), activeGenerationId);
  if (!target) return { ok: false, reason: 'active-semantic-vector-unavailable' };
  const identity = {
    generationId: target.generationId,
    model: target.model,
    dimension: target.dimension,
  };
  const activeBySave = new Map(
    getActiveSemanticVectors()
      .filter((row) => matchesSemanticIdentity(row, identity))
      .map((row) => [row.save_id, row]),
  );
  const candidateById = new Map(input.candidate_categories.map((category) => [category.id, category]));
  const scorableCategories = [];
  for (const category of candidateCategories) {
    const normalized = candidateById.get(cleanString(category?.id, 120));
    if (!normalized) continue;
    const members = getSmartCategoryMembers(category.id, {
      minWeight: SECONDARY_MEMBERSHIP_THRESHOLD,
    }).filter((member) => member.save_id !== saveId).map((member) => ({
      ...activeBySave.get(member.save_id),
      weight: member.weight,
    }));
    const centroid = computeSemanticCategoryCentroid({
      categoryId: category.id,
      identity,
      members,
    });
    if (!centroid.ok) continue;
    scorableCategories.push({ normalized, centroid });
  }

  if (scorableCategories.length === 0) return { ok: false, reason: 'no-active-semantic-centroids' };

  const scored = [];
  for (const { normalized, centroid } of scorableCategories) {
    const score = cosineSimilarity(target.vector, centroid.vector);
    if (score == null) continue;
    const weight = roundWeight(score);
    if (weight < SECONDARY_MEMBERSHIP_THRESHOLD) continue;
    scored.push({
      category_id: normalized.id,
      weight,
      evidence: `Ollama semantic cosine similarity ${weight.toFixed(3)} to active-generation category centroid.`,
      centroidIdentity: centroid.identity,
    });
  }

  if (scored.length === 0) return { ok: false, reason: 'no-active-semantic-centroid-matches' };

  const validation = validateSmartCategoryMemberships({ memberships: scored }, {
    candidateCategories: input.candidate_categories,
  });
  if (!validation.ok) return validation;

  const assignedAt = now();
  for (const membership of validation.memberships) {
    const scoredMembership = scored.find((item) => item.category_id === membership.categoryId);
    upsertSmartCategoryMembership({
      categoryId: membership.categoryId,
      saveId,
      weight: membership.weight,
      evidence: {
        source: 'ollama-semantic-membership',
        strength: membership.strength,
        similarity: membership.weight,
        reason: membership.evidence,
        generationId: identity.generationId,
        model: identity.model,
        dimension: identity.dimension,
        centroidSourceHash: scoredMembership?.centroidIdentity?.sourceHash || null,
      },
      assignedAt,
      updatedAt: assignedAt,
    });
  }

  return {
    ok: true,
    provider: 'ollama-semantic-index',
    assignedCount: validation.memberships.length,
    memberships: validation.memberships,
    needsNewCategory: false,
    newCategoryHint: null,
  };
}

async function assignSmartCategoryMemberships({
  saveId,
  profile,
  candidateCategories = [],
  provider,
  upsertSmartCategoryMembership,
  getSemanticIndexState,
  getSemanticVector,
  getActiveSemanticVectors,
  getSmartCategoryMembers,
  now = Date.now,
} = {}) {
  if (!saveId) return { ok: false, reason: 'missing-save' };
  if (!profile) return { ok: false, reason: 'missing-profile' };
  if (typeof upsertSmartCategoryMembership !== 'function') {
    return { ok: false, reason: 'missing-storage' };
  }

  const input = buildMembershipScoringInput(profile, candidateCategories);
  if (input.candidate_categories.length === 0) {
    return { ok: true, assignedCount: 0, needsNewCategory: false, newCategoryHint: null };
  }

  const semanticResult = await assignSmartCategoryMembershipsWithSemanticIndex({
    saveId,
    candidateCategories,
    upsertSmartCategoryMembership,
    getSemanticIndexState,
    getSemanticVector,
    getActiveSemanticVectors,
    getSmartCategoryMembers,
    now,
  });
  if (semanticResult?.ok) return semanticResult;

  if (!provider?.generateSmartCategoryMemberships) {
    return {
      ok: true,
      provider: 'ollama-semantic-index',
      assignedCount: 0,
      memberships: [],
      deferred: true,
      reason: semanticResult?.reason || 'semantic-index-pending',
    };
  }

  let parsed;
  try {
    parsed = await provider.generateSmartCategoryMemberships(input);
  } catch (err) {
    return { ok: false, reason: err?.code || 'provider-error', detail: err?.message || String(err) };
  }

  const validation = validateSmartCategoryMemberships(parsed, {
    candidateCategories: input.candidate_categories,
  });
  if (!validation.ok) return validation;

  const assignedAt = now();
  for (const membership of validation.memberships) {
    upsertSmartCategoryMembership({
      categoryId: membership.categoryId,
      saveId,
      weight: membership.weight,
      evidence: {
        source: 'codex-membership',
        strength: membership.strength,
        reason: membership.evidence,
      },
      assignedAt,
      updatedAt: assignedAt,
    });
  }
  return {
    ok: true,
    provider: 'codex-membership',
    assignedCount: validation.memberships.length,
    memberships: validation.memberships,
    needsNewCategory: validation.needsNewCategory,
    newCategoryHint: validation.newCategoryHint,
  };
}

async function assignSaveToExistingSmartCategories({
  saveId,
  profile,
  provider,
  listSmartCategories,
  getSmartCategoryAliases,
  upsertSmartCategoryMembership,
  getSemanticIndexState,
  getSemanticVector,
  getActiveSemanticVectors,
  getSmartCategoryMembers,
  now = Date.now,
} = {}) {
  if (typeof listSmartCategories !== 'function') {
    return { ok: false, reason: 'missing-category-storage' };
  }
  const categories = listSmartCategories()
    .filter((category) => category.status === 'visible' || category.status === 'candidate')
    .map((category) => ({
      ...category,
      aliases: typeof getSmartCategoryAliases === 'function'
        ? getSmartCategoryAliases(category.id).map((alias) => alias.alias)
        : [],
    }));

  return assignSmartCategoryMemberships({
    saveId,
    profile,
    candidateCategories: categories,
    provider,
    upsertSmartCategoryMembership,
    getSemanticIndexState,
    getSemanticVector,
    getActiveSemanticVectors,
    getSmartCategoryMembers,
    now,
  });
}

module.exports = {
  PRIMARY_MEMBERSHIP_THRESHOLD,
  SECONDARY_MEMBERSHIP_THRESHOLD,
  buildMembershipScoringInput,
  computeSemanticCategoryCentroid,
  assignSmartCategoryMembershipsWithSemanticIndex,
  validateSmartCategoryMemberships,
  assignSmartCategoryMemberships,
  assignSaveToExistingSmartCategories,
};
