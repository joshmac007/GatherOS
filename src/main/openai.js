// AI facade kept under the old filename so existing IPC call sites stay stable.
// GatherLocal routes to subscription-backed Codex auth or local model servers,
// never to an OpenAI Platform API key by default.

const { readAiConfig } = require('./ai-provider-config');
const { createCodexProvider } = require('./ai-codex-provider');
const { createLocalProvider } = require('./ai-local-provider');
const { createOllamaEmbedClient } = require('./ollama-embed-client');

function createProvider() {
  const config = readAiConfig();
  if (config.provider === 'local') return createLocalProvider(config.local);
  return createCodexProvider(config.codex);
}

function createCodexVideoFacade({
  readConfig = readAiConfig,
  createCodex = createCodexProvider,
} = {}) {
  let codexProvider = null;
  function getCodexProvider() {
    if (!codexProvider) codexProvider = createCodex(readConfig().codex);
    return codexProvider;
  }
  return {
    hasCodexSession() {
      const activeCodex = getCodexProvider();
      return typeof activeCodex?.hasSession === 'function' && activeCodex.hasSession();
    },
    async generateVideoTagSuggestions(input, options = {}) {
      const activeCodex = getCodexProvider();
      if (typeof activeCodex?.generateVideoTagSuggestions !== 'function') {
        const error = new Error('Codex video suggestions are unavailable');
        error.code = 'codex_video_unavailable';
        throw error;
      }
      return activeCodex.generateVideoTagSuggestions(input, options);
    },
  };
}

function createVideoTagSuggestionGenerator(options = {}) {
  const facade = createCodexVideoFacade(options);
  return facade.generateVideoTagSuggestions.bind(facade);
}

const codexVideoFacade = createCodexVideoFacade();

function hasCodexSession() {
  return codexVideoFacade.hasCodexSession();
}

function generateVideoTagSuggestions(input, options = {}) {
  return codexVideoFacade.generateVideoTagSuggestions(input, options);
}

let provider = null;

function getProvider() {
  if (!provider) provider = createProvider();
  return provider;
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

async function generateImage(prompt, options = {}) {
  return getProvider().generateImage(prompt, options);
}

async function getUsage() {
  return getProvider().getUsage();
}

module.exports = {
  hasSession,
  hasCodexSession,
  autoTagImage,
  analyzeImage,
  generateImagePrompt,
  generateSaveTopicProfile,
  generateSmartCategoryMemberships,
  generateSmartCategoryTaxonomyRefresh,
  generateVideoTagSuggestions,
  createCodexVideoFacade,
  createVideoTagSuggestionGenerator,
  generateImage,
  createOllamaEmbedClient,
  getUsage,
};
