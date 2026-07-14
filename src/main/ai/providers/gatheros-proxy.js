'use strict';

const fs = require('node:fs');
const { API_BASE_URL } = require('../../../shared/licensing-config');
const {
  AiRuntimeError,
  CODES,
} = require('../errors');

const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function responseError(message, code, details = {}) {
  return new AiRuntimeError(code, message, details);
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = clean(raw);
  if (!text) throw responseError('AI proxy returned empty JSON', CODES.INVALID_RESPONSE);
  try { return JSON.parse(text); } catch { /* fenced/extra prose below */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw responseError('AI proxy returned invalid JSON', CODES.INVALID_RESPONSE);
}

function parseDataUrl(value) {
  const match = typeof value === 'string' && value.match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1] || 'image/jpeg', b64: match[2] };
}

async function defaultEncodeImage(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found');
  }
  try {
    const sharp = require('sharp');
    const bytes = await sharp(filePath)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { b64: bytes.toString('base64'), mimeType: 'image/jpeg' };
  } catch (error) {
    throw responseError('AI image encoding failed', CODES.PROVIDER_UNAVAILABLE, {
      retryable: false,
      cause: error,
    });
  }
}

function createAbortController(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('AI proxy request timed out'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function createGatherOsProxyAdapter({
  baseUrl = API_BASE_URL,
  getSessionToken = null,
  fetchImpl = globalThis.fetch,
  encodeImage = defaultEncodeImage,
  timeoutMs = 30000,
  chatModel = DEFAULT_CHAT_MODEL,
  embedModel = DEFAULT_EMBED_MODEL,
  imageModel = DEFAULT_IMAGE_MODEL,
} = {}) {
  const rootUrl = clean(baseUrl).replace(/\/+$/, '');
  let tokenReader = getSessionToken;
  function sessionToken() {
    if (!tokenReader) {
      tokenReader = require('../../licensing').getSessionToken;
    }
    return clean(typeof tokenReader === 'function' ? tokenReader() : tokenReader);
  }

  function isConfigured() {
    return Boolean(rootUrl && typeof fetchImpl === 'function' && hasSession());
  }

  function hasSession() {
    return Boolean(sessionToken());
  }

  async function request(route, { method = 'POST', body, signal } = {}) {
    const token = sessionToken();
    if (!token) throw responseError('AI proxy session is required', CODES.AUTH_REQUIRED);
    const controller = createAbortController(signal, Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000);
    try {
      const response = await fetchImpl(`${rootUrl}${route}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = typeof response.text === 'function'
        ? await response.text()
        : JSON.stringify(await response.json().catch(() => ({})));
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      if (!response.ok || data.ok === false) {
        const status = Number(response.status) || 0;
        const reason = clean(data.error) || `http_${status || 'unknown'}`;
        const code = status === 401 || reason === 'unauthenticated'
          ? CODES.AUTH_REQUIRED
          : status === 402 || reason === 'not_entitled'
            ? CODES.NOT_ENTITLED
            : status === 408 || status === 429 || status >= 500
              ? CODES.PROVIDER_UNAVAILABLE
              : CODES.INVALID_RESPONSE;
        throw responseError(`AI proxy ${reason}${data.detail ? `: ${data.detail}` : ''}`, code, {
          retryable: code === CODES.PROVIDER_UNAVAILABLE,
        });
      }
      return data;
    } catch (error) {
      if (error instanceof AiRuntimeError) throw error;
      if (controller.timedOut()) {
        throw responseError(`AI proxy request timed out after ${timeoutMs}ms`, CODES.TIMEOUT, {
          retryable: true,
          cause: error,
        });
      }
      if (signal?.aborted || error?.name === 'AbortError') {
        throw responseError('AI proxy request aborted', CODES.ABORTED, { cause: error });
      }
      throw responseError('AI proxy is unavailable', CODES.PROVIDER_UNAVAILABLE, {
        retryable: true,
        cause: error,
      });
    } finally {
      controller.dispose();
    }
  }

  async function completeJson({
    system = '',
    input = '',
    imagePath = null,
    maxOutputTokens,
    maxTokens,
    model = chatModel,
    signal,
  } = {}) {
    let userContent = String(input ?? '');
    if (imagePath) {
      const encoded = await encodeImage(imagePath);
      const dataUrl = encoded?.dataUrl || (
        encoded?.b64 ? `data:${encoded.mimeType || 'image/jpeg'};base64,${encoded.b64}` : encoded
      );
      if (typeof dataUrl !== 'string') throw responseError('AI image encoding failed', CODES.INVALID_RESPONSE);
      userContent = [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ];
    }
    const payload = await request('/ai/chat', {
      signal,
      body: {
        model: model || DEFAULT_CHAT_MODEL,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        max_tokens: maxOutputTokens ?? maxTokens,
      },
    });
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' && (!content || typeof content !== 'object')) {
      throw responseError('AI proxy returned no JSON content', CODES.INVALID_RESPONSE);
    }
    return parseJsonObject(content);
  }

  async function embed({ text, expectedDimension = null, signal, model = embedModel } = {}) {
    const input = clean(text);
    if (!input) throw new TypeError('Cannot embed empty text');
    const payload = await request('/ai/embed', {
      signal,
      body: { input: input.slice(0, 8000) },
    });
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)) {
      throw responseError('AI proxy returned an invalid embedding vector', CODES.INVALID_RESPONSE);
    }
    if (expectedDimension != null && vector.length !== expectedDimension) {
      throw responseError(
        `AI embedding dimension mismatch: expected ${expectedDimension}, received ${vector.length}`,
        CODES.EMBEDDING_DIMENSION_MISMATCH,
      );
    }
    return {
      vector,
      provider: 'gatheros-proxy',
      model: model || DEFAULT_EMBED_MODEL,
      dimension: vector.length,
    };
  }

  async function generateImage({
    prompt,
    size = 'auto',
    quality = 'medium',
    imagePath = null,
    sourceFilePath = null,
    signal,
  } = {}) {
    const cleanPrompt = clean(prompt);
    if (!cleanPrompt) throw new TypeError('Image generation prompt is required');
    const source = imagePath || sourceFilePath;
    const body = { prompt: cleanPrompt, size, quality };
    if (source) {
      const encoded = await encodeImage(source);
      const parsed = encoded?.dataUrl ? parseDataUrl(encoded.dataUrl) : null;
      body.image_b64 = encoded?.b64 || parsed?.b64 || encoded;
      body.image_mime = encoded?.mimeType || parsed?.mimeType || 'image/jpeg';
      if (typeof body.image_b64 !== 'string') throw responseError('AI image encoding failed', CODES.INVALID_RESPONSE);
    }
    const payload = await request('/ai/image', { signal, body });
    const b64 = payload.image?.b64_json || payload.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) throw responseError('AI proxy returned no image bytes', CODES.INVALID_RESPONSE);
    return {
      bytes: Buffer.from(b64, 'base64'),
      mimeType: 'image/png',
      provider: 'gatheros-proxy',
      model: imageModel || DEFAULT_IMAGE_MODEL,
      usage: payload.usage,
      quota: payload.quota,
    };
  }

  async function health({ signal } = {}) {
    await request('/ai/usage', { method: 'GET', signal });
    return { ok: true, provider: 'gatheros-proxy' };
  }

  async function getUsage({ signal } = {}) {
    if (!sessionToken()) return null;
    try {
      return await request('/ai/usage', { method: 'GET', signal });
    } catch {
      return null;
    }
  }

  return {
    id: 'gatheros-proxy',
    isConfigured,
    hasSession,
    health,
    completeJson,
    embed,
    generateImage,
    getUsage,
  };
}

module.exports = {
  createGatherOsProxyAdapter,
  parseJsonObject,
};
