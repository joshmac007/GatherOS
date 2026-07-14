'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CAPABILITIES } = require('../../ai/runtime');

const STRUCTURED_PROVIDERS = new Set(['codex', 'local', 'proxy']);
const EMBEDDING_PROVIDERS = new Set(['ollama', 'proxy']);
const IMAGE_PROVIDERS = new Set(['disabled', 'proxy']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function url(value, fallback) {
  return (clean(value) || fallback).replace(/\/+$/, '');
}

function selected(env, name, allowed, fallback) {
  const requested = clean(env[name]);
  if (!requested) return fallback;
  const normalized = requested.toLowerCase();
  if (!allowed.has(normalized)) {
    throw new TypeError(`${name} must be one of: ${Array.from(allowed).join(', ')}`);
  }
  return normalized;
}

function executable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function codexBin(env) {
  const configured = clean(env.GATHERLOCAL_CODEX_BIN);
  if (configured) return configured;
  if (process.platform === 'darwin') {
    const bundledCandidates = [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
    ];
    const bundled = bundledCandidates.find(executable);
    if (bundled) return bundled;
  }
  return 'codex';
}

/**
 * Read GatherLocal's private capability overlay.
 *
 * Route selectors are deliberately independent. One provider enum cannot
 * describe this runtime.
 */
function readGatherLocalAiConfig(env = process.env) {
  const source = env || {};
  const structuredProvider = selected(
    source,
    'GATHERLOCAL_AI_STRUCTURED_PROVIDER',
    STRUCTURED_PROVIDERS,
    'codex',
  );
  const embeddingProvider = selected(
    source,
    'GATHERLOCAL_AI_EMBEDDING_PROVIDER',
    EMBEDDING_PROVIDERS,
    'ollama',
  );
  const imageProvider = selected(
    source,
    'GATHERLOCAL_AI_IMAGE_PROVIDER',
    IMAGE_PROVIDERS,
    'disabled',
  );

  return {
    routes: {
      [CAPABILITIES.STRUCTURED_JSON]: structuredProvider,
      [CAPABILITIES.EMBEDDING]: embeddingProvider,
      [CAPABILITIES.IMAGE_GENERATION]: imageProvider,
    },
    codex: {
      bin: codexBin(source),
      model: clean(source.GATHERLOCAL_CODEX_MODEL),
      cwd: clean(source.GATHERLOCAL_CODEX_CWD) || process.cwd(),
      timeoutMs: positiveInteger(source.GATHERLOCAL_CODEX_TIMEOUT_MS, 120000),
    },
    local: {
      baseUrl: url(source.GATHERLOCAL_LOCAL_AI_BASE_URL, 'http://127.0.0.1:11434/v1'),
      chatModel:
        clean(source.GATHERLOCAL_LOCAL_VISION_MODEL) ||
        clean(source.GATHERLOCAL_LOCAL_CHAT_MODEL) ||
        'llama3.2-vision',
      token: clean(source.GATHERLOCAL_LOCAL_AI_TOKEN),
      timeoutMs: positiveInteger(source.GATHERLOCAL_LOCAL_AI_TIMEOUT_MS, 120000),
      maxImageBytes: positiveInteger(source.GATHERLOCAL_LOCAL_AI_MAX_IMAGE_BYTES, 2 * 1024 * 1024),
    },
    ollama: {
      baseUrl: url(source.GATHERLOCAL_OLLAMA_BASE_URL, 'http://127.0.0.1:11434'),
      embedModel: clean(source.GATHERLOCAL_OLLAMA_EMBED_MODEL) || 'embeddinggemma',
      timeoutMs: positiveInteger(source.GATHERLOCAL_OLLAMA_TIMEOUT_MS, 30000),
      expectedDimension: positiveInteger(source.GATHERLOCAL_OLLAMA_EMBED_DIMENSION, null),
    },
  };
}

module.exports = {
  CAPABILITIES,
  readGatherLocalAiConfig,
};
