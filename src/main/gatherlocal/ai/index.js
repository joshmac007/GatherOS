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

function createGatherLocalRoutes({ config, dependencies = {} } = {}) {
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
        : null,
    [CAPABILITIES.EMBEDDING]: embedding === 'ollama'
      ? createOllamaEmbeddingAdapter(resolved.ollama, dependencies.ollama || {})
      : null,
    [CAPABILITIES.IMAGE_GENERATION]: null,
  };
  return routes;
}

module.exports = {
  createGatherLocalRoutes,
};
