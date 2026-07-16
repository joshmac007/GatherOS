'use strict';

const { createAiRuntime } = require('./runtime');
const { createGatherOsProxyAdapter } = require('./providers/gatheros-proxy');
const { createGatherLocalRoutes } = require('../gatherlocal/ai');
const { createGatherLocalAuthorization } = require('../gatherlocal/ai/authorization');

let cachedRuntime = null;

const defaultAuthorize = createGatherLocalAuthorization();

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
