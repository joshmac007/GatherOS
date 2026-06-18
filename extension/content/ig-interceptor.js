// MAIN-world script — runs in instagram.com's own JavaScript context.
// Instagram's saved-posts feed (the bookmark equivalent of X) is only
// available inside the response bodies of its own network calls: the
// REST endpoints under /api/v1/feed/saved/ and the GraphQL queries at
// /graphql/query and /api/graphql. An isolated-world content script
// can't read responses to fetches the page itself initiates, so — just
// like the X interceptor — we wrap fetch + XMLHttpRequest here at the
// page's own privilege level and forward what we parse to the isolated
// world via window.postMessage.
//
// Cheap by design: we only parse JSON for URLs that look like a saved
// feed, and read each body from a .clone() so the page's own consumers
// are never disturbed.
//
// P0 NOTE: Instagram changes its endpoints and response shapes more
// often than X. The extraction below handles the shapes seen as of this
// writing (REST `media` items + GraphQL nodes), but is deliberately
// defensive — it walks the response for anything media-shaped rather
// than hard-coding a single path. When GATHEROS_IG_DEBUG is on it logs
// a one-line summary of every saved-feed response it sees (endpoint +
// post count) so the real shape can be confirmed against a live
// account and the parser locked down.

(function gatherIgInterceptor() {
  if (window.__GATHEROS_IG_INTERCEPTOR__) return;
  window.__GATHEROS_IG_INTERCEPTOR__ = true;

  // Flip on from the devtools console (window.GATHEROS_IG_DEBUG = true)
  // to log every saved-feed response. Off by default so normal browsing
  // stays quiet.
  const debugOn = () => !!window.GATHEROS_IG_DEBUG;

  // Backfill switch — same contract as the X interceptor. Normal
  // browsing only imports the TOP of the saved feed (newest); the
  // isolated-world watcher flips this on during an explicit "Import
  // saved" run so deep-scroll (cursor-paginated) pages flow through too.
  let IMPORT_MODE = false;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'gatheros-ig-control') return;
    if (d.type === 'import-mode') IMPORT_MODE = !!d.on;
  });

  // ── Saved-feed endpoint detection ──────────────────────────────────
  // REST: /api/v1/feed/saved/posts/, /api/v1/feed/saved/, and
  //       /api/v1/feed/collection/<id>/posts/ (a named saved collection).
  // GraphQL: /graphql/query or /api/graphql carrying a saved-media query.
  // The GraphQL body doesn't reveal "saved-ness" from the URL, so for
  // those we rely on the response actually containing saved-feed
  // connection keys (checked in extractSavedPosts via the walk).
  function isSavedRestEndpoint(url) {
    if (typeof url !== 'string') return false;
    return /\/api\/v1\/feed\/saved\//.test(url)
      || /\/api\/v1\/feed\/collection\/[^/]+\/(posts|all_media)\//.test(url);
  }
  function isGraphqlEndpoint(url) {
    return typeof url === 'string'
      && (/\/graphql\/query/.test(url) || /\/api\/graphql/.test(url));
  }
  function shouldIntercept(url) {
    return isSavedRestEndpoint(url) || isGraphqlEndpoint(url);
  }

  // Top-of-feed vs paginated. REST uses ?max_id=<cursor>; GraphQL puts
  // an `after` cursor in the `variables` form field (which we can't see
  // on the URL for POSTs), so GraphQL pages are treated as top unless a
  // max_id is present. During IMPORT_MODE every page is forwarded
  // regardless, so this only gates passive browsing.
  function isTopOfFeedRequest(url) {
    try {
      const u = new URL(url, window.location.origin);
      return !u.searchParams.get('max_id') && !u.searchParams.get('cursor');
    } catch {
      return true;
    }
  }

  // Pick the best (largest) image URL from an image_versions2 candidate
  // list, falling back to common single-URL fields.
  function bestImageUrl(node) {
    const cands = node
      && node.image_versions2
      && Array.isArray(node.image_versions2.candidates)
      ? node.image_versions2.candidates
      : null;
    if (cands && cands.length) {
      // Candidates are ordered largest-first by IG, but sort defensively.
      let best = cands[0];
      for (const c of cands) {
        if (c && typeof c.width === 'number' && c.width > (best.width || 0)) best = c;
      }
      if (best && best.url) return best.url;
    }
    // GraphQL / legacy single-URL shapes.
    return node.display_url || node.thumbnail_url || node.thumbnail_src || '';
  }

  function bestVideoUrl(node) {
    if (Array.isArray(node.video_versions) && node.video_versions.length) {
      let best = node.video_versions[0];
      for (const v of node.video_versions) {
        if (v && typeof v.width === 'number' && v.width > (best.width || 0)) best = v;
      }
      if (best && best.url) return best.url;
    }
    return node.video_url || '';
  }

  // A media item's children, across the REST (`carousel_media`) and
  // GraphQL (`edge_sidecar_to_children.edges[].node`) shapes.
  function carouselChildren(node) {
    if (Array.isArray(node.carousel_media)) return node.carousel_media;
    const edges = node.edge_sidecar_to_children
      && Array.isArray(node.edge_sidecar_to_children.edges)
      ? node.edge_sidecar_to_children.edges
      : null;
    if (edges) return edges.map((e) => e && e.node).filter(Boolean);
    return null;
  }

  function isVideoNode(node) {
    // REST media_type: 1=image, 2=video, 8=carousel. GraphQL: is_video.
    return node.media_type === 2
      || node.is_video === true
      || (Array.isArray(node.video_versions) && node.video_versions.length > 0);
  }

  function captionOf(node) {
    if (node.caption && typeof node.caption.text === 'string') return node.caption.text;
    if (typeof node.caption === 'string') return node.caption;
    const edges = node.edge_media_to_caption
      && Array.isArray(node.edge_media_to_caption.edges)
      ? node.edge_media_to_caption.edges
      : null;
    if (edges && edges[0] && edges[0].node && typeof edges[0].node.text === 'string') {
      return edges[0].node.text;
    }
    return '';
  }

  function ownerOf(node) {
    const u = node.user || node.owner || {};
    return {
      username: u.username || '',
      fullName: u.full_name || u.fullName || '',
      avatarUrl: u.profile_pic_url || u.profile_pic_url_hd || '',
    };
  }

  // Normalize a single IG media node into the GatherOS save shape. The
  // imageUrls array mirrors the X model: a flat, ordered list of remote
  // image URLs the renderer pages through. For a carousel that's every
  // child's still; for a reel it's the poster frame. Video posts route
  // through videoUrl/posterUrl (the desktop's saveVideoFromUrl branch).
  function parseSavedMedia(node) {
    const shortcode = node.code || node.shortcode;
    const postId = node.pk || node.id || shortcode;
    if (!shortcode && !postId) return null;
    const owner = ownerOf(node);
    const permalink = `https://www.instagram.com/p/${shortcode || postId}/`;
    const children = carouselChildren(node);

    let imageUrls = [];
    let videoUrl = null;
    let posterUrl = '';

    if (children && children.length) {
      // Carousel — one save, every child's still in imageUrls (locked
      // default #1). A video child contributes its poster frame.
      for (const child of children) {
        const img = bestImageUrl(child);
        if (img) imageUrls.push(img);
      }
    } else if (isVideoNode(node)) {
      // Reel / single video — route through the video branch.
      videoUrl = bestVideoUrl(node) || null;
      posterUrl = bestImageUrl(node) || '';
      if (posterUrl) imageUrls.push(posterUrl);
    } else {
      const img = bestImageUrl(node);
      if (img) imageUrls.push(img);
    }

    // Nothing usable — no media and no caption — skip.
    const caption = captionOf(node);
    if (imageUrls.length === 0 && !videoUrl && !caption.trim()) return null;

    return {
      postId: String(postId),
      shortcode: shortcode || '',
      tweetUrl: permalink, // reuse the X field name so the relay/background path is shared
      authorName: owner.fullName,
      authorHandle: owner.username ? `@${owner.username}` : '',
      authorAvatarUrl: owner.avatarUrl,
      caption,
      imageUrls,
      videoUrl,
      posterUrl,
      isCarousel: !!(children && children.length),
    };
  }

  // Does this object look like a saved media item we can parse? Used to
  // drive the recursive walk without hard-coding a single response path.
  function looksLikeMedia(node) {
    if (!node || typeof node !== 'object') return false;
    const hasCode = typeof node.code === 'string' || typeof node.shortcode === 'string';
    const hasMedia = !!node.image_versions2
      || !!node.display_url
      || Array.isArray(node.carousel_media)
      || !!node.edge_sidecar_to_children
      || Array.isArray(node.video_versions)
      || typeof node.video_url === 'string';
    return hasCode && hasMedia;
  }

  // Walk the whole response collecting saved media. Dedup by postId so a
  // node that appears in multiple places counts once. We avoid recursing
  // into a media node's own children (we parse those inside
  // parseSavedMedia) so a carousel stays one save.
  function extractSavedPosts(json) {
    const out = [];
    const seen = new Set();
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const c of node) walk(c); return; }
      if (looksLikeMedia(node)) {
        const parsed = parseSavedMedia(node);
        if (parsed && !seen.has(parsed.postId)) {
          seen.add(parsed.postId);
          out.push(parsed);
        }
        return; // don't descend into this media's own sub-media
      }
      for (const key of Object.keys(node)) {
        if (key === '__typename') continue;
        walk(node[key]);
      }
    }
    walk(json);
    return out;
  }

  function postSaved(posts) {
    if (!posts.length) return;
    window.postMessage(
      { source: 'gatheros-ig-interceptor', type: 'saved-batch', posts },
      window.location.origin,
    );
  }

  // Shared handler for both fetch + XHR captures.
  function handleResponse(url, json) {
    const posts = extractSavedPosts(json);
    if (debugOn()) {
      // One-line summary to confirm endpoint + shape against a live
      // account during P0 bring-up.
      // eslint-disable-next-line no-console
      console.log('[gatheros-ig] saw', posts.length, 'saved post(s) from', url, posts.slice(0, 2));
    }
    if (posts.length === 0) return; // not a saved-feed response (most graphql calls)
    if (IMPORT_MODE || isTopOfFeedRequest(url)) {
      postSaved(posts);
    }
  }

  const ORIGINAL_FETCH = window.fetch;
  window.fetch = function gatherIgFetch(...args) {
    const reqUrl = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
    const p = ORIGINAL_FETCH.apply(this, args);
    if (!shouldIntercept(reqUrl)) return p;
    p.then((res) => {
      if (!res || !res.ok) return;
      res.clone().json()
        .then((json) => handleResponse(reqUrl, json))
        .catch(() => { /* non-JSON / parse error — ignore */ });
    }).catch(() => { /* fetch error — page concern */ });
    return p;
  };

  const XHR_OPEN = XMLHttpRequest.prototype.open;
  const XHR_SEND = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function gatherIgXhrOpen(method, url, ...rest) {
    this.__gatherIgUrl = url;
    return XHR_OPEN.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function gatherIgXhrSend(...args) {
    this.addEventListener('load', () => {
      if (!shouldIntercept(this.__gatherIgUrl)) return;
      try {
        handleResponse(this.__gatherIgUrl, JSON.parse(this.responseText));
      } catch { /* non-JSON / parse error */ }
    });
    return XHR_SEND.apply(this, args);
  };
})();
