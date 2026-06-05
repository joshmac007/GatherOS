// Service worker for the GatherOS browser extension.
//
// v1 capture surface: right-click any image → "Save to GatherOS".
// Talks to the desktop app via Chrome's native messaging protocol —
// no localhost port, no token paste, no Options page. The desktop
// app installs the native host manifest on first launch, so
// installing the extension and the app in either order works.

const HOST_NAME = 'co.gatheros.host';
const MENU_ID = 'gatheros-save-image';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Save to GatherOS',
    contexts: ['image'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const imageUrl = info.srcUrl;
  if (!imageUrl) {
    notify('No image URL on that element.');
    return;
  }

  try {
    const response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
      type: 'save',
      imageUrl,
      pageUrl: tab?.url || info.pageUrl || null,
      pageTitle: tab?.title || null,
    });
    if (!response || !response.ok) {
      // Most common failure modes from the host:
      //   - app not running  → "app not running"
      //   - 401             → "invalid token" (prefs.json missing token)
      //   - 400             → "imageUrl required"
      const msg = response?.error || 'Save failed.';
      if (msg === 'app not running' || msg === 'GatherOS is not installed or has never been launched.') {
        notify('Open GatherOS first, then try again.');
      } else {
        notify(msg);
      }
      return;
    }
    notify(response.duplicate ? 'Already in your library.' : 'Saved to GatherOS.');
  } catch (err) {
    // chrome.runtime.lastError surfaces here as the rejection.
    // Most common: host not found (manifest never installed),
    // which means the desktop app hasn't been launched yet.
    const msg = err?.message || String(err);
    if (msg.includes('host not found') || msg.includes('Specified native messaging host')) {
      notify('Open GatherOS once to finish setup, then try again.');
    } else {
      notify(`Couldn't reach GatherOS — ${msg}`);
    }
  }
});

// Real-time X bookmark capture. The content script
// (content/x-bookmark-watcher.js) detects clicks on the bookmark
// button on x.com / twitter.com, extracts the tweet permalink +
// image URL from the surrounding article DOM, and posts the result
// here. We forward it to the GatherOS native host using the same
// 'save' message type the right-click flow uses — the desktop
// dedups by content_hash so re-bookmarking is a no-op.
//
// The content script reads the response back and renders an in-page
// toast so the user gets confirmation without leaving x.com. Errors
// route through the same channel; the content script decides what
// to show (or to stay silent if GatherOS isn't running).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  if (msg.type === 'gatheros:x-bookmark') {
    handleClickBookmark(msg, sendResponse);
    return true;
  }
  if (msg.type === 'gatheros:bookmark-batch') {
    handleBookmarkBatch(msg.bookmarks);
    return false;
  }
  return undefined;
});

function handleClickBookmark(msg, sendResponse) {
  chrome.runtime.sendNativeMessage(HOST_NAME, {
    type: 'save',
    imageUrl: msg.imageUrl,
    pageUrl: msg.pageUrl,
    videoUrl: msg.videoUrl,
    posterUrl: msg.posterUrl,
    tweetMeta: msg.tweetMeta,
    tags: msg.tags,
  }).then(async (response) => {
    const ok = !!(response && response.ok);
    sendResponse({
      ok,
      duplicate: !!(response && response.duplicate),
      error: response?.error || null,
    });
    // Mark this tweet as seen so the bookmark-batch flow (cross-
    // device sync) doesn't re-import it later. We do this even on
    // duplicate so the seen set stays in sync with what GatherOS
    // actually has.
    if (ok && msg.tweetId) {
      await markBookmarksSeen([msg.tweetId]);
    }
  }).catch((err) => {
    const text = err?.message || String(err);
    // Distinguish "GatherOS isn't running / installed" from real
    // errors so the content script can stay quiet rather than nag.
    const offline = text.includes('host not found')
      || text.includes('Specified native messaging host');
    sendResponse({
      ok: false,
      offline,
      error: text,
    });
  });
}

