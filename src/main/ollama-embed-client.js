function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function readJson(response, service) {
  try {
    return await response.json();
  } catch {
    throw createError(`${service} returned invalid JSON`, 'ollama_invalid_response');
  }
}

function modelMatches(installedName, requestedName) {
  const installed = clean(installedName);
  const requested = clean(requestedName);
  if (!installed || !requested) return false;
  if (installed === requested) return true;
  return installed.split(':')[0] === requested.split(':')[0];
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

function createOllamaEmbedClient(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = (clean(config.baseUrl) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const embedModel = clean(config.embedModel);
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
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, options);
    } catch (cause) {
      throw createError('Ollama is unavailable', 'ollama_unavailable', { cause });
    }
    const data = await readJson(response, 'Ollama');
    if (!response.ok) {
      const detail = clean(data?.error) || `HTTP ${response.status}`;
      throw createError(`Ollama request failed: ${detail}`, 'ollama_request_failed', {
        status: response.status,
      });
    }
    return data;
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
    async embed(text, { expectedDimension = observedDimension } = {}) {
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
      return vector;
    },
  };
}

module.exports = {
  createOllamaEmbedClient,
  validateVector,
};
