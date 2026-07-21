'use strict';

const {
  AiRuntimeError,
  CODES,
  toAiRuntimeError,
} = require('./errors');

const CAPABILITIES = Object.freeze({
  STRUCTURED_JSON: 'structured-json',
  EMBEDDING: 'embedding',
  IMAGE_GENERATION: 'image-generation',
});

const CAPABILITY_LIST = Object.values(CAPABILITIES);

function providerId(adapter) {
  return adapter?.id || null;
}

function assertCapability(capability) {
  if (!CAPABILITY_LIST.includes(capability)) {
    throw new TypeError(`Unknown AI capability: ${capability}`);
  }
}

function createAiRuntime({ authorize, routes = {} } = {}) {
  if (typeof authorize !== 'function') {
    throw new TypeError('AI runtime requires an authorization function');
  }
  const routeMap = Object.create(null);
  for (const capability of CAPABILITY_LIST) {
    routeMap[capability] = routes?.[capability] || null;
  }

  function routeFor(capability) {
    assertCapability(capability);
    return routeMap[capability];
  }

  function isConfigured(capability) {
    const adapter = routeFor(capability);
    if (!adapter) return false;
    try {
      return typeof adapter.isConfigured === 'function' ? Boolean(adapter.isConfigured()) : true;
    } catch {
      return false;
    }
  }

  function isUsable(capability) {
    const adapter = routeFor(capability);
    if (!adapter || !isConfigured(capability)) return false;
    if (typeof adapter.isUsable !== 'function') return true;
    try { return Boolean(adapter.isUsable()); } catch { return false; }
  }

  function providerFor(capability) {
    return providerId(routeFor(capability));
  }

  function modelFor(capability) {
    const model = routeFor(capability)?.model;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  }

  function unconfigured(capability, adapter = routeFor(capability)) {
    return new AiRuntimeError(CODES.CAPABILITY_UNCONFIGURED, `AI capability ${capability} is not configured`, {
      capability,
      provider: providerId(adapter),
    });
  }

  async function health(capability, options = {}) {
    const adapter = routeFor(capability);
    if (!adapter || !isConfigured(capability)) throw unconfigured(capability, adapter);
    if (typeof adapter.health !== 'function') {
      return { ok: true, capability, provider: providerId(adapter) };
    }
    try {
      const result = await adapter.health(options);
      if (result === true || result == null) return { ok: true, capability, provider: providerId(adapter) };
      if (typeof result === 'object') {
        return { ...result, ok: result.ok !== false, capability, provider: result.provider || providerId(adapter) };
      }
      return { ok: Boolean(result), capability, provider: providerId(adapter) };
    } catch (error) {
      throw toAiRuntimeError(error, { capability, provider: providerId(adapter) });
    }
  }

  async function authorizeExecution(capability, adapter) {
    try {
      const decision = await authorize({ capability, provider: providerId(adapter) });
      const allowed = typeof decision === 'object' && decision !== null
        ? decision.proUnlocked ?? decision.allowed ?? decision.entitled
        : decision;
      if (allowed === false) {
        throw new AiRuntimeError(CODES.NOT_ENTITLED, 'AI use requires an entitled account', {
          capability,
          provider: providerId(adapter),
        });
      }
      if (allowed == null) {
        throw new AiRuntimeError(CODES.NOT_ENTITLED, 'AI use requires an entitled account', {
          capability,
          provider: providerId(adapter),
        });
      }
    } catch (error) {
      throw toAiRuntimeError(error, { capability, provider: providerId(adapter) });
    }
  }

  async function execute(capability, method, request) {
    const adapter = routeFor(capability);
    if (!adapter || !isConfigured(capability)) throw unconfigured(capability, adapter);
    if (typeof adapter[method] !== 'function') {
      throw unconfigured(capability, adapter);
    }
    await authorizeExecution(capability, adapter);
    try {
      return await adapter[method](request || {});
    } catch (error) {
      throw toAiRuntimeError(error, { capability, provider: providerId(adapter) });
    }
  }

  async function getUsage(capability = CAPABILITIES.STRUCTURED_JSON, options = {}) {
    // Usage is inspection, not inference: it remains available for health/UI
    // surfaces without entitlement. It still follows exactly one explicit
    // capability route; never silently switch providers/capabilities.
    const adapter = routeFor(capability);
    if (!adapter || typeof adapter.getUsage !== 'function' || !isConfigured(capability)) return null;
    try {
      return await adapter.getUsage(options);
    } catch (error) {
      throw toAiRuntimeError(error, { capability, provider: providerId(adapter) });
    }
  }

  const runtime = {
    capabilities: CAPABILITIES,
    isConfigured,
    isUsable,
    providerFor,
    modelFor,
    health,
    completeJson: (request) => execute(CAPABILITIES.STRUCTURED_JSON, 'completeJson', request),
    embed: (request) => execute(CAPABILITIES.EMBEDDING, 'embed', request),
    generateImage: (request) => execute(CAPABILITIES.IMAGE_GENERATION, 'generateImage', request),
    getUsage,
  };

  return runtime;
}

module.exports = {
  CAPABILITIES,
  createAiRuntime,
};
