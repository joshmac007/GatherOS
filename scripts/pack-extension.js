#!/usr/bin/env node
//
// Pack extension/ into a local-install zip. The committed public key
// remains in manifest.json so every unpacked install keeps GatherLocal's
// dedicated extension ID.
//
// Usage:
//   npm run pack:extension
//   → writes dist/gatherlocal-extension.zip

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');
const STAGE = path.join(OUT_DIR, 'extension-staging');
const OUT_ZIP = path.join(OUT_DIR, 'gatherlocal-extension.zip');

if (!fs.existsSync(SRC)) {
  console.error(`[pack-extension] not found: ${SRC}`);
  process.exit(1);
}

// Fresh staging dir.
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(SRC, STAGE, { recursive: true });

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
console.log('[pack-extension] unzip, then load the folder from chrome://extensions.');
