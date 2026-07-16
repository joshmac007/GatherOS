'use strict';

const crypto = require('node:crypto');

function clean(value, max = 400) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function discoveryInput(profiles = [], { maxProfiles = 120 } = {}) {
  return {
    profiles: (Array.isArray(profiles) ? profiles : []).slice(0, maxProfiles).map((profile) => ({
      summary: clean(profile?.summary, 600),
      concepts: Array.isArray(profile?.concepts)
        ? profile.concepts.map((value) => clean(value, 80).toLowerCase()).filter(Boolean).slice(0, 8)
        : [],
      content_type: clean(profile?.content_type || profile?.contentType, 80),
      intent: clean(profile?.intent_guess || profile?.intent, 80),
    })).filter((profile) => profile.summary || profile.concepts.length),
  };
}

function validateDiscoveredCategories(parsed, { maxCategories = 12 } = {}) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.categories)) {
    return { ok: false, reason: 'missing-categories' };
  }
  const names = new Set();
  const categories = [];
  for (const item of parsed.categories.slice(0, maxCategories)) {
    const name = clean(item?.name, 80);
    const description = clean(item?.description, 300);
    const confidence = Number(item?.confidence);
    if (!name || !description) return { ok: false, reason: 'invalid-category' };
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: 'invalid-confidence' };
    }
    const key = name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    categories.push({
      name,
      description,
      confidence,
      aliases: Array.isArray(item.aliases)
        ? [...new Set(item.aliases.map((alias) => clean(alias, 80)).filter(Boolean))].slice(0, 8)
        : [],
    });
  }
  if (categories.length === 0) return { ok: false, reason: 'empty-categories' };
  return { ok: true, categories };
}

function categoryId(name) {
  const slug = clean(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const suffix = crypto.createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 8);
  return `smart-${slug || 'category'}-${suffix}`;
}

async function discoverSmartCategories({
  profiles = [],
  structuredProvider,
  storage = {},
  now = Date.now,
  minConfidence = 0.72,
  signal,
} = {}) {
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  if (typeof structuredProvider?.completeJson !== 'function') {
    return { ok: false, reason: 'unsupported-provider' };
  }
  if (typeof storage.upsertSmartCategory !== 'function') {
    return { ok: false, reason: 'missing-category-storage' };
  }
  const input = discoveryInput(profiles);
  if (input.profiles.length === 0) return { ok: false, reason: 'no-profiles' };
  let parsed;
  try {
    parsed = await structuredProvider.completeJson({
      system:
        'Discover a small durable taxonomy from saved-item topic profiles. Return JSON only: ' +
        '{"categories":[{"name":"...","description":"...","aliases":["..."],"confidence":0.0}]}. ' +
        'Prefer 3-8 useful themes. Avoid categories based only on file type, author, or one item.',
      input: JSON.stringify(input),
      maxOutputTokens: 1000,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    return { ok: false, reason: error?.code || 'provider-error', detail: error?.message || String(error) };
  }
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  const validation = validateDiscoveredCategories(parsed);
  if (!validation.ok) return validation;
  const createdAt = now();
  const accepted = validation.categories
    .filter((category) => category.confidence >= minConfidence)
    .map((category) => ({ ...category, id: categoryId(category.name) }));
  for (const category of accepted) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    const { id } = category;
    storage.upsertSmartCategory({
      id,
      name: category.name,
      description: category.description,
      status: 'candidate',
      createdAt,
      updatedAt: createdAt,
    });
    if (typeof storage.upsertSmartCategoryAlias === 'function') {
      for (const alias of category.aliases) {
        if (signal?.aborted) return { ok: false, reason: 'aborted' };
        storage.upsertSmartCategoryAlias({ categoryId: id, alias, source: 'discovery', createdAt });
      }
    }
  }
  return { ok: true, createdCount: accepted.length, categories: accepted };
}

module.exports = {
  discoveryInput,
  validateDiscoveredCategories,
  categoryId,
  discoverSmartCategories,
};
