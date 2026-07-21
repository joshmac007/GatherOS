'use strict';

const { CAPABILITIES } = require('./config');
const { requestJson, parseJsonObject, runtimeError, timeoutValue } = require('./transport-utils');
const { boundedJpegDataUrl } = require('./image-input');

const PROVIDER = 'local';

function authHeaders(config) {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

function contentFromResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  return content;
}

function createLocalStructuredAdapter(config = {}, dependencies = {}) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
  const model = typeof config.chatModel === 'string' ? config.chatModel.trim() : '';
  const timeoutMs = timeoutValue(config.timeoutMs, 120000);
  const maxImageBytes = timeoutValue(config.maxImageBytes, 2 * 1024 * 1024);
  const fetchImpl = dependencies.fetch || globalThis.fetch;

  function configured() {
    return Boolean(baseUrl && model);
  }

  async function request(body, signal) {
    const data = await requestJson({
      fetchImpl,
      url: `${baseUrl}/chat/completions`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
        body: JSON.stringify(body),
      },
      timeoutMs,
      signal,
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider: PROVIDER,
      dependencies,
    });
    return parseJsonObject(contentFromResponse(data), PROVIDER, CAPABILITIES.STRUCTURED_JSON);
  }

  return {
    id: PROVIDER,
    model,
    isConfigured: configured,
    async health({ signal } = {}) {
      if (!configured()) {
        throw runtimeError('AI_CAPABILITY_UNCONFIGURED', 'Local structured model is not configured', {
          capability: CAPABILITIES.STRUCTURED_JSON,
          provider: PROVIDER,
          retryable: false,
        });
      }
      await requestJson({
        fetchImpl,
        url: `${baseUrl}/models`,
        options: { method: 'GET', headers: authHeaders(config) },
        timeoutMs,
        signal,
        capability: CAPABILITIES.STRUCTURED_JSON,
        provider: PROVIDER,
        dependencies,
      });
      return { ok: true, provider: PROVIDER, model };
    },
    async completeJson({ system = '', input = '', imagePath, maxOutputTokens, signal } = {}) {
      if (!configured()) {
        throw runtimeError('AI_CAPABILITY_UNCONFIGURED', 'Local structured model is not configured', {
          capability: CAPABILITIES.STRUCTURED_JSON,
          provider: PROVIDER,
          retryable: false,
        });
      }
      const inputText = typeof input === 'string' ? input : JSON.stringify(input ?? '');
      const userContent = imagePath
        ? [
          { type: 'text', text: inputText },
          { type: 'image_url', image_url: { url: await boundedJpegDataUrl(imagePath, { maxBytes: maxImageBytes, provider: PROVIDER }, dependencies), detail: 'low' } },
        ]
        : inputText;
      const body = {
        model,
        messages: [
          { role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system ?? '') },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
      };
      if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_tokens = maxOutputTokens;
      return request(body, signal);
    },
  };
}

module.exports = {
  createLocalStructuredAdapter,
  boundedJpegDataUrl,
};
