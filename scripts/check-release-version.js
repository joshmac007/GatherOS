// Pre-flight guard for `npm run release`. Checks GitHub's Releases
// API for the version currently in package.json. If a release with
// that tag already exists, fail fast — the build would otherwise
// finish, then silently skip every upload because electron-builder
// refuses to overwrite a published release.
//
// Skips when GH_TOKEN is unset (let electron-builder produce its
// usual error) or on network errors (don't block local-only builds).

const fs = require('node:fs');
const https = require('node:https');

const REPO = 'BrettfromDJ/gatheros';

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  return pkg.version;
}

function checkRelease(version, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/tags/v${version}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'gatheros-release-check',
        Accept: 'application/vnd.github+json',
      },
    }, (res) => {
      // Drain — we only need the status code.
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

(async () => {
  const version = readVersion();
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.warn('[release-check] GH_TOKEN not set — skipping pre-flight.');
    process.exit(0);
  }

  const status = await checkRelease(version, token);
  if (status === 404) {
    console.log(`[release-check] v${version} is fresh — proceeding.`);
    process.exit(0);
  }
  if (status === 200) {
    console.error('');
    console.error('  ✖  Cannot release.');
    console.error(`     v${version} already exists on https://github.com/${REPO}/releases`);
    console.error('     Bump the version first:');
    console.error('');
    console.error(`         npm version <next-version> --no-git-tag-version`);
    console.error(`         git add package.json && git commit -m "release: v<next>"`);
    console.error(`         git tag v<next> && git push origin v<next>`);
    console.error('');
    process.exit(1);
  }
  if (status === 401) {
    console.error('[release-check] GH_TOKEN is invalid or revoked — replace it before running release.');
    process.exit(1);
  }
  console.warn(`[release-check] unexpected status ${status ?? 'network-error'} — proceeding anyway.`);
  process.exit(0);
})();
