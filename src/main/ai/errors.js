'use strict';

const CODES = Object.freeze({
  NOT_ENTITLED: 'AI_NOT_ENTITLED',
  CAPABILITY_UNCONFIGURED: 'AI_CAPABILITY_UNCONFIGURED',
  AUTH_REQUIRED: 'AI_AUTH_REQUIRED',
  PROVIDER_UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',
  MODEL_MISSING: 'AI_MODEL_MISSING',
  TIMEOUT: 'AI_TIMEOUT',
  ABORTED: 'AI_ABORTED',
  INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  EMBEDDING_DIMENSION_MISMATCH: 'AI_EMBEDDING_DIMENSION_MISMATCH',
});

const KNOWN_CODES = new Set(Object.values(CODES));

class AiRuntimeError extends Error {
  constructor(code, message, details = {}) {
    const {
      capability = null,
      provider = null,
      retryable = false,
      setupAction = null,
      cause = null,
      ...metadata
    } = details;
    super(message || code, cause ? { cause } : undefined);
    this.name = 'AiRuntimeError';
    this.code = code;
    this.capability = capability;
    this.provider = provider;
    this.retryable = Boolean(retryable);
    if (setupAction) this.setupAction = setupAction;
    if (cause) this.cause = cause;
    Object.assign(this, metadata);
  }
}

function isAiRuntimeError(error) {
  return error instanceof AiRuntimeError || (
    error && error.name === 'AiRuntimeError' && KNOWN_CODES.has(error.code)
  );
}

function codeFromError(error) {
  if (KNOWN_CODES.has(error?.code)) return error.code;
  switch (error?.code) {
    case 'unauthenticated':
    case 'auth_required':
      return CODES.AUTH_REQUIRED;
    case 'not_entitled':
      return CODES.NOT_ENTITLED;
    case 'monthly_cap_reached':
      return CODES.PROVIDER_UNAVAILABLE;
    case 'ollama_model_missing':
    case 'model_missing':
      return CODES.MODEL_MISSING;
    case 'ollama_embedding_dimension_mismatch':
    case 'embedding_dimension_mismatch':
      return CODES.EMBEDDING_DIMENSION_MISMATCH;
    case 'ollama_timeout':
    case 'timeout':
      return CODES.TIMEOUT;
    case 'ollama_unavailable':
    case 'local_ai_error':
    case 'upstream_network':
    case 'upstream_error':
      return CODES.PROVIDER_UNAVAILABLE;
    case 'ollama_invalid_response':
    case 'ollama_invalid_embedding':
    case 'upstream_response':
      return CODES.INVALID_RESPONSE;
    default:
      break;
  }
  if (error?.name === 'AbortError') return CODES.ABORTED;
  return null;
}

function toAiRuntimeError(error, context = {}) {
  if (isAiRuntimeError(error)) {
    if (error.capability || !context.capability) return error;
    return new AiRuntimeError(error.code, error.message, {
      capability: context.capability,
      provider: error.provider || context.provider || null,
      retryable: error.retryable,
      setupAction: error.setupAction,
      cause: error.cause || error,
    });
  }
  const code = codeFromError(error) || CODES.PROVIDER_UNAVAILABLE;
  return new AiRuntimeError(code, error?.message || String(error), {
    capability: context.capability || null,
    provider: context.provider || null,
    retryable: code === CODES.TIMEOUT || code === CODES.PROVIDER_UNAVAILABLE,
    setupAction: error?.setupAction || null,
    cause: error,
  });
}

module.exports = {
  AiRuntimeError,
  CODES,
  isAiRuntimeError,
  toAiRuntimeError,
};
