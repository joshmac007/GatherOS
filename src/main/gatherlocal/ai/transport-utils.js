'use strict';

const { AiRuntimeError } = require('../../ai/errors');

function runtimeError(code, message, details = {}) {
  return new AiRuntimeError(code, message, details);
}

function timeoutValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function composeSignal(signal, timeoutMs, dependencies = {}) {
  const AbortControllerImpl = dependencies.AbortController || AbortController;
  const setTimeoutImpl = dependencies.setTimeout || setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeout || clearTimeout;
  const controller = new AbortControllerImpl();
  let timedOut = false;
  let callerAborted = Boolean(signal?.aborted);
  let timeoutId = null;
  let removeListener = () => {};

  if (callerAborted) {
    controller.abort(signal.reason);
  } else if (signal && typeof signal.addEventListener === 'function') {
    const onAbort = () => {
      callerAborted = true;
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  }

  const duration = timeoutValue(timeoutMs, 30000);
  timeoutId = setTimeoutImpl(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, duration);

  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get callerAborted() { return callerAborted; },
    cleanup() {
      if (timeoutId !== null) clearTimeoutImpl(timeoutId);
      removeListener();
    },
  };
}

function abortError(context, composed) {
  if (composed.timedOut) {
    return runtimeError(
      'AI_TIMEOUT',
      `${context.provider} request timed out`,
      { capability: context.capability, provider: context.provider, retryable: true },
    );
  }
  if (composed.callerAborted) {
    return runtimeError(
      'AI_ABORTED',
      `${context.provider} request was aborted`,
      { capability: context.capability, provider: context.provider, retryable: false },
    );
  }
  return null;
}

async function responseBody(response) {
  if (typeof response?.text === 'function') {
    const raw = await response.text();
    if (!raw) return { data: null, raw, invalidJson: false };
    try {
      return { data: JSON.parse(raw), raw, invalidJson: false };
    } catch {
      return { data: null, raw, invalidJson: true };
    }
  }
  try {
    return { data: await response.json(), raw: '', invalidJson: false };
  } catch {
    return { data: null, raw: '', invalidJson: true };
  }
}

function httpCode(status) {
  if (status === 401 || status === 403) return 'AI_AUTH_REQUIRED';
  if (status === 408 || status === 429 || status >= 500) return 'AI_PROVIDER_UNAVAILABLE';
  return 'AI_INVALID_RESPONSE';
}

async function requestJson({
  fetchImpl = globalThis.fetch,
  url,
  options = {},
  timeoutMs,
  signal,
  capability,
  provider,
  dependencies = {},
}) {
  if (typeof fetchImpl !== 'function') {
    throw runtimeError('AI_PROVIDER_UNAVAILABLE', 'AI transport requires fetch', {
      capability,
      provider,
      retryable: false,
    });
  }
  const composed = composeSignal(signal, timeoutMs, dependencies);
  try {
    const response = await fetchImpl(url, { ...options, signal: composed.signal });
    const body = await responseBody(response);
    if (!response.ok) {
      const detail = String(body.data?.error?.message || body.data?.error || body.raw || `HTTP ${response.status}`);
      const code = httpCode(response.status);
      throw runtimeError(code, `${provider} request failed: ${detail}`, {
        capability,
        provider,
        retryable: code === 'AI_PROVIDER_UNAVAILABLE',
        status: response.status,
      });
    }
    if (body.invalidJson) {
      throw runtimeError('AI_INVALID_RESPONSE', `${provider} returned invalid JSON`, {
        capability,
        provider,
        retryable: false,
      });
    }
    return body.data;
  } catch (cause) {
    const aborted = abortError({ capability, provider }, composed);
    if (aborted) {
      aborted.cause = cause;
      throw aborted;
    }
    if (cause?.name === 'AbortError') {
      throw runtimeError('AI_ABORTED', `${provider} request was aborted`, {
        capability,
        provider,
        retryable: false,
        cause,
      });
    }
    if (cause?.name === 'AiRuntimeError' || typeof cause?.code === 'string' && cause.code.startsWith('AI_')) {
      throw cause;
    }
    throw runtimeError('AI_PROVIDER_UNAVAILABLE', `${provider} is unavailable`, {
      capability,
      provider,
      retryable: true,
      cause,
    });
  } finally {
    composed.cleanup();
  }
}

function parseJsonObject(value, provider, capability) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw runtimeError('AI_INVALID_RESPONSE', `${provider} returned an empty response`, {
      capability,
      provider,
      retryable: false,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { parsed = JSON.parse(fenced[1]); } catch { parsed = null; }
    }
    if (!parsed) {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; }
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw runtimeError('AI_INVALID_RESPONSE', `${provider} response was not a JSON object`, {
      capability,
      provider,
      retryable: false,
    });
  }
  return parsed;
}

module.exports = {
  runtimeError,
  timeoutValue,
  composeSignal,
  requestJson,
  parseJsonObject,
};
