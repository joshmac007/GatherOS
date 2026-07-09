// AI facade kept under the old filename so existing IPC call sites stay stable.
// GatherLocal routes to subscription-backed Codex auth or local model servers,
// never to an OpenAI Platform API key by default.

const { readAiConfig } = require('./ai-provider-config');
const { createCodexProvider } = require('./ai-codex-provider');
const { createLocalProvider } = require('./ai-local-provider');

function createProvider() {
  const config = readAiConfig();
  if (config.provider === 'local') return createLocalProvider(config.local);
  return createCodexProvider(config.codex);
}

let provider = null;
let localEmbeddingProvider = null;

function getProvider() {
  if (!provider) provider = createProvider();
  return provider;
}

function getLocalEmbeddingProvider() {
  if (!localEmbeddingProvider) {
    localEmbeddingProvider = createLocalProvider(readAiConfig().local);
  }
  return localEmbeddingProvider;
}

function hasSession() {
  return getProvider().hasSession();
}

async function autoTagImage(filePath) {
  return getProvider().autoTagImage(filePath);
}

async function analyzeImage(filePath) {
  return getProvider().analyzeImage(filePath);
}

async function generateImagePrompt(filePath) {
  return getProvider().generateImagePrompt(filePath);
}

async function generateSaveTopicProfile(input, options = {}) {
  return getProvider().generateSaveTopicProfile(input, options);
}

async function generateSmartCategoryMemberships(input) {
  const active = getProvider();
  if (typeof active.generateSmartCategoryMemberships !== 'function') {
    const err = new Error('Active AI provider does not support smart category membership scoring.');
    err.code = 'membership_scoring_unavailable';
    throw err;
  }
  return active.generateSmartCategoryMemberships(input);
}

async function generateSmartCategoryTaxonomyRefresh(input) {
  const active = getProvider();
  if (typeof active.generateSmartCategoryTaxonomyRefresh !== 'function') {
    const err = new Error('Active AI provider does not support smart category taxonomy refresh.');
    err.code = 'taxonomy_refresh_unavailable';
    throw err;
  }
  return active.generateSmartCategoryTaxonomyRefresh(input);
}

async function embedText(text) {
  const active = getProvider();
  try {
    return await active.embedText(text);
  } catch (err) {
    if (err?.code !== 'embeddings_unavailable') throw err;
  }
  return getLocalEmbeddingProvider().embedText(text);
}

async function generateImage(prompt, options = {}) {
  return getProvider().generateImage(prompt, options);
}

async function getUsage() {
  return getProvider().getUsage();
}

module.exports = {
  hasSession,
  autoTagImage,
  analyzeImage,
  generateImagePrompt,
  generateSaveTopicProfile,
  generateSmartCategoryMemberships,
  generateSmartCategoryTaxonomyRefresh,
  generateImage,
  embedText,
  getUsage,
};
