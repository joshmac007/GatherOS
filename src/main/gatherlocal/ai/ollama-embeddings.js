'use strict';

const { CAPABILITIES } = require('./config');
const { requestJson, runtimeError, timeoutValue } = require('./transport-utils');

const PROVIDER = 'ollama';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function modelMatches(installedName, requestedName) {
  const installed = clean(installedName);
  const requested = clean(requestedName);
  if (!installed || !requested) return false;
  if (requested.includes(':')) return installed === requested;
  return installed === requested || installed === `${requested}:latest`;
}

function invalidVector(vector, expectedDimension) {
  if (!Array.isArray(vector) || vector.length === 0 ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)) {
    throw runtimeError('AI_INVALID_RESPONSE', 'Ollama returned an invalid embedding vector', {
      capability: CAPABILITIES.EMBEDDING,
      provider: PROVIDER,
      retryable: false,
    });
  }
  if (expectedDimension != null && vector.length !== expectedDimension) {
    throw runtimeError(
      'AI_EMBEDDING_DIMENSION_MISMATCH',
      `Ollama embedding dimension mismatch: expected ${expectedDimension}, received ${vector.length}`,
      {
        capability: CAPABILITIES.EMBEDDING,
        provider: PROVIDER,
        retryable: false,
        expectedDimension,
        actualDimension: vector.length,
      },
    );
  }
  return vector;
}

function createOllamaEmbeddingAdapter(config = {}, dependencies = {}) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = clean(config.embedModel || config.model);
  const timeoutMs = timeoutValue(config.timeoutMs, 30000);
  let observedDimension = Number.isInteger(config.expectedDimension) && config.expectedDimension > 0
    ? config.expectedDimension
    : null;
  const fetchImpl = dependencies.fetch || globalThis.fetch;

  function configured() {
    return Boolean(baseUrl && model);
  }

  function modelMissing() {
    return runtimeError('AI_MODEL_MISSING', `Ollama model ${model || '(empty)'} is not installed`, {
      capability: CAPABILITIES.EMBEDDING,
      provider: PROVIDER,
      retryable: false,
      setupAction: model ? `ollama pull ${model}` : undefined,
    });
  }

  async function tags(signal) {
    if (!configured()) {
      throw runtimeError('AI_CAPABILITY_UNCONFIGURED', 'Ollama embedding model is not configured', {
        capability: CAPABILITIES.EMBEDDING,
        provider: PROVIDER,
        retryable: false,
        setupAction: model ? `ollama pull ${model}` : undefined,
      });
    }
    const data = await requestJson({
      fetchImpl,
      url: `${baseUrl}/api/tags`,
      options: { method: 'GET' },
      timeoutMs,
      signal,
      capability: CAPABILITIES.EMBEDDING,
      provider: PROVIDER,
      dependencies,
    });
    const installed = Array.isArray(data?.models)
      ? data.models.some((entry) => modelMatches(entry?.name || entry?.model, model))
      : false;
    if (!installed) throw modelMissing();
    return data;
  }

  return {
    id: PROVIDER,
    model,
    isConfigured: configured,
    async health({ signal } = {}) {
      await tags(signal);
      return { ok: true, provider: PROVIDER, model, dimension: observedDimension };
    },
    async embed({ text, expectedDimension = null, signal } = {}) {
      if (!configured()) {
        throw runtimeError('AI_CAPABILITY_UNCONFIGURED', 'Ollama embedding model is not configured', {
          capability: CAPABILITIES.EMBEDDING,
          provider: PROVIDER,
          retryable: false,
          setupAction: model ? `ollama pull ${model}` : undefined,
        });
      }
      const input = clean(text);
      if (!input) {
        throw runtimeError('AI_INVALID_RESPONSE', 'Cannot embed empty text', {
          capability: CAPABILITIES.EMBEDDING,
          provider: PROVIDER,
          retryable: false,
        });
      }
      let data;
      try {
        data = await requestJson({
          fetchImpl,
          url: `${baseUrl}/api/embed`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input }),
          },
          timeoutMs,
          signal,
          capability: CAPABILITIES.EMBEDDING,
          provider: PROVIDER,
          dependencies,
        });
      } catch (error) {
        if (error?.status === 404) {
          const missing = modelMissing();
          missing.cause = error;
          throw missing;
        }
        throw error;
      }
      const vector = invalidVector(data?.embeddings?.[0], expectedDimension);
      if (observedDimension == null) observedDimension = vector.length;
      invalidVector(vector, observedDimension);
      return {
        vector,
        provider: PROVIDER,
        model,
        dimension: vector.length,
      };
    },
  };
}

module.exports = {
  createOllamaEmbeddingAdapter,
  modelMatches,
  validateVector: invalidVector,
};
