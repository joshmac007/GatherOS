// Frozen dirty transition 20 -> 21. Helper is owned here so future runtime
// tweet-date changes cannot alter already-recorded migration behavior.
const X_SNOWFLAKE_EPOCH_MS = 1288834974657n;

function deriveXTweetCreatedAt(pageUrl) {
  if (typeof pageUrl !== 'string') return null;
  const match = pageUrl.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)(?:[/?#]|$)/i);
  if (!match) return null;
  try {
    const timestamp = Number((BigInt(match[1]) >> 22n) + X_SNOWFLAKE_EPOCH_MS);
    return Number.isSafeInteger(timestamp) && timestamp > Number(X_SNOWFLAKE_EPOCH_MS)
      ? timestamp
      : null;
  } catch {
    return null;
  }
}

function parseObject(value) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function eligibleRows(database) {
  return database.prepare(`
    SELECT id, source_url, tweet_meta
      FROM saves
     WHERE source != 'instagram'
       AND source_url LIKE '%/status/%'
  `).all();
}

function apply(database) {
  const update = database.prepare('UPDATE saves SET tweet_meta = ? WHERE id = ?');
  for (const row of eligibleRows(database)) {
    const meta = parseObject(row.tweet_meta);
    if (!meta) continue;
    const existing = Number(meta.tweetCreatedAt);
    if (Number.isFinite(existing) && existing > 0) continue;
    const derived = deriveXTweetCreatedAt(row.source_url);
    if (derived === null) continue;
    update.run(JSON.stringify({ ...meta, tweetCreatedAt: derived }), row.id);
  }
}

function verify(database) {
  try {
    for (const row of eligibleRows(database)) {
      const meta = parseObject(row.tweet_meta);
      const derived = deriveXTweetCreatedAt(row.source_url);
      if (!meta || derived === null) continue;
      const actual = Number(meta.tweetCreatedAt);
      if (!Number.isFinite(actual) || actual <= 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
