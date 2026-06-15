// Stable download redirect for the marketing site.
//
// The site used to compute the latest release client-side by calling the
// GitHub API from the browser, then fall back to the Releases *page*
// when that call failed — which it often did (GitHub's unauthenticated
// API is ~60 req/hr per IP, so shared/corporate IPs and traffic spikes
// dumped users on GitHub instead of downloading). This resolves the
// latest .dmg server-side, edge-cached so we barely touch GitHub, and
// 302s straight to the file.
//
//   GET /download              → latest arm64 .dmg (Apple Silicon)
//   GET /download?arch=intel   → latest x64 .dmg (Intel)  [also ?arch=x64]
//
// On any failure it redirects to the Releases page rather than erroring.
// Registered as a direct route (app.get('/download', …)) so the bare
// path matches with no sub-router/trailing-slash ambiguity.

import type { Context } from 'hono';
import type { Env } from './types';

const REPO = 'brettfromdj/gatheros';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

type ReleaseAsset = { name: string; browser_download_url: string };

export async function downloadHandler(c: Context<{ Bindings: Env }>) {
  const arch = (c.req.query('arch') || '').toLowerCase();
  const wantIntel = arch === 'intel' || arch === 'x64' || arch === 'x86_64';

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'gatheros-download',
        Accept: 'application/vnd.github+json',
        // Optional: lifts the rate limit to 5000/hr if a token is set,
        // though edge caching below already keeps us well under 60/hr.
        ...(c.env.GITHUB_TOKEN ? { Authorization: `Bearer ${c.env.GITHUB_TOKEN}` } : {}),
      },
      // Cache the GitHub response at the edge so a burst of downloads
      // collapses to one upstream call every few minutes.
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) return c.redirect(RELEASES_PAGE, 302);

    const data = (await res.json()) as { assets?: ReleaseAsset[] };
    const dmgs = (data.assets || []).filter((a) => /\.dmg$/i.test(a.name));
    const arm = dmgs.find((a) => /arm64/i.test(a.name));
    const intel = dmgs.find((a) => !/arm64/i.test(a.name));
    const pick = wantIntel ? intel || arm : arm || intel || dmgs[0];

    return c.redirect(pick?.browser_download_url || RELEASES_PAGE, 302);
  } catch {
    return c.redirect(RELEASES_PAGE, 302);
  }
}