// ── Cross-device bookmark sync ─────────────────────────────────────
//
// The interceptor (content/x-graphql-interceptor.js) extracts every
// bookmark from every /Bookmarks GraphQL response it sees and ships
// the batch here through the content script. We compare each tweet
// id against a "seen" set in chrome.storage.local and route any
// new ones through the same /save pipeline the click capture uses.
//
// Baseline: the first batch we ever see is recorded silently (the
// user's existing archive — do not flood the library). From the
// second batch onward, anything not in the seen set is treated as
// a new bookmark from another device (iOS, web, etc.) and imported.
const STORAGE_SEEN_KEY = 'gatherosBookmarksSeen';
const STORAGE_BASELINE_KEY = 'gatherosBookmarksBaselineEstablished';

async function readSeenSet() {
  const data = await chrome.storage.local.get([STORAGE_SEEN_KEY, STORAGE_BASELINE_KEY]);
  const seen = new Set(Array.isArray(data[STORAGE_SEEN_KEY]) ? data[STORAGE_SEEN_KEY] : []);
  const baseline = !!data[STORAGE_BASELINE_KEY];
  return { seen, baseline };
}

async function writeSeenSet(seen, { baseline } = {}) {
  const update = { [STORAGE_SEEN_KEY]: Array.from(seen) };
  if (baseline !== undefined) update[STORAGE_BASELINE_KEY] = !!baseline;
  await chrome.storage.local.set(update);
}

async function markBookmarksSeen(ids) {
  if (!ids || !ids.length) return;
  const { seen } = await readSeenSet();
  let changed = false;
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      changed = true;
    }
  }
  if (changed) await writeSeenSet(seen);
}

async function handleBookmarkBatch(bookmarks) {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) return;
  const { seen, baseline } = await readSeenSet();

  if (!baseline) {
    // First batch — this is the user's existing archive at install
    // time. Record everything silently; no imports.
    for (const b of bookmarks) {
      if (b && b.tweetId) seen.add(b.tweetId);
    }
    await writeSeenSet(seen, { baseline: true });
    return;
  }

  // Established baseline — anything not in the seen set is a new
  // bookmark from any device. Import sequentially so we don't hit
  // the native host with a burst of parallel saves.
  const toImport = bookmarks.filter((b) => b && b.tweetId && !seen.has(b.tweetId));
  for (const b of toImport) {
    try {
      await syncBookmarkToGather(b);
      // Add to seen even when the save fails offline — the next
      // visit will retry naturally because the bookmark will appear
      // in the response again. Tracking it as "seen" only on
      // confirmed save would otherwise re-attempt on every poll.
      seen.add(b.tweetId);
    } catch (err) {
      console.warn('[gatheros] cross-device bookmark sync failed:', err?.message || err);
      // Still mark seen — same reasoning as above; an unrecoverable
      // failure (e.g. content_hash bug) shouldn't loop forever.
      seen.add(b.tweetId);
    }
  }
  await writeSeenSet(seen);
}

// Send a single bookmark down the same /save pipeline as the click
// capture. Mirrors the payload shape the bookmark watcher uses so
// the native-host + extension-server contract stays single-source.
async function syncBookmarkToGather(b) {
  const payload = {
    type: 'save',
    pageUrl: b.tweetUrl,
    tags: ['x:bookmark'],
    tweetMeta: {
      authorName: b.authorName || '',
      authorHandle: b.authorHandle || '',
      authorAvatarUrl: b.authorAvatarUrl || '',
      caption: b.caption || '',
      imageUrls: Array.isArray(b.imageUrls) ? b.imageUrls : [],
      videoUrl: b.videoUrl || null,
      posterUrl: b.posterUrl || '',
    },
  };
  if (b.videoUrl) {
    payload.videoUrl = b.videoUrl;
    payload.posterUrl = b.posterUrl;
  } else if (Array.isArray(b.imageUrls) && b.imageUrls.length > 0) {
    payload.imageUrl = b.imageUrls[0];
  } else {
    // No media — nothing to anchor the save to. Skip silently.
    return;
  }
  return chrome.runtime.sendNativeMessage(HOST_NAME, payload);
}

function notify(message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon.png',
      title: 'GatherOS',
      message,
    });
  } catch {
    // Notifications can fail silently on some platforms; nothing
    // else to fall back on from a service worker.
  }
}
