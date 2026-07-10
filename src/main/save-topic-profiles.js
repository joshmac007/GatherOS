const fs = require('node:fs');
const { isVideoSave } = require('./video-semantic-workflows');

const CONTENT_TYPES = new Set([
  'tweet',
  'product-screenshot',
  'article',
  'diagram',
  'moodboard',
  'code',
  'other',
]);

const INTENTS = new Set([
  'tool-reference',
  'tutorial',
  'inspiration',
  'opinion',
  'research',
  'quote',
  'other',
]);

function parseJson(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function cleanString(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeConcept(value) {
  return cleanString(value, 80)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^#+/, '')
    .trim();
}

function buildSaveTopicEvidence(save, manualTags = []) {
  const tweetMeta = parseJson(save?.tweet_meta, null) || {};
  const quoted = tweetMeta.quoted && typeof tweetMeta.quoted === 'object' ? tweetMeta.quoted : {};
  const authorName = cleanString(tweetMeta.authorName || tweetMeta.author || tweetMeta.name, 120);
  const authorHandle = cleanString(tweetMeta.authorHandle || tweetMeta.handle, 80);
  const author = [authorName, authorHandle].filter(Boolean).join(' ');
  const imagePath = cleanString(save?.file_path, 2000);
  const hasImageEvidence = !!(
    imagePath
    && fs.existsSync(imagePath)
    && save?.kind !== 'url'
    && !isVideoSave(save)
  );

  return {
    promptInput: {
      tweetText: cleanString(tweetMeta.caption || tweetMeta.text || save?.notes, 4000),
      quotedTweetText: cleanString(quoted.caption || quoted.text, 2000),
      author,
      sourceUrl: cleanString(save?.source_url, 2000),
      manualTags: Array.isArray(manualTags)
        ? manualTags.map((tag) => cleanString(tag?.name || tag, 80)).filter(Boolean)
        : [],
      existingTitle: cleanString(save?.title, 300) || null,
    },
    imagePath: hasImageEvidence ? imagePath : null,
  };
}

function validateSaveTopicProfile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-object' };
  }

  const summary = cleanString(parsed.summary, 600);
  if (!summary) return { ok: false, reason: 'missing-summary' };

  const concepts = Array.isArray(parsed.concepts)
    ? [...new Set(parsed.concepts.map(normalizeConcept).filter(Boolean))].slice(0, 8)
    : [];
  if (concepts.length < 3) return { ok: false, reason: 'missing-concepts' };

  const contentType = cleanString(parsed.content_type, 80);
  if (!CONTENT_TYPES.has(contentType)) return { ok: false, reason: 'invalid-content-type' };

  const intent = cleanString(parsed.intent, 80);
  if (!INTENTS.has(intent)) return { ok: false, reason: 'invalid-intent' };

  if (typeof parsed.visible_text !== 'string') return { ok: false, reason: 'missing-visible-text' };

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: 'invalid-confidence' };
  }

  return {
    ok: true,
    profile: {
      concepts,
      contentType,
      intentGuess: intent,
      summary,
      confidence,
    },
  };
}

async function createSaveTopicProfile({
  save,
  manualTags = [],
  provider,
  upsertSaveTopicProfile,
  now = Date.now,
} = {}) {
  if (!save?.id) return { ok: false, reason: 'missing-save' };
  if (!provider?.generateSaveTopicProfile) return { ok: false, reason: 'unsupported-provider' };
  if (typeof upsertSaveTopicProfile !== 'function') return { ok: false, reason: 'missing-storage' };

  const evidence = buildSaveTopicEvidence(save, manualTags);
  let parsed;
  try {
    parsed = await provider.generateSaveTopicProfile(evidence.promptInput, {
      imagePath: evidence.imagePath,
    });
  } catch (err) {
    return { ok: false, reason: err?.code || 'provider-error', detail: err?.message || String(err) };
  }
  const validation = validateSaveTopicProfile(parsed);
  if (!validation.ok) return validation;

  return upsertSaveTopicProfile({
    saveId: save.id,
    ...validation.profile,
    updatedAt: now(),
  });
}

async function enrichSaveTopicProfile({
  record,
  getSave,
  getTagsForSave,
  topicProvider,
  upsertSaveTopicProfile,
  assignMemberships,
  membershipProvider,
  listSmartCategories,
  getSmartCategoryAliases,
  upsertSmartCategoryMembership,
  getSemanticIndexState,
  getSemanticVector,
  getActiveSemanticVectors,
  getSmartCategoryMembers,
  now = Date.now,
} = {}) {
  const save = typeof getSave === 'function' ? getSave(record?.id) || record : record;
  const manualTags = typeof getTagsForSave === 'function' ? getTagsForSave(record?.id) : [];
  const result = await createSaveTopicProfile({
    save,
    manualTags,
    provider: topicProvider,
    upsertSaveTopicProfile,
    now,
  });
  if (!result?.ok || typeof assignMemberships !== 'function') return result;

  const membership = await assignMemberships({
    saveId: record.id,
    profile: result.profile,
    provider: membershipProvider,
    listSmartCategories,
    getSmartCategoryAliases,
    upsertSmartCategoryMembership,
    getSemanticIndexState,
    getSemanticVector,
    getActiveSemanticVectors,
    getSmartCategoryMembers,
    now,
  });
  return { ...result, membership };
}

module.exports = {
  buildSaveTopicEvidence,
  validateSaveTopicProfile,
  createSaveTopicProfile,
  enrichSaveTopicProfile,
};
