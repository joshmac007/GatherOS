function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function readResponseBody(response) {
  if (typeof response.text === 'function') {
    try {
      const raw = await response.text();
      try {
        return { data: JSON.parse(raw), raw, invalidJson: false };
      } catch {
        return { data: null, raw, invalidJson: true };
      }
    } catch {
      return { data: null, raw: '', invalidJson: true };
    }
  }
  try {
    return { data: await response.json(), raw: '', invalidJson: false };
  } catch {
    return { data: null, raw: '', invalidJson: true };
  }
}

function modelMatches(installedName, requestedName) {
  const installed = clean(installedName);
  const requested = clean(requestedName);
  if (!installed || !requested) return false;
  if (requested.includes(':')) return installed === requested;
  return installed === requested || installed === `${requested}:latest`;
}

function validateVector(vector, expectedDimension) {
  const valid = Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    vector.some((value) => value !== 0);
  if (!valid) {
    throw createError('Ollama returned an invalid embedding vector', 'ollama_invalid_embedding');
  }
  if (expectedDimension != null && vector.length !== expectedDimension) {
    throw createError(
      `Ollama embedding dimension mismatch: expected ${expectedDimension}, received ${vector.length}`,
      'ollama_embedding_dimension_mismatch',
      { expectedDimension, actualDimension: vector.length },
    );
  }
  return vector;
}

function createOllamaEmbedClient(config = {}, {
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const baseUrl = (clean(config.baseUrl) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const embedModel = clean(config.embedModel);
  const configuredTimeout = Number(config.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 30000;
  let observedDimension = Number.isInteger(config.expectedDimension) && config.expectedDimension > 0
    ? config.expectedDimension
    : null;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Ollama client requires fetch');
  }

  function requireModel() {
    if (!embedModel) {
      throw createError('Ollama embedding model is not configured', 'ollama_model_missing');
    }
  }

  async function request(path, options) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeoutImpl(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        const detail = clean(body.data?.error?.message) ||
          clean(body.data?.error) ||
          clean(body.raw) ||
          `HTTP ${response.status}`;
        const status = response.status;
        throw createError(`Ollama request failed: ${detail}`, 'ollama_request_failed', {
          status,
          retryable: status === 408 || status === 429 || status >= 500,
        });
      }
      if (body.invalidJson) {
        throw createError('Ollama returned invalid JSON', 'ollama_invalid_response');
      }
      return body.data;
    } catch (cause) {
      if (cause?.code) throw cause;
      if (timedOut) {
        throw createError(`Ollama request timed out after ${timeoutMs}ms`, 'ollama_timeout', {
          timeoutMs,
          retryable: true,
          cause,
        });
      }
      throw createError('Ollama is unavailable', 'ollama_unavailable', { cause });
    } finally {
      clearTimeoutImpl(timeoutId);
    }
  }

  return {
    model: embedModel,
    async health() {
      requireModel();
      const data = await request('/api/tags', { method: 'GET' });
      const installed = Array.isArray(data.models)
        ? data.models.some((model) => modelMatches(model?.name || model?.model, embedModel))
        : false;
      if (!installed) {
        throw createError(
          `Ollama model ${embedModel} is not installed`,
          'ollama_model_missing',
          { setupAction: `ollama pull ${embedModel}` },
        );
      }
      return { ok: true, model: embedModel };
    },
    async embed(text, { expectedDimension = null } = {}) {
      requireModel();
      const input = clean(text);
      if (!input) throw new Error('Cannot embed empty text');
      const data = await request('/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel, input }),
      });
      const vector = validateVector(data.embeddings?.[0], expectedDimension);
      if (observedDimension == null) observedDimension = vector.length;
      validateVector(vector, observedDimension);
      return vector;
    },
  };
}

module.exports = {
  createOllamaEmbedClient,
  validateVector,
};
