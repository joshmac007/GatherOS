'use strict';

const { createAiRuntime, CAPABILITIES } = require('./runtime');
const { createGatherOsProxyAdapter } = require('./providers/gatheros-proxy');

let cachedRuntime = null;

function defaultAuthorize() {
  // Require lazily: this module is also loaded by Node-focused tests where
  // Electron's licensing client is intentionally unavailable.
  const { getEntitlement } = require('../entitlement');
  return Boolean(getEntitlement()?.proUnlocked);
}

function createDefaultAiRuntime({
  authorize = defaultAuthorize,
  proxyAdapter = null,
  routes = null,
  proxyOptions = {},
} = {}) {
  const proxy = proxyAdapter || createGatherOsProxyAdapter(proxyOptions);
  return createAiRuntime({
    authorize,
    // One adapter may serve multiple capabilities. Image generation stays
    // disabled until composition explicitly selects that route.
    routes: routes || {
      [CAPABILITIES.STRUCTURED_JSON]: proxy,
      [CAPABILITIES.EMBEDDING]: proxy,
      [CAPABILITIES.IMAGE_GENERATION]: null,
    },
  });
}

function getAiRuntime(options) {
  if (!cachedRuntime) cachedRuntime = createDefaultAiRuntime(options);
  return cachedRuntime;
}

module.exports = {
  createDefaultAiRuntime,
  getAiRuntime,
};
