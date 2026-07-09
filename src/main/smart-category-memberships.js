const PRIMARY_MEMBERSHIP_THRESHOLD = 0.75;
const SECONDARY_MEMBERSHIP_THRESHOLD = 0.45;

const {
  vectorToBuffer,
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

function buildTopicEmbeddingText(profile) {
  const summary = cleanString(profile?.summary, 800);
  const concepts = normalizeConcepts(profile?.concepts).join(', ');
  const contentType = cleanString(profile?.content_type || profile?.contentType, 80);
  const intent = cleanString(profile?.intent_guess || profile?.intent, 80);
  return [
    summary && `Summary: ${summary}`,
    concepts && `Concepts: ${concepts}`,
    contentType && `Content type: ${contentType}`,
    intent && `Intent: ${intent}`,
  ].filter(Boolean).join('\n');
}

function profileToUpsertPayload({ saveId, profile, embedding, updatedAt }) {
  return {
    saveId,
    concepts: normalizeConcepts(profile?.concepts),
    contentType: cleanString(profile?.content_type || profile?.contentType, 80) || null,
    intentGuess: cleanString(profile?.intent_guess || profile?.intent, 80) || null,
    summary: cleanString(profile?.summary, 800) || null,
    embedding,
    confidence: Number.isFinite(Number(profile?.confidence)) ? Number(profile.confidence) : 0,
    updatedAt,
  };
}

async function ensureProfileEmbedding({
  saveId,
  profile,
  provider,
  upsertSaveTopicProfile,
  now,
} = {}) {
  const existing = normalizeVector(profile?.embedding);
  if (existing) return { ok: true, vector: existing, persisted: false };
  if (typeof provider?.embedText !== 'function') {
    return { ok: false, reason: 'local-embeddings-unavailable' };
  }

  const text = buildTopicEmbeddingText(profile);
  if (!text) return { ok: false, reason: 'empty-embedding-input' };

  let vector;
  try {
    vector = normalizeVector(await provider.embedText(text));
  } catch (err) {
    return { ok: false, reason: err?.code || 'local-embedding-error', detail: err?.message || String(err) };
  }
  if (!vector) return { ok: false, reason: 'invalid-local-embedding' };

  const buffer = vectorToBuffer(vector);
  if (typeof upsertSaveTopicProfile === 'function') {
    const at = typeof now === 'function' ? now() : Date.now();
    upsertSaveTopicProfile(profileToUpsertPayload({
      saveId,
      profile,
      embedding: buffer,
      updatedAt: at,
    }));
  }

  return { ok: true, vector, buffer, persisted: typeof upsertSaveTopicProfile === 'function' };
}

function computeCategoryCentroid(category, { getSmartCategoryMemberTopicEmbeddings, updateSmartCategoryCentroidEmbedding, now } = {}) {
  const existing = normalizeVector(category?.centroid_embedding);
  if (existing) return { ok: true, vector: existing, category };
  if (
    typeof getSmartCategoryMemberTopicEmbeddings !== 'function'
    || typeof updateSmartCategoryCentroidEmbedding !== 'function'
  ) {
    return { ok: false, reason: 'missing-centroid-storage' };
  }

  const rows = getSmartCategoryMemberTopicEmbeddings(category.id);
  const centroid = meanEmbedding(rows.map((row) => row.embedding));
  if (!centroid) return { ok: false, reason: 'missing-centroid' };

  const buffer = vectorToBuffer(centroid);
  updateSmartCategoryCentroidEmbedding({
    categoryId: category.id,
    centroidEmbedding: buffer,
    updatedAt: typeof now === 'function' ? now() : Date.now(),
  });
  return {
    ok: true,
    vector: centroid,
    category: { ...category, centroid_embedding: buffer },
  };
}

function updateCentroidAfterAssignment(categoryId, {
  getSmartCategoryMemberTopicEmbeddings,
  updateSmartCategoryCentroidEmbedding,
  now,
} = {}) {
  if (
    typeof getSmartCategoryMemberTopicEmbeddings !== 'function'
    || typeof updateSmartCategoryCentroidEmbedding !== 'function'
  ) {
    return { ok: false, reason: 'missing-centroid-storage' };
  }
  const rows = getSmartCategoryMemberTopicEmbeddings(categoryId);
  const centroid = meanEmbedding(rows.map((row) => row.embedding));
  if (!centroid) return { ok: false, reason: 'missing-centroid' };
  return updateSmartCategoryCentroidEmbedding({
    categoryId,
    centroidEmbedding: vectorToBuffer(centroid),
    updatedAt: typeof now === 'function' ? now() : Date.now(),
  });
}

async function bootstrapCentroidsFromCodexAssignments({
  saveId,
  profile,
  provider,
  memberships = [],
  upsertSaveTopicProfile,
  getSmartCategoryMemberTopicEmbeddings,
  updateSmartCategoryCentroidEmbedding,
  now,
} = {}) {
  if (!memberships.length || typeof provider?.embedText !== 'function') return;
  if (
    typeof getSmartCategoryMemberTopicEmbeddings !== 'function'
    || typeof updateSmartCategoryCentroidEmbedding !== 'function'
  ) {
    return;
  }
  const embedded = await ensureProfileEmbedding({
    saveId,
    profile,
    provider,
    upsertSaveTopicProfile,
    now,
  });
  if (!embedded.ok) return;
  for (const membership of memberships) {
    updateCentroidAfterAssignment(membership.categoryId, {
      getSmartCategoryMemberTopicEmbeddings,
      updateSmartCategoryCentroidEmbedding,
      now,
    });
  }
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

async function assignSmartCategoryMembershipsWithLocalEmbeddings({
  saveId,
  profile,
  candidateCategories = [],
  provider,
  upsertSaveTopicProfile,
  upsertSmartCategoryMembership,
  getSmartCategoryMemberTopicEmbeddings,
  updateSmartCategoryCentroidEmbedding,
  now = Date.now,
} = {}) {
  if (typeof provider?.embedText !== 'function') {
    return { ok: false, reason: 'local-embeddings-unavailable' };
  }

  const input = buildMembershipScoringInput(profile, candidateCategories);
  if (input.candidate_categories.length === 0) {
    return { ok: true, provider: 'local-embeddings', assignedCount: 0, memberships: [] };
  }

  const candidateById = new Map(input.candidate_categories.map((category) => [category.id, category]));
  const scorableCategories = [];
  for (const category of candidateCategories) {
    const normalized = candidateById.get(cleanString(category?.id, 120));
    if (!normalized) continue;
    const centroid = computeCategoryCentroid(category, {
      getSmartCategoryMemberTopicEmbeddings,
      updateSmartCategoryCentroidEmbedding,
      now,
    });
    if (!centroid.ok) continue;
    scorableCategories.push({ normalized, centroid });
  }

  if (scorableCategories.length === 0) return { ok: false, reason: 'no-local-centroids' };

  const profileEmbedding = await ensureProfileEmbedding({
    saveId,
    profile,
    provider,
    upsertSaveTopicProfile,
    now,
  });
  if (!profileEmbedding.ok) return profileEmbedding;

  const scored = [];
  for (const { normalized, centroid } of scorableCategories) {
    const score = cosineSimilarity(profileEmbedding.vector, centroid.vector);
    if (score == null) continue;
    const weight = roundWeight(score);
    if (weight < SECONDARY_MEMBERSHIP_THRESHOLD) continue;
    scored.push({
      category_id: normalized.id,
      weight,
      evidence: `Local embedding cosine similarity ${weight.toFixed(3)} to category centroid.`,
    });
  }

  if (scored.length === 0) return { ok: false, reason: 'no-local-centroid-matches' };

  const validation = validateSmartCategoryMemberships({ memberships: scored }, {
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
        source: 'local-embedding-membership',
        strength: membership.strength,
        similarity: membership.weight,
        reason: membership.evidence,
      },
      assignedAt,
      updatedAt: assignedAt,
    });
    updateCentroidAfterAssignment(membership.categoryId, {
      getSmartCategoryMemberTopicEmbeddings,
      updateSmartCategoryCentroidEmbedding,
      now,
    });
  }

  return {
    ok: true,
    provider: 'local-embeddings',
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
  upsertSaveTopicProfile,
  upsertSmartCategoryMembership,
  getSmartCategoryMemberTopicEmbeddings,
  updateSmartCategoryCentroidEmbedding,
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

  let localResult = null;
  if (typeof provider?.embedText === 'function') {
    localResult = await assignSmartCategoryMembershipsWithLocalEmbeddings({
      saveId,
      profile,
      candidateCategories,
      provider,
      upsertSaveTopicProfile,
      upsertSmartCategoryMembership,
      getSmartCategoryMemberTopicEmbeddings,
      updateSmartCategoryCentroidEmbedding,
      now,
    });
    if (localResult?.ok) return localResult;
  }

  if (!provider?.generateSmartCategoryMemberships) {
    if (localResult) {
      return {
        ok: true,
        provider: 'local-embeddings',
        assignedCount: 0,
        memberships: [],
        deferred: true,
        reason: localResult.reason || 'local-embedding-pending',
      };
    }
    return { ok: false, reason: 'unsupported-provider' };
  }
  const shouldBootstrapCodexCentroids = !localResult
    || localResult.reason === 'no-local-centroids'
    || localResult.reason === 'no-local-centroid-matches';

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
  if (shouldBootstrapCodexCentroids) {
    await bootstrapCentroidsFromCodexAssignments({
      saveId,
      profile,
      provider,
      memberships: validation.memberships,
      upsertSaveTopicProfile,
      getSmartCategoryMemberTopicEmbeddings,
      updateSmartCategoryCentroidEmbedding,
      now,
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
  upsertSaveTopicProfile,
  upsertSmartCategoryMembership,
  getSmartCategoryMemberTopicEmbeddings,
  updateSmartCategoryCentroidEmbedding,
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
    upsertSaveTopicProfile,
    upsertSmartCategoryMembership,
    getSmartCategoryMemberTopicEmbeddings,
    updateSmartCategoryCentroidEmbedding,
    now,
  });
}

module.exports = {
  PRIMARY_MEMBERSHIP_THRESHOLD,
  SECONDARY_MEMBERSHIP_THRESHOLD,
  buildTopicEmbeddingText,
  buildMembershipScoringInput,
  assignSmartCategoryMembershipsWithLocalEmbeddings,
  validateSmartCategoryMemberships,
  assignSmartCategoryMemberships,
  assignSaveToExistingSmartCategories,
};
