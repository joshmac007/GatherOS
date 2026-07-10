const VALID_PROVIDERS = new Set(['codex', 'local']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readAiConfig(env = process.env) {
  const requested = clean(env.GATHERLOCAL_AI_PROVIDER || env.GATHEROS_AI_PROVIDER).toLowerCase();
  const provider = VALID_PROVIDERS.has(requested) ? requested : 'codex';

  return {
    provider,
    codex: {
      bin: clean(env.GATHERLOCAL_CODEX_BIN) || 'codex',
      model: clean(env.GATHERLOCAL_CODEX_MODEL),
      timeoutMs: Number.parseInt(env.GATHERLOCAL_CODEX_TIMEOUT_MS || '', 10) || 120000,
    },
    local: {
      baseUrl: (clean(env.GATHERLOCAL_LOCAL_AI_BASE_URL) || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
      chatModel:
        clean(env.GATHERLOCAL_LOCAL_VISION_MODEL) ||
        clean(env.GATHERLOCAL_LOCAL_CHAT_MODEL) ||
        'llama3.2-vision',
      imageBaseUrl: clean(env.GATHERLOCAL_LOCAL_IMAGE_BASE_URL).replace(/\/+$/, ''),
      imageModel: clean(env.GATHERLOCAL_LOCAL_IMAGE_MODEL),
      token: clean(env.GATHERLOCAL_LOCAL_AI_TOKEN),
    },
    ollama: {
      baseUrl: (clean(env.GATHERLOCAL_OLLAMA_BASE_URL) || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      embedModel: clean(env.GATHERLOCAL_OLLAMA_EMBED_MODEL) || 'embeddinggemma',
    },
  };
}

module.exports = {
  readAiConfig,
};
