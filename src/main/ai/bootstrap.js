'use strict';

const path = require('node:path');
const { createAiRuntime } = require('./runtime');
const { createGatherLocalRoutes } = require('../gatherlocal/ai');
const { createGatherLocalAuthorization } = require('../gatherlocal/ai/authorization');
const { readGatherLocalAiConfig, CAPABILITIES } = require('../gatherlocal/ai/config');
const { createEncryptedAuthVault } = require('../gatherlocal/ai/codex-auth-vault');
const { createCodexOAuthAuth } = require('../gatherlocal/ai/codex-oauth');

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

function installAiRuntime(runtime) {
  if (!runtime || typeof runtime.completeJson !== 'function') {
    throw new TypeError('Installed AI runtime must implement completeJson');
  }
  cachedRuntime = runtime;
  return cachedRuntime;
}

/** Call only after Electron app ready. Definitions remain safe during module load. */
function createPostReadyAiBackend({
  app,
  safeStorage,
  env = process.env,
  authorize = defaultAuthorize,
  dependencies = {},
} = {}) {
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Post-ready AI backend requires Electron app');
  const vault = createEncryptedAuthVault({
    safeStorage,
    filePath: path.join(app.getPath('userData'), 'codex-auth.vault'),
    fileSystem: dependencies.fileSystem,
  });
  const codexAuth = createCodexOAuthAuth({
    vault,
    fetchImpl: dependencies.fetch,
    createServer: dependencies.createServer,
    now: dependencies.now,
    randomBytes: dependencies.randomBytes,
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
    tracer: dependencies.tracer,
  });
  codexAuth.initialize();
  const config = readGatherLocalAiConfig(env);
  config.codex.appVersion = typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
  const routes = createGatherLocalRoutes({
    config,
    dependencies: {
      ...dependencies,
      codex: { ...dependencies.codex, auth: codexAuth },
    },
  });
  const runtime = installAiRuntime(createAiRuntime({ authorize, routes }));
  return {
    runtime,
    codexAuth,
    vault,
    codexSelected: config.routes[CAPABILITIES.STRUCTURED_JSON] === 'codex',
  };
}

module.exports = {
  createDefaultAiRuntime,
  createPostReadyAiBackend,
  getAiRuntime,
  installAiRuntime,
};
