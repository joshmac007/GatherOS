'use strict';

const crypto = require('node:crypto');
const { normalizeVector, cosineSimilarity, meanEmbedding } = require('./smart-category-vectors');

const PRIMARY_MEMBERSHIP_THRESHOLD = 0.75;
const SECONDARY_MEMBERSHIP_THRESHOLD = 0.45;

function clean(value, max = 1000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function buildMembershipScoringInput(profile, candidateCategories = []) {
  return {
    save: {
      summary: clean(profile?.summary, 600),
      concepts: Array.isArray(profile?.concepts)
        ? profile.concepts.map((value) => clean(value, 80)).filter(Boolean).slice(0, 8)
        : [],
      content_type: clean(profile?.content_type || profile?.contentType, 80),
      intent: clean(profile?.intent_guess || profile?.intentGuess || profile?.intent, 80),
    },
    candidate_categories: (Array.isArray(candidateCategories) ? candidateCategories : []).map((category) => ({
      id: clean(category?.id, 120),
      name: clean(category?.name, 160),
      description: clean(category?.description, 400),
      aliases: Array.isArray(category?.aliases)
        ? category.aliases.map((alias) => clean(alias, 120)).filter(Boolean).slice(0, 12)
        : [],
    })).filter((category) => category.id && category.name).slice(0, 40),
  };
}

function membershipStrength(weight) {
  return weight >= PRIMARY_MEMBERSHIP_THRESHOLD ? 'primary' : 'secondary';
}

function roundWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(1, number)) * 1000) / 1000;
}

function semanticIdentity(row, activeGenerationId) {
  const generationId = clean(row?.generation_id, 160);
  const model = clean(row?.model, 160);
  const dimension = Number(row?.dimension);
  if (!activeGenerationId || generationId !== activeGenerationId || !model || !Number.isInteger(dimension) || dimension < 1) return null;
  const vector = normalizeVector(row?.vector);
  if (!vector || vector.length !== dimension) return null;
  return { generationId, model, dimension, vector };
}

function matchesIdentity(row, identity) {
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
    const saveId = clean(row?.save_id, 160);
    const sourceHash = clean(row?.source_hash, 160);
    if (!saveId || !sourceHash || !matchesIdentity(row, identity)) continue;
    const vector = normalizeVector(row.vector);
    if (!vector || vector.length !== identity.dimension) continue;
    bySave.set(saveId, { saveId, sourceHash, weight: roundWeight(row.weight), vector });
  }
  const accepted = [...bySave.values()].sort((a, b) => a.saveId.localeCompare(b.saveId));
  const vector = meanEmbedding(accepted.map((row) => row.vector));
  if (!vector) return { ok: false, reason: 'no-active-member-vectors' };
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({
    categoryId,
    generationId: identity.generationId,
    model: identity.model,
    dimension: identity.dimension,
    members: accepted.map((row) => ({ saveId: row.saveId, weight: row.weight, sourceHash: row.sourceHash })),
  })).digest('hex');
  return {
    ok: true,
    vector,
    memberCount: accepted.length,
    identity: { ...identity, vector: undefined, sourceHash },
  };
}

