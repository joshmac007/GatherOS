const PRIMARY_MEMBERSHIP_THRESHOLD = 0.75;
const SECONDARY_MEMBERSHIP_THRESHOLD = 0.45;

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

async function assignSmartCategoryMemberships({
  saveId,
  profile,
  candidateCategories = [],
  provider,
  upsertSmartCategoryMembership,
  now = Date.now,
} = {}) {
  if (!saveId) return { ok: false, reason: 'missing-save' };
  if (!profile) return { ok: false, reason: 'missing-profile' };
  if (!provider?.generateSmartCategoryMemberships) {
    return { ok: false, reason: 'unsupported-provider' };
  }
  if (typeof upsertSmartCategoryMembership !== 'function') {
    return { ok: false, reason: 'missing-storage' };
  }

  const input = buildMembershipScoringInput(profile, candidateCategories);
  if (input.candidate_categories.length === 0) {
    return { ok: true, assignedCount: 0, needsNewCategory: false, newCategoryHint: null };
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
    now,
  });
}

module.exports = {
  PRIMARY_MEMBERSHIP_THRESHOLD,
  SECONDARY_MEMBERSHIP_THRESHOLD,
  buildMembershipScoringInput,
  validateSmartCategoryMemberships,
  assignSmartCategoryMemberships,
  assignSaveToExistingSmartCategories,
};
