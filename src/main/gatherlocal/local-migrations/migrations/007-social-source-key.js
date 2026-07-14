// Frozen dirty transition 21 -> 22. Duplicate social saves are retained; only
// oldest active row receives canonical key enforced by partial unique index.
function hasColumn(database, table, name) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

function tweetKeyFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
  return match ? `tw:${match[1]}` : null;
}

function instagramKeyFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
  return match ? `ig:${match[1]}` : null;
}

function sourceKeyFromUrl(url) {
  return tweetKeyFromUrl(url) || instagramKeyFromUrl(url);
}

function activeSocialRows(database) {
  return database.prepare(`
    SELECT id, source_url, source_key
      FROM saves
     WHERE deleted_at IS NULL
       AND source_url IS NOT NULL
       AND tweet_meta IS NOT NULL
     ORDER BY created_at ASC, id ASC
  `).all();
}

function apply(database) {
  if (!hasColumn(database, 'saves', 'source_key')) {
    database.exec('ALTER TABLE saves ADD COLUMN source_key TEXT');
  }

  const rows = activeSocialRows(database);
  const clear = database.prepare('UPDATE saves SET source_key = NULL WHERE id = ?');
  for (const row of rows) {
    if (sourceKeyFromUrl(row.source_url) && row.source_key !== null) clear.run(row.id);
  }

  const claimed = new Set();
  const assign = database.prepare('UPDATE saves SET source_key = ? WHERE id = ?');
  for (const row of rows) {
    const key = sourceKeyFromUrl(row.source_url);
    if (!key || claimed.has(key)) continue;
    claimed.add(key);
    assign.run(key, row.id);
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saves_active_source_key
      ON saves(source_key)
     WHERE deleted_at IS NULL AND source_key IS NOT NULL;
  `);
}

function verify(database) {
  try {
    if (!hasColumn(database, 'saves', 'source_key')) return false;
    const index = database.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_saves_active_source_key'
    `).get();
    if (!/UNIQUE INDEX/i.test(index?.sql || '') || !/deleted_at IS NULL/i.test(index.sql)) return false;

    const seen = new Set();
    for (const row of activeSocialRows(database)) {
      const expected = sourceKeyFromUrl(row.source_url);
      if (!expected) continue;
      if (!seen.has(expected)) {
        if (row.source_key !== expected) return false;
        seen.add(expected);
      } else if (row.source_key !== null) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
