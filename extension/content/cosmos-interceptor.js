// MAIN-world interceptor for cosmos.so.
//
// Cosmos has no public API, so — exactly like the X and Instagram
// interceptors — we watch the requests the Cosmos web app makes to its own
// backend as your saved elements load, pull the elements out of those
// responses, and postMessage them to the isolated-world watcher
// (cosmos-watcher.js), which relays them to the desktop /save pipeline.
//
// ────────────────────────────────────────────────────────────────────
// TODO (needs a real logged-in cosmos.so network sample to finalize):
//   1. COSMOS_API_RE — the URL pattern of the call(s) that return your
//      saved elements / a cluster's elements.
//   2. extractElements() — map that response's JSON into our element shape:
//        { id, mediaUrl, pageUrl, caption, authorName, authorHandle,
//          type: 'image' | 'video', posterUrl }
//   Grab the request URL + response JSON from DevTools → Network while
//   scrolling your saves, and fill these two in.
// ────────────────────────────────────────────────────────────────────

(() => {
  // Match the Cosmos endpoint(s) that carry saved elements. Placeholder —
  // refine from the real network trace. Kept broad + guarded so a wrong
  // guess just yields zero elements rather than garbage.
  const COSMOS_API_RE = /cosmos\.so\/api\/.*(element|save|cluster|feed)/i;

  // Turn a Cosmos API response into our normalized element list. Returns []
  // until the real payload shape is wired up, so nothing bogus is sent.
  function extractElements(json) {
    if (!json || typeof json !== 'object') return [];
    // TODO: replace with the real mapping once we have the payload. The
    // shape below is what the watcher expects; the field paths are the
    // guesswork to confirm.
    const rows = Array.isArray(json.elements) ? json.elements
      : Array.isArray(json.data) ? json.data
        : Array.isArray(json.results) ? json.results
          : [];
    return rows
      .map((el) => {
        if (!el || typeof el !== 'object') return null;
        const media = el.media || el.image || {};
        const mediaUrl = media.url || el.mediaUrl || el.imageUrl || '';
        if (!mediaUrl) return null;
        return {
          id: String(el.id || el.uuid || mediaUrl),
          mediaUrl,
          posterUrl: media.poster || el.posterUrl || '',
          type: (media.type || el.type) === 'video' ? 'video' : 'image',
          pageUrl: el.share_url || el.shareUrl || el.source_url || el.url || '',
          caption: el.caption || el.title || '',
          authorName: (el.owner && el.owner.name) || el.authorName || '',
          authorHandle: (el.owner && el.owner.username) || el.authorHandle || '',
        };
      })
      .filter(Boolean);
  }

  function emit(elements) {
    if (!elements.length) return;
    window.postMessage(
      { source: 'gatheros-cosmos-interceptor', type: 'saved-batch', elements },
      window.location.origin,
    );
  }

  async function inspect(url, getJson) {
    try {
      if (!COSMOS_API_RE.test(url)) return;
      const json = await getJson();
      emit(extractElements(json));
    } catch { /* non-JSON or parse error — ignore */ }
  }

  // ── Hook fetch ──────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      // Clone so the app still reads the body normally.
      void inspect(url, () => res.clone().json());
    } catch { /* ignore */ }
    return res;
  };

  // ── Hook XHR ────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__gatherosUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener('load', () => {
      const url = this.__gatherosUrl || '';
      void inspect(url, () => JSON.parse(this.responseText));
    });
    return origSend.apply(this, args);
  };
})();
