'use strict';

const { createAiRuntime } = require('./runtime');
const { createGatherLocalRoutes } = require('../gatherlocal/ai');
const { createGatherLocalAuthorization } = require('../gatherlocal/ai/authorization');

let cachedRuntime = null;

const defaultAuthorize = createGatherLocalAuthorization();

function createDefaultAiRuntime({
  authorize = defaultAuthorize,
  routes = null,
  gatherLocalOptions = {},
} = {}) {
  return createAiRuntime({
    authorize,
    routes: routes || createGatherLocalRoutes(gatherLocalOptions),
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
