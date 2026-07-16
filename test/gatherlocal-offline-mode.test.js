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
