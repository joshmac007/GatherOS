// Real-time X bookmark capture. Watches for clicks on the bookmark
// button anywhere on x.com / twitter.com, walks up to the enclosing
// <article>, extracts the tweet permalink + image URLs from the
// rendered DOM, and posts to the background service worker which
// forwards to GatherOS via native messaging.
//
// v1: only tweets with at least one image are synced. Dedup happens
// GatherOS-side via content_hash, so re-bookmarking or scrolling past
// the same tweet twice is a silent no-op.
//
// If X ever changes the bookmark button's data-testid, this single
// constant is the only thing that needs updating. As of this writing
// it's been stable since 2023.
const BOOKMARK_TESTID = 'bookmark';

// The click target inside the bookmark button is often the inner SVG
// or <path>. Walk up to the actual button with the data-testid before
// reading aria-label / starting the tweet extraction.
function findBookmarkButton(target) {
  let el = target;
  while (el && el !== document.body) {
    if (el.getAttribute && el.getAttribute('data-testid') === BOOKMARK_TESTID) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// The bookmark button's aria-label flips between "Bookmark" and
// "Remove Bookmark" (and localized equivalents). We want to fire only
// on adds; ignore the remove action so re-clicking doesn't ping the
// app. If the label is missing or unfamiliar we default to add and
// let GatherOS's content_hash dedup catch any spurious duplicates.
function isBookmarkAddAction(button) {
  const label = (button.getAttribute('aria-label') || '').toLowerCase();
  if (!label) return true;
  if (label.includes('remove')) return false;
  return true;
}

// Each tweet on the timeline is its own <article role="article">.
// The bookmark button lives inside the action row near the bottom.
function findTweetArticle(button) {
  let el = button;
  while (el && el !== document.body) {
    if (el.tagName === 'ARTICLE') return el;
    el = el.parentElement;
  }
  return null;
}

// The article contains several /status/<id> links (timestamp, share
// menu, photo thumbnails). We want the bare /<user>/status/<id>
// permalink — the first match that doesn't have a trailing /photo/
// or /analytics segment.
function findTweetUrl(article) {
  const links = article.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/^(\/[^/]+\/status\/\d+)(?:[/?#]|$)/);
    if (match) {
      return new URL(match[1], 'https://x.com').href;
    }
  }
  return null;
}

// Twitter rewrites image URLs to include &name=small / &name=900x900
// based on layout. Always request the original-resolution variant so
// the saved asset isn't a thumbnail.
function highResTwimg(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('name', 'orig');
    return u.toString();
  } catch {
    return url;
  }
}

// Collect every twimg media URL inside the article. Filter to the
// pbs.twimg.com/media/ host so avatars (profile_images path) and
// emoji (twemoji) don't leak in.
function findImageUrls(article) {
  const out = [];
  const seen = new Set();
  const imgs = article.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    if (!src.includes('pbs.twimg.com/media/')) continue;
    const hi = highResTwimg(src);
    if (seen.has(hi)) continue;
    seen.add(hi);
    out.push(hi);
  }
  return out;
}

// Read the author's display name + @handle from the User-Name block.
// X renders these on two adjacent lines inside the same wrapper:
//   "Brett ✦ DesignJoy
//    @brettfromdj"
// We split on newlines, take the first non-empty line as the display
// name and the first line starting with @ as the handle. Either may
// be missing depending on layout (verified/locked accounts add extra
// lines for badges); both fall back gracefully.
function findAuthorInfo(article) {
  const nameEl = article.querySelector('[data-testid="User-Name"]');
  if (!nameEl) return { displayName: '', handle: '' };
  const lines = nameEl.innerText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const displayName = lines[0] || '';
  const handle = lines.find((l) => l.startsWith('@')) || '';
  return { displayName, handle };
}

// Build a save title from the author info. Prefer "Display Name
// (@handle)" so the user can scan their library and tell at a glance
// who tweeted what. Falls back to whichever piece is present, then
// finally the URL.
function buildTitle({ displayName, handle }, tweetUrl) {
  if (displayName && handle) return `${displayName} (${handle})`;
  if (displayName) return displayName;
  if (handle) return handle;
  return tweetUrl;
}

// The tweet body lives in data-testid="tweetText". innerText
// preserves line breaks but flattens hashtag / mention link wrappers
// into plain text, which is what we want for searchable notes.
// Returns an empty string when the tweet has no body (image-only).
function findCaption(article) {
  const captionEl = article.querySelector('[data-testid="tweetText"]');
  return captionEl ? captionEl.innerText.trim() : '';
}

// Use the capture phase so we read the article BEFORE X's own click
// handler can re-render or detach it. Reading is synchronous so
// there's no race with the subsequent state flip.
document.addEventListener('click', (e) => {
  const button = findBookmarkButton(e.target);
  if (!button) return;
  if (!isBookmarkAddAction(button)) return;

  const article = findTweetArticle(button);
  if (!article) return;

  const tweetUrl = findTweetUrl(article);
  if (!tweetUrl) return;

  const imageUrls = findImageUrls(article);
  if (imageUrls.length === 0) return; // image-bearing only in v1

  const author = findAuthorInfo(article);
  const title = buildTitle(author, tweetUrl);
  const caption = findCaption(article);

  chrome.runtime.sendMessage({
    type: 'gatheros:x-bookmark',
    imageUrl: imageUrls[0],
    pageUrl: tweetUrl,
    pageTitle: title,
    notes: caption,
  });
}, true);
