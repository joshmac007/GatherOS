'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const { CAPABILITIES } = require('./config');
const { boundedJpegDataUrl } = require('./image-input');
const { defaultSchemaRegistry } = require('./schema-registry');
const { runtimeError, timeoutValue } = require('./transport-utils');

const PROVIDER = 'codex';
const SOURCE_ENDPOINT = 'https://api.openai.com/v1/responses';
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

function headersWithoutAuthorization(input) {
  const headers = new Headers(input || {});
  for (const name of ['authorization', 'api-key', 'x-api-key']) headers.delete(name);
  return headers;
}

function sourceUrl(input) {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function waitWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(result);
    };
    const onAbort = () => finish(reject, signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

function createCodexFetch({
  auth,
  fetchImpl = globalThis.fetch,
  sessionId,
  userAgent,
  signal,
  deadline,
  tracer = () => {},
  onSend = () => {},
} = {}) {
  if (!auth || typeof auth.credentials !== 'function') throw new TypeError('Codex fetch requires auth');
  return async (input, init = {}) => {
    const url = sourceUrl(input);
    const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (method !== 'POST' || url.href !== SOURCE_ENDPOINT) {
      throw runtimeError('AI_INVALID_RESPONSE', 'Codex transport rejected unexpected request', {
        capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: false,
      });
    }
    const first = await auth.credentials({ signal, deadline });
    const send = (credentials) => {
      onSend();
      const headers = headersWithoutAuthorization(init.headers);
      headers.set('Authorization', `Bearer ${credentials.accessToken}`);
      if (credentials.accountId) headers.set('ChatGPT-Account-Id', credentials.accountId);
      headers.set('originator', 'gatherlocal');
      headers.set('User-Agent', userAgent);
      headers.set('session-id', sessionId);
      tracer({ event: 'request', sessionId, generation: credentials.generation });
      return fetchImpl(CODEX_ENDPOINT, { ...init, method: 'POST', headers, signal, redirect: 'error' });
    };
    let response = await send(first);
    if (response?.status === 401) {
      tracer({ event: 'unauthorized', sessionId, generation: first.generation });
      const refreshed = await auth.credentials({
        forceRefresh: true, expectedGeneration: first.generation, signal, deadline,
      });
      response = await send(refreshed);
      if (response?.status === 401) await auth.rejectCredentials?.(refreshed.generation);
    }
    return response;
  };
}

function createCodexStructuredAdapter(config = {}, dependencies = {}) {
  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : 'gpt-5.6-luna';
  const timeoutMs = timeoutValue(config.timeoutMs, 120000);
  const maxImageBytes = timeoutValue(config.maxImageBytes, 2 * 1024 * 1024);
  const auth = dependencies.auth;
  const schemaRegistry = dependencies.schemaRegistry || defaultSchemaRegistry;
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;
  const tracer = dependencies.tracer || (() => {});
  const now = dependencies.now || Date.now;
  const setTimer = dependencies.setTimer || setTimeout;
  const clearTimer = dependencies.clearTimer || clearTimeout;
  const recordUsage = typeof dependencies.recordUsage === 'function' ? dependencies.recordUsage : () => {};
  const version = typeof config.appVersion === 'string' && config.appVersion ? config.appVersion : 'unknown';
  const userAgent = `GatherLocal/${version} (${os.platform()} ${os.release()}; ${os.arch()})`;

  function record(outcome, usage) {
    try {
      recordUsage({
        provider: PROVIDER, model, capability: CAPABILITIES.STRUCTURED_JSON,
        outcome, usage, usageFormat: 'ai-sdk',
      });
    } catch {}
  }

  function configured() {
    return Boolean(auth && typeof auth.credentials === 'function');
  }

  async function sdk() {
    if (dependencies.sdk) return dependencies.sdk;
    const [{ createOpenAI }, ai] = await Promise.all([
      Promise.resolve().then(() => require('@ai-sdk/openai')),
      Promise.resolve().then(() => require('ai')),
    ]);
    return { createOpenAI, streamText: ai.streamText, Output: ai.Output, jsonSchema: ai.jsonSchema };
  }

  async function completeJson({ system = '', input = '', imagePath, outputSchema, signal } = {}) {
    const deadline = now() + timeoutMs;
    const requestController = new AbortController();
    let timedOut = false;
    const onAbort = () => requestController.abort(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    const timeout = setTimer(() => {
      timedOut = true;
      requestController.abort(new Error('deadline'));
    }, timeoutMs);
    const unregister = auth?.registerRequestController?.(requestController) || (() => {});
    const cleanup = () => {
      clearTimer(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      unregister();
    };
    try {
    if (!configured()) {
      throw runtimeError('AI_AUTH_REQUIRED', 'Codex sign in required', {
        capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, setupAction: 'sign-in',
      });
    }
    try { schemaRegistry.validator(outputSchema); } catch (cause) {
      throw runtimeError('AI_INVALID_RESPONSE', 'Structured JSON schema is required', {
        capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: false, cause,
      });
    }
    await auth.credentials({ signal: requestController.signal, deadline });
    const loaded = await sdk();
    if (requestController.signal.aborted) throw requestController.signal.reason;
    const promptText = typeof input === 'string' ? input : JSON.stringify(input ?? '');
    const prompt = imagePath ? undefined : promptText;
    const messages = imagePath ? [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        {
          type: 'image',
          image: await waitWithSignal(
            boundedJpegDataUrl(
              imagePath,
              { maxBytes: maxImageBytes, provider: PROVIDER },
              dependencies,
            ),
            requestController.signal,
          ),
        },
      ],
    }] : undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = randomUUID();
      let sent = false;
      let observedUsage;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw runtimeError('AI_TIMEOUT', 'Codex request timed out', {
          capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: true,
        });
      }
      try {
        tracer({ event: 'attempt', sessionId, attempt });
        const codexFetch = createCodexFetch({
          auth,
          fetchImpl: dependencies.fetch || globalThis.fetch,
          sessionId,
          userAgent,
          signal: requestController.signal,
          deadline,
          tracer,
          onSend: () => { sent = true; },
        });
        const openai = loaded.createOpenAI({ apiKey: 'oauth-dummy', fetch: codexFetch });
        const result = loaded.streamText({
          model: openai.responses(model),
          system: typeof system === 'string' ? system : JSON.stringify(system ?? ''),
          ...(messages ? { messages } : { prompt }),
          output: loaded.Output.object({ schema: loaded.jsonSchema(outputSchema) }),
          maxRetries: 0,
          abortSignal: requestController.signal,
          timeout: remaining,
          providerOptions: { openai: { store: false, reasoningEffort: 'low' } },
          onError: () => {},
        });
        const [outputResult, usageResult] = await Promise.allSettled([
          result.output,
          result.totalUsage,
        ]);
        if (usageResult.status === 'fulfilled') observedUsage = usageResult.value;
        if (outputResult.status === 'rejected') throw outputResult.reason;
        const value = outputResult.value;
        const validation = schemaRegistry.validate(outputSchema, value);
        if (!validation.ok) throw runtimeError('AI_INVALID_RESPONSE', 'Codex returned invalid structured JSON', {
          capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: attempt === 0,
        });
        if (sent) record('succeeded', observedUsage);
        return value;
      } catch (cause) {
        if (sent) record('failed', observedUsage);
        if (timedOut || /TimeoutError/i.test(String(cause?.name || ''))) {
          throw runtimeError('AI_TIMEOUT', 'Codex request timed out', {
            capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: true, cause,
          });
        }
        if (requestController.signal.aborted || signal?.aborted || cause?.name === 'AbortError') {
          throw runtimeError('AI_ABORTED', 'Codex request was aborted', {
            capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: false, cause,
          });
        }
        const errorName = String(cause?.name || '').replace(/[^a-z]/gi, '');
        const invalid = cause?.code === 'AI_INVALID_RESPONSE'
          || /parse|schema|json|output|noobjectgenerated|typevalidation/i.test(errorName);
        if (invalid && attempt === 0 && now() < deadline) continue;
        if (cause?.code?.startsWith?.('AI_')) throw cause;
        const status = Number(cause?.statusCode || cause?.status);
        const providerCode = String(cause?.data?.error?.code || cause?.code || '');
        const modelMissing = /model.*(not.found|unsupported|missing)|unsupported.*model/i.test(
          `${providerCode} ${cause?.message || ''}`,
        );
        const code = status === 401 ? 'AI_AUTH_REQUIRED'
          : status === 403 ? 'AI_PROVIDER_FORBIDDEN'
            : modelMissing ? 'AI_MODEL_MISSING' : 'AI_PROVIDER_UNAVAILABLE';
        const retryAfter = cause?.responseHeaders?.['retry-after']
          || cause?.responseHeaders?.get?.('retry-after') || null;
        throw runtimeError(code,
          code === 'AI_AUTH_REQUIRED' ? 'Codex sign in required'
            : code === 'AI_PROVIDER_FORBIDDEN' ? 'Codex request is forbidden'
              : code === 'AI_MODEL_MISSING' ? 'Codex model is unavailable' : 'Codex request failed', {
            capability: CAPABILITIES.STRUCTURED_JSON,
            provider: PROVIDER,
            retryable: code === 'AI_PROVIDER_UNAVAILABLE',
            setupAction: code === 'AI_AUTH_REQUIRED' ? 'sign-in' : null,
            ...(status === 429 && retryAfter ? { retryAfter } : {}),
            cause,
          });
      }
    }
    throw runtimeError('AI_INVALID_RESPONSE', 'Codex returned invalid structured JSON', {
      capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: false,
    });
    } catch (cause) {
      if (cause?.code?.startsWith?.('AI_')) throw cause;
      if (timedOut || /TimeoutError/i.test(String(cause?.name || ''))) {
        throw runtimeError('AI_TIMEOUT', 'Codex request timed out', {
          capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: true, cause,
        });
      }
      if (requestController.signal.aborted || signal?.aborted || cause?.name === 'AbortError') {
        throw runtimeError('AI_ABORTED', 'Codex request was aborted', {
          capability: CAPABILITIES.STRUCTURED_JSON, provider: PROVIDER, retryable: false, cause,
        });
      }
      throw cause;
    } finally { cleanup(); }
  }

  return {
    id: PROVIDER,
    model,
    isConfigured: configured,
    isUsable() {
      return auth?.snapshot?.().state === 'authenticated';
    },
    async health() {
      const status = auth?.snapshot?.() || { state: 'unavailable' };
      return { ok: status.state === 'authenticated', provider: PROVIDER, model, authState: status.state };
    },
    completeJson,
  };
}

module.exports = {
  CODEX_ENDPOINT, PROVIDER, SOURCE_ENDPOINT, createCodexStructuredAdapter, createCodexFetch,
};
