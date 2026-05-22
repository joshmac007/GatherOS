#!/usr/bin/env node
//
// Pack extension/ into a Chrome Web Store-uploadable zip.
//
// Strips the `key` field from manifest.json on the way out. The key
// is required in the unpacked dev extension to pin the dev ID
// (dopoibgdcokjffklnmechmboglnfihlc) — but the Chrome Web Store
// rejects uploads that contain it, since the store generates IDs
// itself. Keeping the key in the repo and stripping it here means
// both flows work without manual file shuffling.
//
// Usage:
//   npm run pack:extension
//   → writes dist/gatheros-extension.zip
//   → upload that file in the Web Store Developer Dashboard

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');
const STAGE = path.join(OUT_DIR, 'extension-staging');
const OUT_ZIP = path.join(OUT_DIR, 'gatheros-extension.zip');

if (!fs.existsSync(SRC)) {
  console.error(`[pack-extension] not found: ${SRC}`);
  process.exit(1);
}

// Fresh staging dir.
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(SRC, STAGE, { recursive: true });

// Strip the dev-only `key` field. The store rejects uploads with it.
const manifestPath = path.join(STAGE, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if ('key' in manifest) {
  delete manifest.key;
  console.log('[pack-extension] stripped `key` field from manifest');
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Clean previous zip + zip from inside the staging dir so the zip's
// top level is manifest.json + the rest (no parent folder, which
// some uploaders treat as a packaging error).
fs.rmSync(OUT_ZIP, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const result = spawnSync('zip', ['-rq', OUT_ZIP, '.'], {
  cwd: STAGE,
  stdio: 'inherit',
});

fs.rmSync(STAGE, { recursive: true, force: true });

if (result.status !== 0) {
  console.error('[pack-extension] zip failed');
  process.exit(result.status || 1);
}

const size = fs.statSync(OUT_ZIP).size;
console.log(`[pack-extension] wrote ${OUT_ZIP} (${Math.round(size / 1024)} KB)`);
console.log('[pack-extension] upload this file in the Chrome Web Store Developer Dashboard.');
