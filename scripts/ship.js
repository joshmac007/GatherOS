#!/usr/bin/env node
// Single-command release: kill running app instances (so the
// smoke-test doesn't bail on the single-instance lock), bump
// the patch version (commits + tags), push main + the new tag,
// then run the existing release pipeline. Stop on first
// failure. GH_TOKEN must be in the environment (the project's
// ~/.zshrc setup pulls it from macOS Keychain).
//
//   npm run ship                  # patch bump (0.2.2 → 0.2.3)
//   npm run ship -- minor         # minor bump (0.2.2 → 0.3.0)
//   npm run ship -- major         # major bump

const { execSync } = require('node:child_process');

function step(label, cmd, opts = {}) {
  process.stdout.write(`\n▸ ${label}\n  $ ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function quietKill(pattern) {
  try { execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: 'ignore' }); }
  catch { /* pkill exits non-zero if nothing matched — fine */ }
}

if (!process.env.GH_TOKEN) {
  console.error('\n✗ GH_TOKEN not set. Open a fresh terminal — your ~/.zshrc should auto-load it from Keychain.\n');
  process.exit(1);
}

const bumpKind = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bumpKind)) {
  console.error(`\n✗ unknown bump kind: ${bumpKind}. Use patch, minor, or major.\n`);
  process.exit(1);
}

// Kill any running GatherOS instance so the smoke test step in
// `npm run release` doesn't trip on the single-instance lock.
quietKill('GatherOS.app');
quietKill('Electron.app/Contents/MacOS/Electron');
try { execSync('osascript -e \'quit app "GatherOS"\'', { stdio: 'ignore' }); }
catch { /* not running — fine */ }

step('bump version', `npm version ${bumpKind}`);
step('push main + tag', 'git push origin main --follow-tags');
step('build, notarize, publish', 'npm run release');

console.log('\n✓ release published.\n');