function validateSmartCategoryMemberships(parsed, { candidateCategories = [] } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not-object' };
  if (!Array.isArray(parsed.memberships)) return { ok: false, reason: 'missing-memberships' };
  const candidateIds = new Set(candidateCategories.map((category) => clean(category?.id, 120)).filter(Boolean));
  const byCategory = new Map();
  for (const item of parsed.memberships) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'invalid-membership' };
    const categoryId = clean(item.category_id || item.categoryId, 120);
    if (!categoryId) return { ok: false, reason: 'missing-category-id' };
    if (!candidateIds.has(categoryId)) return { ok: false, reason: 'unknown-category' };
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) return { ok: false, reason: 'invalid-weight' };
    if (weight < SECONDARY_MEMBERSHIP_THRESHOLD) continue;
    const membership = {
      categoryId,
      weight,
      evidence: clean(item.evidence, 220),
      strength: membershipStrength(weight),
    };
    const existing = byCategory.get(categoryId);
    if (!existing || membership.weight > existing.weight) byCategory.set(categoryId, membership);
  }
  return {
    ok: true,
    memberships: [...byCategory.values()].sort((a, b) => b.weight - a.weight || a.categoryId.localeCompare(b.categoryId)),
    needsNewCategory: parsed.needs_new_category === true,
    newCategoryHint: clean(parsed.new_category_hint, 120) || null,
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
  if ([getSemanticIndexState, getSemanticVector, getActiveSemanticVectors, getSmartCategoryMembers].some((fn) => typeof fn !== 'function')) {
    return { ok: false, reason: 'semantic-index-unavailable' };
  }
  const input = buildMembershipScoringInput({}, candidateCategories);
  if (input.candidate_categories.length === 0) return { ok: true, source: 'semantic-index', assignedCount: 0, memberships: [] };
  const activeGenerationId = clean(getSemanticIndexState()?.active_generation_id, 160);
  const target = semanticIdentity(getSemanticVector(saveId), activeGenerationId);
  if (!target) return { ok: false, reason: 'active-semantic-vector-unavailable' };
  const identity = { generationId: target.generationId, model: target.model, dimension: target.dimension };
  const activeBySave = new Map(getActiveSemanticVectors()
    .filter((row) => matchesIdentity(row, identity)).map((row) => [row.save_id, row]));
  const scored = [];
  for (const category of input.candidate_categories) {
    const members = getSmartCategoryMembers(category.id, { minWeight: SECONDARY_MEMBERSHIP_THRESHOLD })
      .filter((member) => member.save_id !== saveId)
      .map((member) => ({ ...activeBySave.get(member.save_id), weight: member.weight }));
    const centroid = computeSemanticCategoryCentroid({ categoryId: category.id, identity, members });
    if (!centroid.ok) continue;
    const weight = roundWeight(cosineSimilarity(target.vector, centroid.vector));
    if (weight < SECONDARY_MEMBERSHIP_THRESHOLD) continue;
    scored.push({
      category_id: category.id,
      weight,
      evidence: `Cosine similarity ${weight.toFixed(3)} to active-generation category centroid.`,
      centroidIdentity: centroid.identity,
    });
  }
  if (scored.length === 0) {
    return { ok: scored.length === 0, source: 'semantic-index', assignedCount: 0, memberships: [], needsNewCategory: true, newCategoryHint: null };
  }
  const validation = validateSmartCategoryMemberships({ memberships: scored }, { candidateCategories: input.candidate_categories });
  if (!validation.ok) return validation;
  const timestamp = now();
  for (const membership of validation.memberships) {
    const centroid = scored.find((item) => item.category_id === membership.categoryId)?.centroidIdentity;
    upsertSmartCategoryMembership({
      categoryId: membership.categoryId,
      saveId,
      weight: membership.weight,
      evidence: {
        source: 'semantic-index',
        strength: membership.strength,
        similarity: membership.weight,
        reason: membership.evidence,
        generationId: identity.generationId,
        model: identity.model,
        dimension: identity.dimension,
        centroidSourceHash: centroid?.sourceHash || null,
      },
      assignedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return { ok: true, source: 'semantic-index', assignedCount: validation.memberships.length, memberships: validation.memberships, needsNewCategory: false, newCategoryHint: null };
}

async function assignSmartCategoryMemberships({
  saveId,
  profile,
  candidateCategories = [],
  structuredProvider,
  upsertSmartCategoryMembership,
  getSemanticIndexState,
  getSemanticVector,
  getActiveSemanticVectors,
  getSmartCategoryMembers,
  now = Date.now,
  signal,
} = {}) {
  if (!saveId) return { ok: false, reason: 'missing-save' };
  if (!profile) return { ok: false, reason: 'missing-profile' };
  if (typeof upsertSmartCategoryMembership !== 'function') return { ok: false, reason: 'missing-storage' };
  const input = buildMembershipScoringInput(profile, candidateCategories);
  if (input.candidate_categories.length === 0) {
    return { ok: true, assignedCount: 0, memberships: [], needsDiscovery: true, needsNewCategory: true, newCategoryHint: null };
  }
  const semantic = await assignSmartCategoryMembershipsWithSemanticIndex({
    saveId, candidateCategories, upsertSmartCategoryMembership, getSemanticIndexState,
    getSemanticVector, getActiveSemanticVectors, getSmartCategoryMembers, now,
  });
  if (semantic.ok) return semantic;
  if (typeof structuredProvider?.completeJson !== 'function') {
    return { ok: true, source: 'semantic-index', assignedCount: 0, memberships: [], deferred: true, reason: semantic.reason };
  }
  let parsed;
  try {
    parsed = await structuredProvider.completeJson({
      system:
        'Score one saved-item topic profile against candidate categories. Return JSON only: ' +
        '{"memberships":[{"category_id":"...","weight":0.0,"evidence":"..."}],' +
        '"needs_new_category":false,"new_category_hint":null}. Use only supplied category IDs.',
      input: JSON.stringify(input),
      maxOutputTokens: 700,
      signal,
    });
  } catch (error) {
    return { ok: false, reason: error?.code || 'provider-error', detail: error?.message || String(error) };
  }
  const validation = validateSmartCategoryMemberships(parsed, { candidateCategories: input.candidate_categories });
  if (!validation.ok) return validation;
  const timestamp = now();
  for (const membership of validation.memberships) {
    upsertSmartCategoryMembership({
      categoryId: membership.categoryId,
      saveId,
      weight: membership.weight,
      evidence: { source: 'structured-provider', strength: membership.strength, reason: membership.evidence },
      assignedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return { ok: true, source: 'structured-provider', assignedCount: validation.memberships.length, ...validation };
}

async function assignSaveToExistingSmartCategories({
  saveId,
  profile,
  structuredProvider,
  listSmartCategories,
  getSmartCategoryAliases,
  ...options
} = {}) {
  if (typeof listSmartCategories !== 'function') return { ok: false, reason: 'missing-category-storage' };
  const categories = listSmartCategories()
    .filter((category) => category.status === 'visible' || category.status === 'candidate')
    .map((category) => ({
      ...category,
      aliases: typeof getSmartCategoryAliases === 'function'
        ? getSmartCategoryAliases(category.id).map((alias) => alias.alias)
        : [],
    }));
  return assignSmartCategoryMemberships({ saveId, profile, candidateCategories: categories, structuredProvider, ...options });
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
