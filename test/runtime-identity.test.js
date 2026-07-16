'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const identity = require('../src/shared/runtime-identity');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function extensionId(publicKeyBase64) {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest()
    .subarray(0, 16);
  return Array.from(digest, (byte) => (
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))
  )).join('');
}

function filesUnder(relativeDirectory) {
  const root = path.join(ROOT, relativeDirectory);
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else result.push(full);
    }
  };
  visit(root);
  return result;
}

test('runtime identity is distinct from every GatherOS external route', () => {
  assert.deepEqual(identity.EXTENSION_IDS, ['ffeaogljbgkjmbjkbpdfhdcdlomlbbpe']);
  assert.equal(identity.APP_NAME, 'GatherLocal');
  assert.equal(identity.APP_ID, 'com.gatherlocal.app');
  assert.equal(identity.URL_SCHEME, 'gatherlocal');
  assert.equal(identity.NATIVE_HOST_NAME, 'co.gatherlocal.host');
  assert.equal(identity.CAPTURE_HOST, '127.0.0.1');
  assert.equal(identity.CAPTURE_PORT, 53248);
  assert.equal(identity.BACKGROUND_LAUNCH_ARG, '--gatherlocal-bg');
  assert.equal(
    identity.defaultUserDataDir({ platform: 'darwin', home: '/Users/test' }),
    '/Users/test/Library/Application Support/GatherLocal',
  );
  assert.notEqual(identity.NATIVE_HOST_NAME, 'co.gatheros.host');
  assert.notEqual(identity.CAPTURE_PORT, 53247);
});

test('extension public key creates only the GatherLocal extension ID', async () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const browserIdentity = await import(pathToFileURL(path.join(ROOT, 'extension/identity.mjs')));
  const id = extensionId(manifest.key);

  assert.equal(manifest.name, 'GatherLocal');
  assert.equal(manifest.action.default_title, 'GatherLocal');
  assert.equal(id, identity.EXTENSION_IDS[0]);
  assert.equal(browserIdentity.APP_NAME, identity.APP_NAME);
  assert.equal(browserIdentity.NATIVE_HOST_NAME, identity.NATIVE_HOST_NAME);
  assert.notEqual(id, 'dopoibgdcokjffklnmechmboglnfihlc');
  assert.notEqual(id, 'jflmnonpoapjncoeankehcmenldecojk');

  const extensionText = filesUnder('extension')
    .filter((file) => /\.(?:js|mjs|json)$/.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(extensionText, /co\.gatheros\.host/);
  assert.doesNotMatch(extensionText, /GatherOS/);
});

test('desktop, native host, packaging, and updater cannot claim GatherOS identity', async () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'gatherlocal');
  assert.equal(pkg.productName, identity.APP_NAME);
  assert.equal(pkg.version, '0.7.0-local.1');
  assert.doesNotMatch(pkg.scripts.release, /publish always/);

  const builder = read('electron-builder.yml');
  assert.match(builder, /^appId: com\.gatherlocal\.app$/m);
  assert.match(builder, /^productName: GatherLocal$/m);
  assert.match(builder, /^\s+- gatherlocal$/m);
  assert.match(builder, /^publish: null$/m);
  assert.doesNotMatch(builder, /BrettfromDJ|com\.gatheros\.app/);

  const installer = read('src/main/native-host-installer.js');
  assert.match(installer, /GATHERLOCAL_SKIP_NATIVE_HOST_INSTALL/);
  assert.match(installer, /GATHERLOCAL_BINARY/);
  assert.match(installer, /GATHERLOCAL_USER_DATA_DIR/);
  assert.doesNotMatch(installer, /co\.gatheros\.host|GATHEROS_BINARY|jflmnon|dopoib/);

  const host = read('src/main/native-host.js');
  assert.match(host, /GATHERLOCAL_BINARY/);
  assert.match(host, /GATHERLOCAL_USER_DATA_DIR/);
  assert.doesNotMatch(host, /53247|--gatheros-bg|GATHEROS_BINARY|GATHEROS_APP_PATH/);

  const server = require('../src/main/extension-server');
  assert.equal(server.PORT, identity.CAPTURE_PORT);

  const updater = require('../src/main/updater');
  assert.deepEqual(await updater.checkNow(), {
    unsupported: true,
    reason: 'source_sync_only',
  });
  assert.doesNotMatch(read('src/main/updater.js'), /electron-updater|BrettfromDJ/);

  assert.match(read('scripts/smoke-test.js'), /GATHERLOCAL_SKIP_NATIVE_HOST_INSTALL/);
  assert.match(read('scripts/smoke-test.js'), /GATHERLOCAL_SKIP_PROTOCOL_REGISTRATION/);
  assert.match(read('scripts/smoke-test.js'), /GATHERLOCAL_LOG_DIR/);
  assert.match(read('scripts/smoke-test.js'), /GatherLocal\.app/);
  assert.match(read('scripts/pack-extension.js'), /gatherlocal-extension\.zip/);
  assert.doesNotMatch(read('scripts/pack-extension.js'), /delete manifest\.key|gatheros-extension/);
  assert.doesNotMatch(read('scripts/build-starter-pack.js'), /Application Support.*GatherOS|gatheros-starter/);
  assert.doesNotMatch(read('scripts/notarize.js'), /GatherOS-Notarize/);
  assert.doesNotMatch(read('scripts/predev.js'), /quit app "GatherOS"|Electron\.app\/Contents\/MacOS\/Electron/);

  assert.match(read('src/renderer/index.html'), /<title>GatherLocal<\/title>/);
  assert.match(read('src/renderer/toast.html'), /<title>GatherLocal toast<\/title>/);
  assert.doesNotMatch(read('src/renderer/index.html'), /GatherOS/);
  assert.doesNotMatch(read('src/renderer/toast.html'), /GatherOS/);

});
