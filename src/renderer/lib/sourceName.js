// host → { name shown to the user, favicon host to query Google's S2 endpoint }
const KNOWN_SITES = {
  'pbs.twimg.com': { name: 'X (Twitter)', favicon: 'x.com' },
  'twitter.com':   { name: 'X (Twitter)', favicon: 'x.com' },
  'x.com':         { name: 'X (Twitter)', favicon: 'x.com' },

  'i.pinimg.com':  { name: 'Pinterest',   favicon: 'pinterest.com' },
  'pinterest.com': { name: 'Pinterest',   favicon: 'pinterest.com' },

  'assets.are.na': { name: 'Are.na',      favicon: 'are.na' },
  'are.na':        { name: 'Are.na',      favicon: 'are.na' },

  'substackcdn.com': { name: 'Substack',  favicon: 'substack.com' },
  'substack.com':    { name: 'Substack',  favicon: 'substack.com' },

  'imgur.com':   { name: 'Imgur',         favicon: 'imgur.com' },
  'i.imgur.com': { name: 'Imgur',         favicon: 'imgur.com' },

  'instagram.com':       { name: 'Instagram', favicon: 'instagram.com' },
  'cdninstagram.com':    { name: 'Instagram', favicon: 'instagram.com' },

  'fbcdn.net':   { name: 'Facebook', favicon: 'facebook.com' },

  'medium.com':                 { name: 'Medium', favicon: 'medium.com' },
  'cdn-images-1.medium.com':    { name: 'Medium', favicon: 'medium.com' },

  'unsplash.com':         { name: 'Unsplash', favicon: 'unsplash.com' },
  'images.unsplash.com':  { name: 'Unsplash', favicon: 'unsplash.com' },

  'behance.net':                  { name: 'Behance', favicon: 'behance.net' },
  'mir-s3-cdn-cf.behance.net':    { name: 'Behance', favicon: 'behance.net' },

  'dribbble.com':     { name: 'Dribbble', favicon: 'dribbble.com' },
  'cdn.dribbble.com': { name: 'Dribbble', favicon: 'dribbble.com' },

  'tumblr.com':       { name: 'Tumblr', favicon: 'tumblr.com' },
  'media.tumblr.com': { name: 'Tumblr', favicon: 'tumblr.com' },

  'reddit.com':      { name: 'Reddit', favicon: 'reddit.com' },
  'i.redd.it':       { name: 'Reddit', favicon: 'reddit.com' },
  'preview.redd.it': { name: 'Reddit', favicon: 'reddit.com' },
};

function infoFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (KNOWN_SITES[host]) return { ...KNOWN_SITES[host], host };
    for (const [domain, info] of Object.entries(KNOWN_SITES)) {
      if (host === domain || host.endsWith('.' + domain)) {
        return { ...info, host };
      }
    }
    return { host, name: host.replace(/^www\./, ''), favicon: host.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

export function sourceName(url) {
  const info = infoFor(url);
  return info ? info.name : url;
}

export function faviconHost(url) {
  const info = infoFor(url);
  return info ? info.favicon : null;
}
