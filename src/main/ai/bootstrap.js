'use strict';

const { createAiRuntime } = require('./runtime');
const { createGatherOsProxyAdapter } = require('./providers/gatheros-proxy');
const { createGatherLocalRoutes } = require('../gatherlocal/ai');

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
  gatherLocalOptions = {},
} = {}) {
  const proxy = proxyAdapter || createGatherOsProxyAdapter(proxyOptions);
  return createAiRuntime({
    authorize,
    routes: routes || createGatherLocalRoutes({
      ...gatherLocalOptions,
      proxyAdapter: proxy,
    }),
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
