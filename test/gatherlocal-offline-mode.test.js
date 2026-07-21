'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('GatherOS account, entitlement, announcement, and proxy modules are absent', () => {
  for (const relativePath of [
    'src/main/licensing.js',
    'src/main/entitlement.js',
    'src/main/announcement.js',
    'src/main/ai/providers/gatheros-proxy.js',
    'src/shared/licensing-config.js',
    'src/renderer/hooks/useLicense.js',
    'src/renderer/hooks/useEntitlement.js',
    'src/renderer/context/entitlement.jsx',
    'src/renderer/components/SigninScreen.jsx',
    'src/renderer/components/UpgradeModal.jsx',
    'src/renderer/components/UpgradeBanner.jsx',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }
});

test('runtime composition has no GatherOS server or free-plan save path', () => {
  const main = [
    'src/main/index.js',
    'src/main/ipc.js',
    'src/main/preload.js',
    'src/main/capture.js',
    'src/main/extension-server.js',
    'src/main/ai/bootstrap.js',
    'src/main/gatherlocal/ai/index.js',
  ].map(read).join('\n');

  assert.doesNotMatch(main, /api\.gatheros\.co|gatheros-proxy/);
  assert.doesNotMatch(main, /licensing:|entitlement:get|canCreateSave|needsUpgrade/);
  assert.doesNotMatch(main, /announcement:get|fetchAnnouncement/);
});

test('renderer exposes local app and local AI without account or upgrade UI', () => {
  const renderer = [
    'src/renderer/AppGate.jsx',
    'src/renderer/App.jsx',
    'src/renderer/components/SettingsModal.jsx',
  ].map(read).join('\n');

  assert.doesNotMatch(renderer, /requestUpgrade|UpgradeModal|UpgradeBanner/);
  assert.doesNotMatch(renderer, /moodmark\.licensing|Sign in|Manage subscription|Free plan/);
  assert.match(read('src/renderer/components/SettingsModal.jsx'), /label: 'Local AI'/);
});

test('proxy cannot be selected through GatherLocal AI configuration', () => {
  const { readGatherLocalAiConfig } = require('../src/main/gatherlocal/ai/config');
  assert.throws(
    () => readGatherLocalAiConfig({ GATHERLOCAL_AI_STRUCTURED_PROVIDER: 'proxy' }),
    /must be one of: codex, local/,
  );
  assert.throws(
    () => readGatherLocalAiConfig({ GATHERLOCAL_AI_EMBEDDING_PROVIDER: 'proxy' }),
    /must be one of: ollama/,
  );
  assert.throws(
    () => readGatherLocalAiConfig({ GATHERLOCAL_AI_IMAGE_PROVIDER: 'proxy' }),
    /must be one of: disabled/,
  );
});

test('Electron installs post-ready AI backend before runtime consumers', () => {
  const main = read('src/main/index.js');
  const ready = main.indexOf('app.whenReady().then');
  const backend = main.indexOf('createPostReadyAiBackend', ready);
  const runtime = main.indexOf('getAiRuntime()', ready);
  const ipc = main.indexOf('registerIpcHandlers({', ready);
  assert.ok(ready >= 0 && backend > ready);
  assert.ok(runtime > backend);
  assert.ok(ipc > runtime);
  assert.match(main, /codexAuth\?\.dispose\(\)/);
  assert.match(main, /getAiRuntime\(\)\.isUsable\(CAPABILITIES\.STRUCTURED_JSON\)/);
  assert.match(main, /hasProvider: \(\) => aiRuntime\.isUsable\(CAPABILITIES\.STRUCTURED_JSON\)/);
  assert.doesNotMatch(main, /isConfigured\(CAPABILITIES\.STRUCTURED_JSON\)/);
});

test('privacy surfaces document encrypted OAuth boundaries without custom callback', () => {
  for (const relativePath of [
    'PRIVACY.md',
    'marketing/privacy.html',
    'docs/gatherlocal-offline-mode.md',
  ]) {
    const text = read(relativePath);
    assert.match(text, /GatherLocal/);
    assert.match(text, /safeStorage/);
    assert.match(text, /macOS Keychain/);
    assert.match(text, /auth\.openai\.com/);
    assert.match(text, /chatgpt\.com/);
  }
  assert.match(read('docs/gatherlocal-offline-mode.md'), /http:\/\/localhost:1455\/auth\/callback/);
  assert.doesNotMatch(read('src/main/index.js'), /gatherlocal:\/\/.*auth/i);
});

test('renderer gates ChatGPT connection UI to Codex provider and subscribes app-wide', () => {
  const app = read('src/renderer/App.jsx');
  const settings = read('src/renderer/components/SettingsModal.jsx');
  assert.match(app, /ai\.auth\?\.onStatus/);
  assert.match(settings, /provider === 'codex'/);
  for (const state of [
    'loading', 'signed_out', 'authorizing', 'exchanging',
    'authenticated', 'corrupt', 'unavailable',
  ]) assert.match(settings, new RegExp(`${state}:|'${state}'`));
  assert.doesNotMatch(settings, /API key|model picker/i);
});

test('final Codex composition contains no staged provider or child-process route', () => {
  const owned = [
    'src/main/index.js',
    'src/main/ipc.js',
    'src/main/preload.js',
    'src/main/openai.js',
    'src/renderer/App.jsx',
    'src/renderer/components/SettingsModal.jsx',
    'docs/gatherlocal-offline-mode.md',
  ].map(read).join('\n');
  const stagedProvider = ['codex', 'direct'].join('-');
  const stagedEnv = ['CODEX', 'DIRECT'].join('_');
  const serverTransport = ['app', 'server'].join('-');
  assert.doesNotMatch(owned, new RegExp(`${stagedProvider}|${stagedEnv}|${serverTransport}`, 'i'));

  const config = read('src/main/gatherlocal/ai/config.js');
  const removedConfig = new RegExp(`GATHERLOCAL_CODEX_(?:${['BIN', 'CWD'].join('|')})|CODEX_${['APP', 'SERVER'].join('_')}`);
  assert.doesNotMatch(config, removedConfig);
  const routes = read('src/main/gatherlocal/ai/index.js');
  assert.doesNotMatch(routes, /child_process|spawn(?:Sync)?\s*\(/);
});

test('acknowledgments pin OpenCode source and name structured AI dependencies', () => {
  for (const relativePath of ['ACKNOWLEDGMENTS.md', 'src/renderer/data/acknowledgments.js']) {
    const text = read(relativePath);
    assert.match(text, /849c2598abc7d2b40261e74b5826bc74ffc78308/);
    assert.match(text, /@ai-sdk\/openai/);
    assert.match(text, /Ajv/);
    assert.match(text, /AI SDK/);
    assert.match(text, /packages\/opencode\/src\/plugin\/openai\/codex\.ts/);
  }
});
