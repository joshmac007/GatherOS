'use strict';

const {
  CAPABILITIES,
  readGatherLocalAiConfig,
} = require('./config');
const { createCodexStructuredAdapter } = require('./codex-structured');
const { createLocalStructuredAdapter } = require('./local-structured');
const { createOllamaEmbeddingAdapter } = require('./ollama-embeddings');

function selector(config, capability, fallback) {
  const value = config?.routes?.[capability];
  return typeof value === 'string' ? value.trim().toLowerCase() || fallback : fallback;
}

function proxyRoute(proxyAdapter, capability) {
  if (!proxyAdapter) return null;
  if (capability === CAPABILITIES.STRUCTURED_JSON && typeof proxyAdapter.completeJson === 'function') return proxyAdapter;
  if (capability === CAPABILITIES.EMBEDDING && typeof proxyAdapter.embed === 'function') return proxyAdapter;
  if (capability === CAPABILITIES.IMAGE_GENERATION && typeof proxyAdapter.generateImage === 'function') return proxyAdapter;
  return null;
}

function createGatherLocalRoutes({ config, proxyAdapter = null, dependencies = {} } = {}) {
  const resolved = config || readGatherLocalAiConfig();
  const structured = selector(
    resolved,
    CAPABILITIES.STRUCTURED_JSON,
    'codex',
  );
  const embedding = selector(
    resolved,
    CAPABILITIES.EMBEDDING,
    'ollama',
  );
  const image = selector(
    resolved,
    CAPABILITIES.IMAGE_GENERATION,
    'disabled',
  );

  const routes = {
    [CAPABILITIES.STRUCTURED_JSON]: structured === 'codex'
      ? createCodexStructuredAdapter(resolved.codex, dependencies.codex || {})
      : structured === 'local'
        ? createLocalStructuredAdapter(resolved.local, dependencies.local || {})
        : structured === 'proxy'
          ? proxyRoute(proxyAdapter, CAPABILITIES.STRUCTURED_JSON)
          : null,
    [CAPABILITIES.EMBEDDING]: embedding === 'ollama'
      ? createOllamaEmbeddingAdapter(resolved.ollama, dependencies.ollama || {})
      : embedding === 'proxy'
        ? proxyRoute(proxyAdapter, CAPABILITIES.EMBEDDING)
        : null,
    [CAPABILITIES.IMAGE_GENERATION]: image === 'proxy'
      ? proxyRoute(proxyAdapter, CAPABILITIES.IMAGE_GENERATION)
      : null,
  };
  return routes;
}

module.exports = {
  createGatherLocalRoutes,
};
