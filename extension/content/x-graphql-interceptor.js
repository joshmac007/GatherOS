// MAIN-world script — runs in the same JavaScript context as
// twitter.com / x.com's own code. Necessary because:
//
//   1. The actual MP4 URLs for tweet videos aren't in the DOM —
//      they live in the response bodies of Twitter's GraphQL API
//      calls (TweetDetail, HomeTimeline, Bookmarks, etc.) inside
//      legacy.extended_entities.media[].video_info.variants[].
//
//   2. An isolated-world content script can't see responses to
//      fetches initiated by the page itself, so we install
//      wrappers around fetch and XMLHttpRequest here at the same
//      privilege level as x.com's own code.
//
//   3. The wrapper passes intercepted videos to the isolated world
//      via window.postMessage — which is the standard bridge
//      between main + isolated worlds in an MV3 extension.
//
// Cheap by design: we only parse JSON responses for URLs that look
// like graphql endpoints, and we read each response from a .clone()
// so we never disturb the page's own consumers.

(function gatherInterceptor() {
  if (window.__GATHEROS_INTERCEPTOR__) return;
  window.__GATHEROS_INTERCEPTOR__ = true;

  // Recursively walk a GraphQL response looking for tweet objects
  // (anything with a legacy.id_str and a media array containing
  // video_info.variants). Returns a Map<tweetId, {videoUrl, posterUrl}>.
  // Tweets without video pass through silently.
  function extractTweetVideos(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) extractTweetVideos(child, out);
      return;
    }
    const legacy = node.legacy;
    if (legacy && legacy.id_str) {
      const media = (legacy.extended_entities && legacy.extended_entities.media)
        || (legacy.entities && legacy.entities.media)
        || null;
      if (Array.isArray(media)) {
        for (const m of media) {
          const variants = m && m.video_info && m.video_info.variants;
          if (!Array.isArray(variants)) continue;
          // Pick the highest-bitrate MP4 variant. Twitter returns a
          // mix of mp4 + m3u8; we only want mp4 since the native
          // host can't download HLS without ffmpeg.
          let best = null;
          for (const v of variants) {
            if (!v || v.content_type !== 'video/mp4' || !v.url) continue;
            const br = typeof v.bitrate === 'number' ? v.bitrate : 0;
            if (!best || br > best.bitrate) best = { url: v.url, bitrate: br };
          }
          if (best) {
            out.set(legacy.id_str, {
              videoUrl: best.url,
              posterUrl: m.media_url_https || '',
            });
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      // Skip cycles + the obvious junk keys to keep the walk cheap.
      if (key === '__typename') continue;
      extractTweetVideos(node[key], out);
    }
  }

  function postVideos(map) {
    if (map.size === 0) return;
    window.postMessage(
      {
        source: 'gatheros-interceptor',
        type: 'tweet-videos',
        videos: Array.from(map.entries()),
      },
      window.location.origin,
    );
  }

  function shouldIntercept(url) {
    if (typeof url !== 'string') return false;
    // Twitter routes everything through /graphql/ or /api/.../<endpoint>.
    // Be conservative — false positives mean parsing JSON we don't
    // care about, no correctness cost.
    return url.includes('/graphql/') || url.includes('/i/api/');
  }

  // Wrap fetch. Clone the response so the page's own readers see an
  // untouched stream; parse our copy off the main thread.
  const ORIGINAL_FETCH = window.fetch;
  window.fetch = function gatherFetch(...args) {
    const reqUrl = (typeof args[0] === 'string')
      ? args[0]
      : (args[0] && args[0].url) || '';
    const p = ORIGINAL_FETCH.apply(this, args);
    if (!shouldIntercept(reqUrl)) return p;
    p.then((res) => {
      if (!res || !res.ok) return;
      const clone = res.clone();
      clone.json().then((json) => {
        const out = new Map();
        extractTweetVideos(json, out);
        postVideos(out);
      }).catch(() => { /* non-JSON or parse error — silently ignore */ });
    }).catch(() => { /* fetch error — page-level concern, ignore */ });
    return p;
  };

  // Wrap XMLHttpRequest. X uses fetch in most places but XHR shows up
  // in a few older code paths and the lazy-loaded video player code.
  const XHR_OPEN = XMLHttpRequest.prototype.open;
  const XHR_SEND = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function gatherXhrOpen(method, url, ...rest) {
    this.__gatherUrl = url;
    return XHR_OPEN.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function gatherXhrSend(...args) {
    this.addEventListener('load', () => {
      if (!shouldIntercept(this.__gatherUrl)) return;
      try {
        const json = JSON.parse(this.responseText);
        const out = new Map();
        extractTweetVideos(json, out);
        postVideos(out);
      } catch { /* non-JSON or parse error */ }
    });
    return XHR_SEND.apply(this, args);
  };
})();
