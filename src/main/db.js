const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app } = require('electron');
const Database = require('better-sqlite3');

// Video suggestions and semantic search are separate durable domains. This
// block is used by both the fresh-database baseline and one appended migration
// so old libraries and new libraries receive the exact same constraints.
const AI_DOMAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS semantic_index_generations (
  id              TEXT PRIMARY KEY,
  model           TEXT NOT NULL,
  dimension       INTEGER,
  source_version  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'building',
  created_at      INTEGER NOT NULL,
  activated_at    INTEGER,
  completed_at    INTEGER,
  cancelled_at    INTEGER,
  CHECK (dimension IS NULL OR dimension > 0),
  CHECK (status IN ('building', 'active', 'retired', 'cancelled', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_generations_status
  ON semantic_index_generations(status, created_at DESC);

CREATE TABLE IF NOT EXISTS semantic_index_state (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  active_generation_id    TEXT REFERENCES semantic_index_generations(id) ON DELETE SET NULL,
  building_generation_id  TEXT REFERENCES semantic_index_generations(id) ON DELETE SET NULL,
  paused                  INTEGER NOT NULL DEFAULT 0,
  pause_reason            TEXT,
  paused_at               INTEGER,
  updated_at              INTEGER NOT NULL DEFAULT 0,
  CHECK (paused IN (0, 1))
);

INSERT OR IGNORE INTO semantic_index_state (id, updated_at) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS semantic_vectors (
  generation_id  TEXT NOT NULL REFERENCES semantic_index_generations(id) ON DELETE CASCADE,
  save_id        TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  dimension      INTEGER NOT NULL,
  source_hash    TEXT NOT NULL,
  vector         BLOB NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (generation_id, save_id),
  CHECK (dimension > 0)
);

CREATE INDEX IF NOT EXISTS idx_semantic_vectors_save
  ON semantic_vectors(save_id, generation_id);

CREATE TABLE IF NOT EXISTS semantic_index_jobs (
  id              TEXT PRIMARY KEY,
  generation_id   TEXT NOT NULL REFERENCES semantic_index_generations(id) ON DELETE CASCADE,
  save_id          TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  retry_count      INTEGER NOT NULL DEFAULT 0,
  retryable        INTEGER NOT NULL DEFAULT 0,
  available_at     INTEGER NOT NULL,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  UNIQUE (generation_id, save_id, kind),
  CHECK (kind IN ('incremental', 'rebuild')),
  CHECK (state IN ('pending', 'running', 'completed', 'failed', 'dismissed')),
  CHECK (retry_count >= 0),
  CHECK (retryable IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_semantic_jobs_ready
  ON semantic_index_jobs(state, kind, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_semantic_jobs_generation
  ON semantic_index_jobs(generation_id, state);

CREATE TABLE IF NOT EXISTS video_analysis_jobs (
  id              TEXT PRIMARY KEY,
  save_id          TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  fingerprint      TEXT NOT NULL,
  prompt_version   INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  superseded_from_state TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  retryable        INTEGER NOT NULL DEFAULT 0,
  available_at     INTEGER NOT NULL,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  UNIQUE (save_id, fingerprint),
  CHECK (prompt_version > 0),
  CHECK (state IN ('pending', 'running', 'completed', 'failed', 'unavailable', 'superseded')),
  CHECK (superseded_from_state IS NULL OR superseded_from_state IN
    ('pending', 'completed', 'failed', 'unavailable')),
  CHECK (retry_count >= 0),
  CHECK (retryable IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_video_analysis_ready
  ON video_analysis_jobs(state, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_video_analysis_save
  ON video_analysis_jobs(save_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS video_tag_suggestions (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES video_analysis_jobs(id) ON DELETE CASCADE,
  save_id       TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  name          TEXT NOT NULL,
  confidence    TEXT NOT NULL DEFAULT 'high',
  evidence      TEXT NOT NULL DEFAULT '[]',
  state         TEXT NOT NULL DEFAULT 'suggested',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  UNIQUE (job_id, name),
  CHECK (confidence IN ('high', 'medium', 'low')),
  CHECK (state IN ('suggested', 'accepted', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_video_suggestions_save
  ON video_tag_suggestions(save_id, state, created_at);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saves (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  thumb_path  TEXT NOT NULL,
  title       TEXT,
  source_url  TEXT,
  width       INTEGER,
  height      INTEGER,
  file_size   INTEGER,
  palette     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saves_created_at ON saves (created_at DESC);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id  TEXT REFERENCES collections(id) ON DELETE CASCADE,
  save_id        TEXT REFERENCES saves(id) ON DELETE CASCADE,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (collection_id, save_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY,
  name  TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS save_tags (
  save_id  TEXT REFERENCES saves(id) ON DELETE CASCADE,
  tag_id   TEXT REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (save_id, tag_id)
);

CREATE TABLE IF NOT EXISTS boards (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  thumb_path   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boards_updated_at ON boards (updated_at DESC);

CREATE TABLE IF NOT EXISTS board_items (
  id           TEXT PRIMARY KEY,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  width        REAL,
  height       REAL,
  rotation     REAL DEFAULT 0,
  z_index      INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_items_board_id ON board_items (board_id);

-- Tombstones for X bookmarks the user has removed from Gather. The
-- bookmark watcher re-captures whatever scrolls into view, so without
-- this a deleted bookmark would silently come back. Keyed by tweet id.
CREATE TABLE IF NOT EXISTS dismissed_tweets (
  tweet_key     TEXT PRIMARY KEY,
  dismissed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_categories (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'candidate',
  parent_id           TEXT REFERENCES smart_categories(id) ON DELETE SET NULL,
  centroid_embedding  BLOB,
  visibility_score    REAL NOT NULL DEFAULT 0,
  member_count        INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  last_changed_at     INTEGER,
  change_kind         TEXT,
  frozen_name         INTEGER NOT NULL DEFAULT 0,
  CHECK (status IN ('candidate', 'visible', 'hidden', 'archived')),
  CHECK (change_kind IS NULL OR change_kind IN ('created', 'renamed', 'merged', 'split')),
  CHECK (frozen_name IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_smart_categories_status
  ON smart_categories(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_smart_categories_parent_id
  ON smart_categories(parent_id);

CREATE TABLE IF NOT EXISTS smart_category_aliases (
  id           TEXT PRIMARY KEY,
  category_id  TEXT NOT NULL REFERENCES smart_categories(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'model_synonym',
  created_at   INTEGER NOT NULL,
  UNIQUE(category_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_smart_category_aliases_alias
  ON smart_category_aliases(alias);

CREATE TABLE IF NOT EXISTS smart_category_members (
  category_id  TEXT NOT NULL REFERENCES smart_categories(id) ON DELETE CASCADE,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  weight       REAL NOT NULL,
  evidence     TEXT,
  assigned_at  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (category_id, save_id),
  CHECK (weight >= 0 AND weight <= 1)
);

CREATE INDEX IF NOT EXISTS idx_smart_category_members_save
  ON smart_category_members(save_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_smart_category_members_category_weight
  ON smart_category_members(category_id, weight DESC);

CREATE TABLE IF NOT EXISTS save_topic_profiles (
  save_id       TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
  concepts      TEXT NOT NULL DEFAULT '[]',
  content_type  TEXT,
  intent_guess  TEXT,
  summary       TEXT,
  embedding     BLOB,
  confidence    REAL NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE TABLE IF NOT EXISTS smart_category_runs (
  id                TEXT PRIMARY KEY,
  run_type          TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  input_save_count  INTEGER NOT NULL DEFAULT 0,
  created_count     INTEGER NOT NULL DEFAULT 0,
  renamed_count     INTEGER NOT NULL DEFAULT 0,
  merged_count      INTEGER NOT NULL DEFAULT 0,
  split_count       INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  provider          TEXT,
  error             TEXT,
  metadata          TEXT
);

CREATE INDEX IF NOT EXISTS idx_smart_category_runs_started
  ON smart_category_runs(started_at DESC);

${AI_DOMAIN_SCHEMA}
`;

function safeJsonExpr(col) {
  return `(CASE WHEN json_valid(${col}) THEN ${col} END)`;
}

function tweetTextSql(col) {
  const safe = safeJsonExpr(col);
  return `
    COALESCE(json_extract(${safe},'$.caption'),'') || ' ' ||
    COALESCE(json_extract(${safe},'$.authorName'),'') || ' ' ||
    COALESCE(json_extract(${safe},'$.authorHandle'),'') || ' ' ||
    COALESCE(json_extract(${safe},'$.thread'),'') || ' ' ||
    COALESCE(json_extract(${safe},'$.quoted.caption'),'') || ' ' ||
    COALESCE(json_extract(${safe},'$.quoted.authorName'),'') || ' ' ||
    COALESCE(json_extract(${safe},'$.quoted.authorHandle'),'')`;
}

let db = null;

function getDatabasePath() {
  // Resolved per-call so a library switch (which writes a new
  // active id into the registry) is reflected the next time the
  // DB is opened.
  const { getActiveLibraryRoot } = require('./library-registry');
  return path.join(getActiveLibraryRoot(), 'moodmark.db');
}

function initDatabase() {
  if (db) return db;
  const file = getDatabasePath();
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Baseline schema first — CREATE TABLE IF NOT EXISTS is a no-op on
  // existing DBs but bootstraps fresh ones. Then run versioned
  // migrations on top to bring any older shape up to current.
  db.exec(SCHEMA);
  migrate();
  // Cheap insurance against the SQLite-corruption stories that haunt
  // local-first apps. Result is cached so the renderer can pull it on
  // mount and surface a recoverable warning if anything turned up.
  lastIntegrityResult = checkIntegrity(db);
  return db;
}

// Result of the most recent PRAGMA integrity_check, captured at init
// time so the renderer can ask for it once on mount without rerunning
// a full-table scan on every poll.
let lastIntegrityResult = { ok: true, errors: [] };

function checkIntegrity(database) {
  try {
    // quick_check, not integrity_check: the full check reads the ENTIRE
    // database on every launch, which is seconds of cold-start on a
    // multi-GB library. quick_check catches the same page-level
    // corruption classes (it skips some index cross-validation) in a
    // small fraction of the time.
    const rows = database.prepare('PRAGMA quick_check').all();
    const errors = rows
      .map((r) => r.quick_check)
      .filter((s) => s && s !== 'ok');
    if (errors.length > 0) {
      console.error('[db] integrity_check found issues:', errors);
      return { ok: false, errors };
    }
    return { ok: true, errors: [] };
  } catch (err) {
    console.error('[db] integrity_check threw:', err);
    return { ok: false, errors: [err.message || String(err)] };
  }
}

function getIntegrityResult() {
  return lastIntegrityResult;
}

// ── Versioned migrations ───────────────────────────────────────────
//
// SQLite's user_version pragma is our schema version cursor. Each
// entry of MIGRATIONS is a function run exactly once on databases
// whose user_version is below the entry's index. After a successful
// run, user_version is bumped to that index + 1.
//
// Adding a migration:
//   1. Append a new function to MIGRATIONS. Never reorder/delete
//      existing entries — that breaks any DB in the field already
//      advanced past your insertion point.
//   2. Each migration is wrapped in a transaction, so a throw rolls
//      back the entire change atomically and leaves user_version
//      unchanged.
//   3. Make data-touching logic idempotent where you can; even with
//      transactional rollback, an inconsistent half-migration on
//      disk is safer to retry than to assume.
const MIGRATIONS = [
  // v0 → v1: pulls every legacy DB up to today's baseline. Idempotent
  // so DBs that pre-date user_version tracking (and have already had
  // these columns added by the old best-effort migration) pass
  // through cleanly.
  (database) => {
    addColumnIfMissing(database, 'collections', 'order_index', 'INTEGER DEFAULT 0');
    // Seed order_index in created_at order so existing buckets keep
    // their visual order. Only fires when no row has been ordered
    // (avoids re-shuffling on a re-migrate against an already-seeded
    // table).
    const ordered = database
      .prepare('SELECT COUNT(*) AS n FROM collections WHERE order_index > 0')
      .get().n;
    if (ordered === 0) {
      const rows = database.prepare('SELECT id FROM collections ORDER BY created_at ASC').all();
      const stmt = database.prepare('UPDATE collections SET order_index = ? WHERE id = ?');
      rows.forEach((r, i) => stmt.run(i, r.id));
    }
    addColumnIfMissing(database, 'saves', 'ai_description', 'TEXT');
    addColumnIfMissing(database, 'saves', 'embedding', 'BLOB');
    addColumnIfMissing(database, 'saves', 'ocr_text', 'TEXT');
    addColumnIfMissing(database, 'saves', 'ai_prompt', 'TEXT');
    addColumnIfMissing(database, 'saves', 'deleted_at', 'INTEGER');
    // Generic per-save metadata as JSON. Used today for tag-specific
    // extras (e.g. the "font" tag stores name/designer/buy_url here).
    addColumnIfMissing(database, 'saves', 'meta', 'TEXT');
    addColumnIfMissing(database, 'saves', 'notes', 'TEXT');
    // One level of bucket nesting; cascade-on-delete handled in
    // application code (SQLite ALTER doesn't allow REFERENCES).
    addColumnIfMissing(database, 'collections', 'parent_id', 'TEXT');
  },
  // v1 → v2: SHA-256 of the original bytes per save. Powers the
  // "already in your library" duplicate-on-save toast. New rows get
  // a hash from the storage layer; existing rows are filled in by a
  // background backfill kicked off after init (see backfillContentHashes).
  (database) => {
    addColumnIfMissing(database, 'saves', 'content_hash', 'TEXT');
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_saves_content_hash ON saves(content_hash)',
    );
  },
  // v2 → v3: precomputed LAB triplets for every palette swatch. The
  // color filter and "find similar" path used to call hexToLab on
  // every swatch on every save on every keystroke; storing the
  // conversion once at save time turns those into a JSON.parse.
  (database) => {
    addColumnIfMissing(database, 'saves', 'palette_lab', 'TEXT');
    const rows = database
      .prepare('SELECT id, palette FROM saves WHERE palette IS NOT NULL AND palette_lab IS NULL')
      .all();
    if (rows.length === 0) return;
    const upd = database.prepare('UPDATE saves SET palette_lab = ? WHERE id = ?');
    const txn = database.transaction((items) => {
      for (const r of items) {
        let pal;
        try { pal = JSON.parse(r.palette); } catch { continue; }
        if (!Array.isArray(pal)) continue;
        const labs = pal.map(hexToLab).filter(Boolean);
        if (labs.length === 0) continue;
        upd.run(JSON.stringify(labs), r.id);
      }
    });
    txn(rows);
  },
  // v? → next: boards.order_index for drag-to-reorder on the Spaces
  // grid. Mirrors collections.order_index — seed existing rows in
  // created_at order so the first launch after upgrade preserves
  // current visual order.
  (database) => {
    addColumnIfMissing(database, 'boards', 'order_index', 'INTEGER DEFAULT 0');
    const ordered = database
      .prepare('SELECT COUNT(*) AS n FROM boards WHERE order_index > 0')
      .get().n;
    if (ordered === 0) {
      const rows = database.prepare('SELECT id FROM boards ORDER BY created_at ASC').all();
      const stmt = database.prepare('UPDATE boards SET order_index = ? WHERE id = ?');
      rows.forEach((r, i) => stmt.run(i, r.id));
    }
  },
  // v? → next: saves.kind to distinguish URL-kind saves (saved
  // websites) from the original image saves. Existing rows default
  // to 'image'; new URL saves carry kind='url' so FocusedView can
  // swap the <img> for a live <webview> at view time.
  (database) => {
    addColumnIfMissing(database, 'saves', 'kind', "TEXT NOT NULL DEFAULT 'image'");
  },
  // X-bookmark capture: holds the source tweet's author + handle +
  // avatar + caption + every image URL on the tweet so the detail
  // panel can render a glass tweet card and let the user click any
  // image on the tweet to swap into the focused view. Stored as
  // JSON so future Twitter / X / Bluesky / Threads payloads can
  // share the same field without another migration.
  (database) => {
    addColumnIfMissing(database, 'saves', 'tweet_meta', 'TEXT');
  },
  // Multi-source capture: a `source` column tags each save with its
  // origin — 'x' (X bookmarks, the original capture surface) or
  // 'instagram' (Instagram saved posts). Defaults to 'x' so every
  // existing row reads as an X/native save with no data touch. The
  // per-source structured payload keeps living in the existing
  // tweet_meta JSON column, which was always intended to be source-
  // agnostic (see the migration above) — so we generalize by adding a
  // discriminator rather than renaming the column, leaving the working
  // X read/write path untouched.
  (database) => {
    addColumnIfMissing(database, 'saves', 'source', "TEXT NOT NULL DEFAULT 'x'");
  },
  // Backfill source for Instagram saves imported before the source column
  // (and native-host forwarding) landed — they defaulted to 'x' and so
  // showed the X badge in the grid instead of the Instagram one. Their
  // permalink is an instagram.com URL, which distinguishes them. Idempotent.
  (database) => {
    database.prepare(
      "UPDATE saves SET source = 'instagram' WHERE source = 'x' AND source_url LIKE '%instagram.com%'",
    ).run();
  },
  // Rename the namespaced auto-tags to plain words: 'x:bookmark' →
  // 'bookmark', 'instagram:save' → 'instagram'. If the plain name already
  // exists (e.g. a user-made tag), merge into it — repoint every edge then
  // drop the old row — so the UNIQUE(name) constraint holds. Idempotent.
  (database) => {
    const rename = (from, to) => {
      const old = database.prepare('SELECT id FROM tags WHERE name = ?').get(from);
      if (!old) return;
      const existing = database.prepare('SELECT id FROM tags WHERE name = ?').get(to);
      if (existing) {
        database.prepare(
          'INSERT OR IGNORE INTO save_tags (save_id, tag_id) SELECT save_id, ? FROM save_tags WHERE tag_id = ?',
        ).run(existing.id, old.id);
        database.prepare('DELETE FROM save_tags WHERE tag_id = ?').run(old.id);
        database.prepare('DELETE FROM tags WHERE id = ?').run(old.id);
      } else {
        database.prepare('UPDATE tags SET name = ? WHERE id = ?').run(to, old.id);
      }
    };
    rename('x:bookmark', 'bookmark');
    rename('instagram:save', 'instagram');
  },
  // Variant model groundwork (Phase 1). A medium "preview" render that
  // sits between the 400px thumb and the full original — the focused
  // view / peek will use it, and it's the local file the cloud layer
  // keeps when originals are offloaded. Nullable: existing saves have
  // none, and resolveAsset() falls back to the original until one is
  // generated, so this migration is purely additive and invisible.
  (database) => {
    addColumnIfMissing(database, 'saves', 'preview_path', 'TEXT');
  },
  // Per-save view counter — bumped when a save opens in the focused
  // view. Powers the grid's "Most viewed" sort.
  (database) => {
    addColumnIfMissing(database, 'saves', 'view_count', 'INTEGER NOT NULL DEFAULT 0');
  },
  // Partial index covering the hot list query: nearly every fetch
  // filters deleted_at IS NULL and orders by created_at DESC. The bare
  // created_at index can't serve the filter; this serves both at once.
  (database) => {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_saves_live_created ON saves (created_at DESC) WHERE deleted_at IS NULL',
    );
  },
  // FTS5 shadow table for text search. The LIKE pass scanned every row
  // and json_extract-parsed tweet_meta per row PER KEYSTROKE — fine at
  // 2k saves, the wall at 20k. Triggers keep it in sync with saves;
  // tag-name matching stays in plain SQL (tags is a small table).
  // Tokenizer note: FTS matches token prefixes ("mou" → mountain), not
  // mid-word substrings — accepted trade for indexed lookups.
  (database) => {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS saves_fts USING fts5(
        save_id UNINDEXED,
        title,
        ocr_text,
        tweet_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS saves_fts_ai AFTER INSERT ON saves BEGIN
        INSERT INTO saves_fts (save_id, title, ocr_text, tweet_text)
        VALUES (
          new.id,
          COALESCE(new.title, ''),
          COALESCE(new.ocr_text, ''),
          ${tweetTextSql('new.tweet_meta')}
        );
      END;
      CREATE TRIGGER IF NOT EXISTS saves_fts_ad AFTER DELETE ON saves BEGIN
        DELETE FROM saves_fts WHERE save_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS saves_fts_au
      AFTER UPDATE OF title, ocr_text, tweet_meta ON saves BEGIN
        DELETE FROM saves_fts WHERE save_id = new.id;
        INSERT INTO saves_fts (save_id, title, ocr_text, tweet_text)
        VALUES (
          new.id,
          COALESCE(new.title, ''),
          COALESCE(new.ocr_text, ''),
          ${tweetTextSql('new.tweet_meta')}
        );
      END;
    `);
    // Backfill existing rows once; triggers own it from here.
    database.exec(`
      INSERT INTO saves_fts (save_id, title, ocr_text, tweet_text)
      SELECT id, COALESCE(title, ''), COALESCE(ocr_text, ''),
        ${tweetTextSql('saves.tweet_meta')}
      FROM saves;
    `);
  },
  // FTS repair: the triggers/backfill above call json_extract on
  // tweet_meta directly, and json_extract THROWS on any malformed-JSON
  // value. A single legacy/corrupt tweet_meta row therefore aborted the
  // one-time backfill, leaving every pre-existing save unindexed (and so
  // unsearchable — a save's own title/caption wouldn't match). Guard
  // every extraction with json_valid so a bad row yields '' instead of
  // throwing, recreate the triggers, and rebuild the index so already-
  // broken libraries recover on this launch.
  (database) => {
    database.exec(`
      DROP TRIGGER IF EXISTS saves_fts_ai;
      DROP TRIGGER IF EXISTS saves_fts_au;
      CREATE TRIGGER saves_fts_ai AFTER INSERT ON saves BEGIN
        INSERT INTO saves_fts (save_id, title, ocr_text, tweet_text)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.ocr_text,''), ${tweetTextSql('new.tweet_meta')});
      END;
      CREATE TRIGGER saves_fts_au
      AFTER UPDATE OF title, ocr_text, tweet_meta ON saves BEGIN
        DELETE FROM saves_fts WHERE save_id = new.id;
        INSERT INTO saves_fts (save_id, title, ocr_text, tweet_text)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.ocr_text,''), ${tweetTextSql('new.tweet_meta')});
      END;
      DELETE FROM saves_fts;
      INSERT INTO saves_fts (save_id, title, ocr_text, tweet_text)
      SELECT id, COALESCE(title,''), COALESCE(ocr_text,''), ${tweetTextSql('saves.tweet_meta')}
      FROM saves;
    `);
  },
  // Last-viewed timestamp, so the command palette can show a
  // "Recently viewed" strip ordered by when each save was opened.
  (database) => {
    addColumnIfMissing(database, 'saves', 'viewed_at', 'INTEGER');
  },
  // Smart categories foundation: internal learned category lenses,
  // aliases, topic profiles, weighted memberships, and run history.
  // Purely additive; no existing library queries read these tables yet.
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS smart_categories (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        description         TEXT,
        status              TEXT NOT NULL DEFAULT 'candidate',
        parent_id           TEXT REFERENCES smart_categories(id) ON DELETE SET NULL,
        centroid_embedding  BLOB,
        visibility_score    REAL NOT NULL DEFAULT 0,
        member_count        INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        last_changed_at     INTEGER,
        change_kind         TEXT,
        frozen_name         INTEGER NOT NULL DEFAULT 0,
        CHECK (status IN ('candidate', 'visible', 'hidden', 'archived')),
        CHECK (change_kind IS NULL OR change_kind IN ('created', 'renamed', 'merged', 'split')),
        CHECK (frozen_name IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_smart_categories_status
        ON smart_categories(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_smart_categories_parent_id
        ON smart_categories(parent_id);

      CREATE TABLE IF NOT EXISTS smart_category_aliases (
        id           TEXT PRIMARY KEY,
        category_id  TEXT NOT NULL REFERENCES smart_categories(id) ON DELETE CASCADE,
        alias        TEXT NOT NULL,
        source       TEXT NOT NULL DEFAULT 'model_synonym',
        created_at   INTEGER NOT NULL,
        UNIQUE(category_id, alias)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_category_aliases_alias
        ON smart_category_aliases(alias);

      CREATE TABLE IF NOT EXISTS smart_category_members (
        category_id  TEXT NOT NULL REFERENCES smart_categories(id) ON DELETE CASCADE,
        save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
        weight       REAL NOT NULL,
        evidence     TEXT,
        assigned_at  INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (category_id, save_id),
        CHECK (weight >= 0 AND weight <= 1)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_category_members_save
        ON smart_category_members(save_id, weight DESC);
      CREATE INDEX IF NOT EXISTS idx_smart_category_members_category_weight
        ON smart_category_members(category_id, weight DESC);

      CREATE TABLE IF NOT EXISTS save_topic_profiles (
        save_id       TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
        concepts      TEXT NOT NULL DEFAULT '[]',
        content_type  TEXT,
        intent_guess  TEXT,
        summary       TEXT,
        embedding     BLOB,
        confidence    REAL NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        CHECK (confidence >= 0 AND confidence <= 1)
      );

      CREATE TABLE IF NOT EXISTS smart_category_runs (
        id                TEXT PRIMARY KEY,
        run_type          TEXT NOT NULL,
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER,
        input_save_count  INTEGER NOT NULL DEFAULT 0,
        created_count     INTEGER NOT NULL DEFAULT 0,
        renamed_count     INTEGER NOT NULL DEFAULT 0,
        merged_count      INTEGER NOT NULL DEFAULT 0,
        split_count       INTEGER NOT NULL DEFAULT 0,
        failed_count      INTEGER NOT NULL DEFAULT 0,
        provider          TEXT,
        error             TEXT,
        metadata          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_smart_category_runs_started
        ON smart_category_runs(started_at DESC);
    `);
  },
  // Smart category taxonomy refresh metadata. Deferred merge/split proposals
  // are recorded here until assignment behavior is stable enough to apply them.
  (database) => {
    addColumnIfMissing(database, 'smart_category_runs', 'metadata', 'TEXT');
  },
  // Durable, generation-isolated semantic indexing and fingerprint-scoped
  // video tag suggestions. Additive only: legacy save embeddings remain
  // readable but are not copied into this index.
  (database) => {
    database.exec(AI_DOMAIN_SCHEMA);
  },
  // Compatibility for the committed intermediate persistence schema. That
  // version already advanced user_version but did not yet have retry flags,
  // remembered supersession state, or a database-level single-build guard.
  (database) => {
    addColumnIfMissing(database, 'semantic_index_jobs', 'retryable', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(database, 'video_analysis_jobs', 'retryable', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(database, 'video_analysis_jobs', 'superseded_from_state', 'TEXT');

    const state = database.prepare(`
      SELECT building_generation_id FROM semantic_index_state WHERE id = 1
    `).get();
    const pointed = state && state.building_generation_id
      ? database.prepare(`
          SELECT id FROM semantic_index_generations
           WHERE id = ? AND status = 'building'
        `).get(state.building_generation_id)
      : null;
    const survivor = pointed || database.prepare(`
      SELECT id FROM semantic_index_generations
       WHERE status = 'building'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `).get();

    if (survivor) {
      database.prepare(`
        UPDATE semantic_index_generations
           SET status = 'cancelled',
               cancelled_at = COALESCE(cancelled_at, created_at),
               completed_at = COALESCE(completed_at, created_at)
         WHERE status = 'building' AND id != ?
      `).run(survivor.id);
      database.prepare(`
        UPDATE semantic_index_state SET building_generation_id = ? WHERE id = 1
      `).run(survivor.id);
    } else {
      database.prepare(`
        UPDATE semantic_index_state SET building_generation_id = NULL WHERE id = 1
      `).run();
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_generations_one_building
        ON semantic_index_generations(status) WHERE status = 'building';
    `);
  },
];

function addColumnIfMissing(database, table, name, type) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function migrate() {
  const currentVersion = db.pragma('user_version', { simple: true });
  const targetVersion = MIGRATIONS.length;
  if (currentVersion >= targetVersion) return;

  // One copy-on-disk before applying any unapplied migrations, in case
  // a downstream change in the queue corrupts the file. Backup is best-
  // effort: if it fails (no disk, permissions), we log and proceed —
  // the per-migration transaction is the real safety net.
  if (databaseHasUserData()) {
    backupDatabaseBeforeMigrate(currentVersion);
  }

  for (let v = currentVersion; v < targetVersion; v++) {
    const fn = MIGRATIONS[v];
    if (!fn) {
      db.pragma(`user_version = ${v + 1}`);
      continue;
    }
    try {
      const apply = db.transaction(() => {
        fn(db);
        db.pragma(`user_version = ${v + 1}`);
      });
      apply();
    } catch (err) {
      console.error(`[db] migration v${v} → v${v + 1} failed:`, err.message);
      // Rethrow so the app surfaces the failure rather than booting
      // into a half-migrated DB. The transaction has already rolled
      // back; user_version remains at the prior value.
      throw err;
    }
  }
}

function databaseHasUserData() {
  // Brand-new databases skip the backup — there's nothing to lose,
  // and the file may not even exist on disk yet on first run.
  try {
    const file = getDatabasePath();
    if (!fs.existsSync(file)) return false;
    const stat = fs.statSync(file);
    if (stat.size < 4096) return false;
    const row = db.prepare('SELECT COUNT(*) AS n FROM saves').get();
    return row.n > 0;
  } catch {
    return false;
  }
}

function backupDatabaseBeforeMigrate(fromVersion) {
  try {
    const file = getDatabasePath();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.pre-v${fromVersion + 1}.${stamp}.bak`;
    fs.copyFileSync(file, backup);
    console.log(`[db] migration backup written: ${path.basename(backup)}`);
  } catch (err) {
    console.error('[db] migration backup failed (continuing):', err.message);
  }
}

function getDatabase() {
  if (!db) return initDatabase();
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
  // The cache belongs to the closed library's DB.
  invalidateEmbeddingCache();
}

// Closes the current handle and reopens against whatever library
// is now active in the registry. Called by the library-switch IPC
// after the registry's active id has been flipped.
function reopenDatabase() {
  closeDatabase();
  return initDatabase();
}

function insertSave({
  id,
  filePath,
  thumbPath,
  width,
  height,
  fileSize,
  sourceUrl,
  title,
  // Optional pre-populated notes — currently set by the X-bookmark
  // capture path with the tweet's caption text so the user sees the
  // tweet context in the detail panel right after the save lands.
  // The notes column is added via the saves-notes migration in
  // MIGRATIONS, so it's safe to write to here unconditionally.
  notes,
  // X-bookmark capture only. Object with keys authorName, authorHandle,
  // authorAvatarUrl, caption, imageUrls — see the content script
  // (extension/content/x-bookmark-watcher.js) and DetailPanel's tweet
  // card section for the consumer.
  tweetMeta,
  palette,
  contentHash,
  kind,
  // Capture origin — 'x' (default) or 'instagram'. Drives the per-card
  // source badge and the combined "Saved" view filter.
  source,
  // Optional explicit creation timestamp. Defaults to now. The extension
  // sync passes a descending clock so a newest-first social stream keeps
  // its order (newest social = newest in the app) instead of inverting.
  createdAt,
} = {}) {
  const db = getDatabase();
  const paletteArr = Array.isArray(palette) && palette.length ? palette : null;
  // Pre-compute LAB once on insert. filterByColor and the similar-by-
  // palette query both used to recompute these per swatch per call;
  // doing it once at save time pays off on the second filter onwards.
  const paletteLabArr = paletteArr
    ? paletteArr.map(hexToLab).filter(Boolean)
    : null;
  const record = {
    id: id || crypto.randomUUID(),
    file_path: filePath,
    thumb_path: thumbPath,
    title: title || null,
    notes: notes || null,
    source_url: sourceUrl || null,
    width: width || null,
    height: height || null,
    file_size: fileSize || null,
    palette: paletteArr ? JSON.stringify(paletteArr) : null,
    palette_lab: paletteLabArr && paletteLabArr.length
      ? JSON.stringify(paletteLabArr)
      : null,
    content_hash: contentHash || null,
    kind: kind || 'image',
    tweet_meta: tweetMeta ? JSON.stringify(tweetMeta) : null,
    source: source || 'x',
    created_at: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
  db.prepare(`
    INSERT INTO saves
      (id, file_path, thumb_path, title, notes, source_url, width, height, file_size, palette, palette_lab, content_hash, kind, tweet_meta, source, created_at)
    VALUES
      (@id, @file_path, @thumb_path, @title, @notes, @source_url, @width, @height, @file_size, @palette, @palette_lab, @content_hash, @kind, @tweet_meta, @source, @created_at)
  `).run(record);
  return record;
}

// Image saves eligible for the "reclaim space" sweep — non-trashed,
// non-video/url rows with a file on disk. The caller decides per row
// whether re-encoding actually saves space (and skips animated images).
function getReclaimableSaves() {
  return getDatabase()
    .prepare(
      `SELECT id, file_path, file_size
         FROM saves
        WHERE deleted_at IS NULL
          AND file_path IS NOT NULL
          AND kind NOT IN ('video', 'url')`,
    )
    .all();
}

// Repoint a save at its newly-optimized file. Used by the reclaim sweep
// after it has written + verified the optimized image. content_hash is
// deliberately left alone — it identifies the original source bytes for
// dedup, not the stored file.
function updateSaveStorage(id, { filePath, fileSize, width, height } = {}) {
  getDatabase()
    .prepare(
      `UPDATE saves
          SET file_path = @file_path, file_size = @file_size,
              width = @width, height = @height
        WHERE id = @id`,
    )
    .run({
      id,
      file_path: filePath,
      file_size: fileSize ?? null,
      width: width ?? null,
      height: height ?? null,
    });
}

// Find a non-trashed save by its SHA-256 hash. Returns the row or
// undefined. Trashed dupes are ignored on purpose — re-saving a
// previously-deleted image should produce a fresh entry rather than
// silently linking the user to a record they tossed.
function findSaveByHash(hash) {
  if (!hash) return undefined;
  const db = getDatabase();
  return db
    .prepare(
      'SELECT * FROM saves WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1',
    )
    .get(hash);
}

// Iterate rows that pre-date the content_hash column and fill in
// hashes from disk. Called once after init from a background task —
// libraries with thousands of images can take a few seconds, so we
// chunk and yield to avoid stalling the main thread's event loop.
async function backfillContentHashes({ batchSize = 50 } = {}) {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT id, file_path FROM saves WHERE content_hash IS NULL')
    .all();
  if (rows.length === 0) return 0;

  const fs = require('node:fs');
  const update = db.prepare('UPDATE saves SET content_hash = ? WHERE id = ?');
  let filled = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const tx = db.transaction(() => {
      for (const row of slice) {
        try {
          if (!fs.existsSync(row.file_path)) continue;
          const buf = fs.readFileSync(row.file_path);
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          update.run(hash, row.id);
          filled += 1;
        } catch (err) {
          console.error('[gatheros] hash backfill failed for', row.id, err.message);
        }
      }
    });
    tx();
    // Yield so the renderer's startup work isn't starved.
    await new Promise((r) => setImmediate(r));
  }
  return filled;
}

// ── Color search helpers ──────────────────────────────────────────────────
// Convert sRGB hex → CIELAB so we can measure perceptual distance.
// "Looks similar" in screen colors maps poorly to RGB Manhattan; LAB
// matches what designers mean when they say "find me anything in this
// red".

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  // sRGB → XYZ (D65)
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / 1.00000;
  const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(a, b) {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToLab(rgb[0], rgb[1], rgb[2]) : null;
}

// Parse the precomputed palette_lab JSON off a save row. Returns
// null on malformed / missing data so callers can fall through to
// regenerating from `palette`.
function parseStoredLabs(row) {
  if (!row || !row.palette_lab) return null;
  try {
    const parsed = JSON.parse(row.palette_lab);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch { return null; }
}

// Fallback: rebuild the LAB triplets from the legacy `palette` JSON
// for rows that haven't been backfilled yet.
function labsFromPalette(paletteJson) {
  if (!paletteJson) return null;
  let pal;
  try { pal = JSON.parse(paletteJson); } catch { return null; }
  if (!Array.isArray(pal)) return null;
  const labs = pal.map(hexToLab).filter(Boolean);
  return labs.length ? labs : null;
}

// Returns id only — palette filter runs in JS over the parsed swatches,
// applied as a post-filter on top of the SQL conditions below.
//
// `paletteLimit` is for the color-name search path (e.g. "blue") where
// we want strict "this image is dominated by that color" semantics —
// not "there's some near-grey in a shadow that happens to be near
// blue". Defaults to null = check every swatch (chip-click filter).
function filterByColor(saves, hex, threshold = 22, paletteLimit = null) {
  const target = hexToLab(hex);
  if (!target) return saves;
  return saves.filter((s) => {
    const labs = parseStoredLabs(s) || labsFromPalette(s.palette);
    if (!labs || labs.length === 0) return false;
    const swatches = paletteLimit ? labs.slice(0, paletteLimit) : labs;
    return swatches.some((lab) => deltaE76(target, lab) <= threshold);
  });
}

// view: 'all' (default — excludes trashed), 'unsorted' (no bucket
// membership, excludes trashed), or 'trash' (only trashed).
// Find saves that look like the anchor based on palette alone — no
// AI required. For each anchor swatch we take the closest swatch in
// the candidate's palette (ΔE76 in LAB) and average those distances;
// smaller average = more similar. Skips deleted rows and the anchor
// itself. Returns full save records sorted ascending by score.
function findSimilarByPalette(anchorId, limit = 24) {
  if (!anchorId) return [];
  const anchor = getSave(anchorId);
  if (!anchor) return [];
  // Pull anchor LABs from the precomputed column when available;
  // otherwise reconstruct from `palette` (covers the brief window
  // between schema upgrade and migration backfill, plus rows missing
  // a palette entirely).
  const anchorLabs = parseStoredLabs(anchor) || labsFromPalette(anchor.palette);
  if (!anchorLabs || anchorLabs.length === 0) return [];

  const db = getDatabase();
  const rows = db
    .prepare(
      'SELECT id, palette, palette_lab FROM saves WHERE deleted_at IS NULL AND id != ? AND palette IS NOT NULL',
    )
    .all(anchorId);

  const scored = [];
  for (const row of rows) {
    const labs = parseStoredLabs(row) || labsFromPalette(row.palette);
    if (!labs || labs.length === 0) continue;
    let total = 0;
    for (const a of anchorLabs) {
      let best = Infinity;
      for (const b of labs) {
        const d = deltaE76(a, b);
        if (d < best) best = d;
      }
      total += best;
    }
    scored.push({ id: row.id, score: total / anchorLabs.length });
  }

  // Hard cap on average ΔE — beyond ~28 the palettes have nothing
  // meaningful in common and the suggestions read as random.
  scored.sort((a, b) => a.score - b.score);
  const ids = scored
    .filter((s) => s.score <= 28)
    .slice(0, Math.max(1, Math.min(limit, 60)))
    .map((s) => s.id);
  if (ids.length === 0) return [];
  const records = getSavesByIds(ids);
  const orderById = new Map(ids.map((id, i) => [id, i]));
  records.sort((a, b) => orderById.get(a.id) - orderById.get(b.id));
  return records;
}

// Columns shipped to the renderer for list views — everything EXCEPT
// the search-only heavies the UI never reads: embedding (a ~6 KB
// Float32 BLOB per save), ocr_text and ai_description. With SELECT *,
// every grid reload serialized megabytes of them over IPC. palette_lab
// stays: filterByColor reads it off these rows before they leave the
// main process (it's a few dozen bytes of JSON). The semantic path has
// its own getSaveEmbeddings() query and is unaffected.
const SAVE_LIST_COLUMNS = [
  'id', 'file_path', 'thumb_path', 'title', 'source_url', 'width',
  'height', 'file_size', 'palette', 'palette_lab', 'created_at',
  'ai_prompt', 'deleted_at', 'meta', 'notes', 'content_hash', 'kind',
  'tweet_meta', 'source', 'preview_path', 'view_count',
].join(', ');

// Sanitize free text into an FTS5 phrase-prefix query: each whitespace
// term becomes "term"* (quotes doubled), joined with implicit AND.
// Returns null when nothing tokenizable remains.
function ftsPrefixQuery(text) {
  const terms = String(text)
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

function smartCategorySearchTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function smartCategoryLabelMatchesSearch(label, queryTokens) {
  const labelTokens = smartCategorySearchTokens(label);
  if (!labelTokens.length || !queryTokens.length) return false;
  if (queryTokens.length > 1 && labelTokens.join(' ').includes(queryTokens.join(' '))) {
    return true;
  }
  return queryTokens.every((queryToken) => (
    labelTokens.some((labelToken) => (
      labelToken === queryToken
      || (queryToken.length >= 3 && labelToken.startsWith(queryToken))
    ))
  ));
}

function getSmartCategorySearchCategoryIds(text) {
  const queryTokens = smartCategorySearchTokens(text);
  if (!queryTokens.length) return [];
  const rows = getDatabase()
    .prepare(`
      SELECT c.id, c.name, a.alias
      FROM smart_categories c
      LEFT JOIN smart_category_aliases a ON a.category_id = c.id
      WHERE c.status = 'visible'
      ORDER BY c.updated_at DESC
    `)
    .all();
  const labelsById = new Map();
  for (const row of rows) {
    if (!labelsById.has(row.id)) labelsById.set(row.id, []);
    labelsById.get(row.id).push(row.name);
    if (row.alias) labelsById.get(row.id).push(row.alias);
  }
  return [...labelsById.entries()]
    .filter(([, labels]) => (
      labels.some((label) => smartCategoryLabelMatchesSearch(label, queryTokens))
    ))
    .map(([id]) => id);
}

function getSmartCategorySearchExpandedSaves({
  text,
  baseConditions,
  baseParams,
  sort,
} = {}) {
  const categoryIds = getSmartCategorySearchCategoryIds(text);
  if (!categoryIds.length) return [];
  const categoryPlaceholders = categoryIds.map(() => '?').join(', ');
  const baseWhere = baseConditions.length ? ` WHERE ${baseConditions.join(' AND ')}` : '';
  const recency = sort === 'oldest' ? 's.created_at ASC' : 's.created_at DESC';
  const selectColumns = SAVE_LIST_COLUMNS
    .split(', ')
    .map((column) => `s.${column}`)
    .join(', ');
  return getDatabase()
    .prepare(`
      SELECT ${selectColumns},
             MAX(m.weight) AS smart_category_search_weight
      FROM smart_category_members m
      JOIN saves s
        ON s.id = m.save_id
      WHERE m.category_id IN (${categoryPlaceholders})
        AND m.weight >= ?
        AND s.id IN (SELECT id FROM saves${baseWhere})
      GROUP BY s.id
      ORDER BY smart_category_search_weight DESC, ${recency}
    `)
    .all(...categoryIds, SMART_CATEGORY_PRIMARY_WEIGHT, ...baseParams);
}

function appendSmartCategorySearchRows(directRows, expandedRows) {
  if (!expandedRows.length) return directRows;
  const seen = new Set(directRows.map((row) => row.id));
  const merged = directRows.slice();
  for (const row of expandedRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

function getAllSaves({ search = '', sort = 'newest', collectionId = null, colorHex = null, view = 'all', _noFts = false } = {}) {
  const db = getDatabase();
  const conditions = [];
  const params = [];

  // Parse `tag:`, `bucket:`, `color:`, `is:untagged`, `before:`, `after:`
  // out of the search string so the SQL applies them directly. The
  // remaining `text` is what runs through the substring LIKE pass.
  const { parseSearchQuery } = require('./searchQuery');
  const parsed = parseSearchQuery(search);
  const text = parsed.text;
  // Explicit color: filter wins over any caller-passed colorHex
  // because the user typed it directly.
  const effectiveColorHex = parsed.colorHex || colorHex;

  if (view === 'trash') {
    conditions.push('deleted_at IS NOT NULL');
  } else {
    conditions.push('deleted_at IS NULL');
    if (view === 'unsorted') {
      conditions.push('id NOT IN (SELECT save_id FROM collection_items)');
    } else if (view === 'bookmarks') {
      // The combined "Saved" view — saves captured from X (tagged
      // 'bookmark') or Instagram (tagged 'instagram'). The legacy
      // namespaced tags are kept in the filter as a safety net for any
      // row a tag-rename migration didn't reach. The view key stays
      // 'bookmarks' for back-compat; the chip label reads "Saved".
      conditions.push(`id IN (
        SELECT save_id FROM save_tags
        JOIN tags ON save_tags.tag_id = tags.id
        WHERE tags.name IN ('bookmark', 'instagram', 'x:bookmark', 'instagram:save')
      )`);
    } else if (view === 'onThisDay') {
      // Same calendar month + day as today, in any prior year. Local
      // time so a save made yesterday at 11pm doesn't slip into the
      // wrong bucket because of UTC math. Excludes today's saves so
      // the view reads as 'memories', not 'recent activity'.
      conditions.push(
        "strftime('%m-%d', created_at / 1000, 'unixepoch', 'localtime')"
        + " = strftime('%m-%d', 'now', 'localtime')",
      );
      conditions.push(
        "strftime('%Y', created_at / 1000, 'unixepoch', 'localtime')"
        + " < strftime('%Y', 'now', 'localtime')",
      );
    }
  }

  if (collectionId) {
    // Roll-up semantics: a parent collection CONTAINS its children, so
    // its view shows direct members plus every child's members (the IN
    // over both dedups naturally). One level deep, like the schema.
    conditions.push(`id IN (
      SELECT save_id FROM collection_items
      WHERE collection_id = ?
         OR collection_id IN (SELECT id FROM collections WHERE parent_id = ?)
    )`);
    params.push(collectionId, collectionId);
  }

  // tag:<name> — INNER JOIN through save_tags. Multiple tag filters
  // AND together so `tag:serif tag:minimal` returns the intersection.
  for (const name of parsed.tagNames) {
    conditions.push(`id IN (
      SELECT save_id FROM save_tags
      JOIN tags ON save_tags.tag_id = tags.id
      WHERE tags.name = ?
    )`);
    params.push(name);
  }

  // bucket:<name> — resolve via collections.name (case-insensitive).
  // Multiple bucket filters intersect, same as tags.
  for (const name of parsed.bucketNames) {
    // Same roll-up as the collectionId filter: collection:"Branding"
    // matches saves filed in Branding OR any of its children.
    conditions.push(`id IN (
      SELECT save_id FROM collection_items
      WHERE collection_id IN (
        SELECT id FROM collections WHERE LOWER(name) = ?
        UNION
        SELECT id FROM collections WHERE parent_id IN (SELECT id FROM collections WHERE LOWER(name) = ?)
      )
    )`);
    params.push(name, name);
  }

  if (parsed.untagged) {
    conditions.push('id NOT IN (SELECT save_id FROM save_tags WHERE save_id IS NOT NULL)');
  }

  if (parsed.before != null) {
    conditions.push('created_at < ?');
    params.push(parsed.before);
  }
  if (parsed.after != null) {
    conditions.push('created_at > ?');
    params.push(parsed.after);
  }

  const baseConditions = conditions.slice();
  const baseParams = params.slice();

  if (text) {
    // Indexed FTS5 match over title / ocr_text / tweet text (the old
    // LIKE pass full-scanned the table and json_extract-parsed
    // tweet_meta per row on every keystroke). ai_description stays
    // intentionally excluded — descriptions enumerate every visible
    // object, so matching them turns "sky" into a 50% hit rate.
    // Tag-name matching keeps the substring LIKE (tags is tiny).
    // ftsQuery is null for punctuation-only input; _noFts is the
    // fallback escape hatch if an FTS query ever errors at run time.
    const ftsQuery = _noFts ? null : ftsPrefixQuery(text);
    if (ftsQuery) {
      conditions.push(`(id IN (SELECT save_id FROM saves_fts WHERE saves_fts MATCH ?)
        OR id IN (
          SELECT save_id FROM save_tags
          JOIN tags ON save_tags.tag_id = tags.id
          WHERE tags.name LIKE ?
        ))`);
      params.push(ftsQuery, `%${text}%`);
    } else {
      const safeTweetMeta = safeJsonExpr('tweet_meta');
      conditions.push(`(title LIKE ? OR ocr_text LIKE ?
        OR json_extract(${safeTweetMeta}, '$.caption') LIKE ?
        OR json_extract(${safeTweetMeta}, '$.authorName') LIKE ?
        OR json_extract(${safeTweetMeta}, '$.authorHandle') LIKE ?
        OR json_extract(${safeTweetMeta}, '$.thread') LIKE ?
        OR json_extract(${safeTweetMeta}, '$.quoted.caption') LIKE ?
        OR json_extract(${safeTweetMeta}, '$.quoted.authorName') LIKE ?
        OR json_extract(${safeTweetMeta}, '$.quoted.authorHandle') LIKE ?
        OR id IN (
          SELECT save_id FROM save_tags
          JOIN tags ON save_tags.tag_id = tags.id
          WHERE tags.name LIKE ?
        ))`);
      const like = `%${text}%`;
      params.push(like, like, like, like, like, like, like, like, like, like);
    }
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const recency = sort === 'oldest' ? 'created_at ASC' : 'created_at DESC';
  let order;
  if (text) {
    // Relevance first: a save the user literally NAMED like the query
    // should outrank items that only mention it in a tweet caption or
    // OCR text. Exact title → prefix → any-substring → everything else,
    // then the chosen recency sort within each tier. The ORDER BY params
    // are bound after the WHERE params (positional), so push them here.
    order = ` ORDER BY
      CASE
        WHEN LOWER(COALESCE(title,'')) = LOWER(?) THEN 0
        WHEN LOWER(COALESCE(title,'')) LIKE LOWER(?) || '%' THEN 1
        WHEN LOWER(COALESCE(title,'')) LIKE '%' || LOWER(?) || '%' THEN 2
        ELSE 3
      END, ${recency}`;
    params.push(text, text, text);
  } else {
    order = ` ORDER BY ${recency}`;
  }
  let rows;
  try {
    rows = db.prepare(`SELECT ${SAVE_LIST_COLUMNS} FROM saves${where}${order}`).all(...params);
  } catch (err) {
    // Belt-and-braces: a malformed FTS MATCH shouldn't be possible with
    // the sanitized phrase-prefix form, but if one slips through, run
    // the legacy LIKE pass rather than failing the whole search.
    if (!_noFts && text) {
      console.warn('[db] FTS search failed, falling back to LIKE:', err.message);
      return getAllSaves({ search, sort, collectionId, colorHex, view, _noFts: true });
    }
    throw err;
  }
  if (text) {
    rows = appendSmartCategorySearchRows(
      rows,
      getSmartCategorySearchExpandedSaves({
        text,
        baseConditions,
        baseParams,
        sort,
      }),
    );
  }
  // Color filter: requested hex matched against each save's stored
  // palette in LAB space. Done in JS because SQLite doesn't have the
  // math we need; tractable up to a few thousand saves.
  return effectiveColorHex ? filterByColor(rows, effectiveColorHex) : rows;
}

// Fire-and-forget view bump. Deliberately does NOT emit save:updated —
// a view count changing shouldn't reflow the grid mid-session; the new
// order applies on the next reload.
function markSaveViewed(id) {
  if (!id) return;
  getDatabase()
    .prepare('UPDATE saves SET view_count = COALESCE(view_count, 0) + 1, viewed_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

// Most-recently-opened saves, newest view first. Powers the command
// palette's "Recently viewed" strip. Only rows actually opened (a
// viewed_at timestamp) qualify.
function getRecentlyViewed(limit = 12) {
  const n = Math.max(1, Math.min(50, Number(limit) || 12));
  return getDatabase()
    .prepare(`SELECT ${SAVE_LIST_COLUMNS} FROM saves
       WHERE deleted_at IS NULL AND viewed_at IS NOT NULL
       ORDER BY viewed_at DESC LIMIT ?`)
    .all(n);
}

function getSave(id) {
  return getDatabase().prepare('SELECT * FROM saves WHERE id = ?').get(id);
}

// ── Tweet tombstones ─────────────────────────────────────────────
// A stable per-tweet key from a status permalink, e.g.
// https://x.com/foo/status/123 → 'tw:123'. Non-tweet URLs → null, so
// only X bookmarks ever get tombstoned.
function tweetKeyFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
  return m ? `tw:${m[1]}` : null;
}

// An Instagram permalink → a stable per-post key, e.g.
// https://www.instagram.com/p/Cabc123/ → 'ig:Cabc123'. Covers posts
// (/p/), reels (/reel/), and IGTV (/tv/). Non-IG URLs → null. The
// dismissed_tweets table is source-agnostic (keyed by an opaque
// string) so Instagram saves tombstone through the same machinery as
// X bookmarks — a deleted IG save won't come back on the next sync.
function igKeyFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
  return m ? `ig:${m[1]}` : null;
}

// Source-agnostic tombstone key — resolves an X status OR an Instagram
// post permalink to its key. Used by delete/restore so deletions stick
// for either source.
function sourceKeyFromUrl(url) {
  return tweetKeyFromUrl(url) || igKeyFromUrl(url);
}

function isTweetDismissed(key) {
  if (!key) return false;
  return !!getDatabase()
    .prepare('SELECT 1 FROM dismissed_tweets WHERE tweet_key = ?')
    .get(key);
}

function dismissTweet(key) {
  if (!key) return;
  getDatabase()
    .prepare('INSERT OR IGNORE INTO dismissed_tweets (tweet_key, dismissed_at) VALUES (?, ?)')
    .run(key, Date.now());
}

function undismissTweet(key) {
  if (!key) return;
  getDatabase().prepare('DELETE FROM dismissed_tweets WHERE tweet_key = ?').run(key);
}

// Soft delete: marks the row as trashed and severs every bucket
// membership in the same transaction. The image and thumbnail files
// stay on disk until the user permanently deletes from Trash (or
// empties Trash). Restoring from trash brings the save back as a
// bucket-less item — by design, deleting is treated as "this is no
// longer part of any collection," not just "hide it temporarily."
function deleteSave(id) {
  const db = getDatabase();
  const save = db.prepare('SELECT id, source_url FROM saves WHERE id = ?').get(id);
  if (!save) return { ok: false };
  // Tombstone the source post so the watcher doesn't re-capture it the
  // next time it scrolls into view. No-op for saves with no X/IG
  // permalink.
  dismissTweet(sourceKeyFromUrl(save.source_url));
  const tx = db.transaction(() => {
    db.prepare('UPDATE saves SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    db.prepare('DELETE FROM collection_items WHERE save_id = ?').run(id);
    // board_items reference saves via a JSON blob (data.saveId) so
    // there's no FK to cascade — trash any image item that points
    // at this save so it stops rendering on every board it was on.
    db.prepare(
      `DELETE FROM board_items
       WHERE type = 'image'
         AND json_extract(data, '$.saveId') = ?`
    ).run(id);
  });
  tx();
  return { ok: true };
}

function restoreSave(id) {
  const db = getDatabase();
  const save = db.prepare('SELECT source_url FROM saves WHERE id = ?').get(id);
  // Bringing a save back out of trash lifts its tombstone so it's
  // allowed to sync again.
  if (save) undismissTweet(sourceKeyFromUrl(save.source_url));
  db.prepare('UPDATE saves SET deleted_at = NULL WHERE id = ?').run(id);
  return { ok: true };
}

// Hard delete: removes the DB row and returns the file paths so the
// caller (ipc.js) can unlink the underlying files.
function permanentlyDeleteSave(id) {
  invalidateEmbeddingCache();
  const db = getDatabase();
  const save = db.prepare('SELECT file_path, thumb_path, source_url FROM saves WHERE id = ?').get(id);
  if (!save) return { ok: false };
  // Keep the tombstone for permanently-removed saves.
  dismissTweet(sourceKeyFromUrl(save.source_url));
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM board_items
       WHERE type = 'image'
         AND json_extract(data, '$.saveId') = ?`
    ).run(id);
    db.prepare('DELETE FROM saves WHERE id = ?').run(id);
  });
  tx();
  return { ok: true, filePath: save.file_path, thumbPath: save.thumb_path };
}

function emptyTrash() {
  invalidateEmbeddingCache();
  const db = getDatabase();
  const rows = db
    .prepare('SELECT id, file_path, thumb_path FROM saves WHERE deleted_at IS NOT NULL')
    .all();
  if (rows.length === 0) return { ok: true, files: [], ids: [] };
  const ids = rows.map((r) => r.id);
  const tx = db.transaction(() => {
    // Sweep any orphaned board_items whose saveId is among the
    // trashed rows we're about to nuke. (deleteSave already cleans
    // these up on trash, but be defensive in case anything slipped
    // past — e.g. saves trashed before this code shipped.)
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM board_items
       WHERE type = 'image'
         AND json_extract(data, '$.saveId') IN (${placeholders})`
    ).run(...ids);
    db.prepare('DELETE FROM saves WHERE deleted_at IS NOT NULL').run();
  });
  tx();
  return {
    ok: true,
    ids,
    files: rows.map((r) => ({ filePath: r.file_path, thumbPath: r.thumb_path })),
  };
}

// Auto-purge variant: deletes only the trashed rows older than
// `cutoff` ms (deleted_at < cutoff). Honors the Settings →
// "Auto-empty trash" retention pref. Returns the same shape as
// emptyTrash so the caller can unlink the files.
function purgeTrashBefore(cutoff) {
  const db = getDatabase();
  const rows = db
    .prepare(
      'SELECT id, file_path, thumb_path FROM saves WHERE deleted_at IS NOT NULL AND deleted_at < ?',
    )
    .all(cutoff);
  if (rows.length === 0) return { ok: true, files: [], ids: [] };
  const ids = rows.map((r) => r.id);
  const tx = db.transaction(() => {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM board_items
       WHERE type = 'image'
         AND json_extract(data, '$.saveId') IN (${placeholders})`
    ).run(...ids);
    db.prepare(
      `DELETE FROM saves WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    ).run(cutoff);
  });
  tx();
  return {
    ok: true,
    ids,
    files: rows.map((r) => ({ filePath: r.file_path, thumbPath: r.thumb_path })),
  };
}

// Nuclear "Erase Library" — wipes every save (including trashed
// ones), every bucket, every tag, in one transaction. Returns the
// list of file paths so ipc.js can unlink them off disk afterward.
// Caller is responsible for guarding behind a confirmation prompt.
function wipeLibrary() {
  invalidateEmbeddingCache();
  const db = getDatabase();
  const rows = db.prepare('SELECT file_path, thumb_path FROM saves').all();
  const tx = db.transaction(() => {
    // collection_items / save_tags / save_embeddings cascade off
    // saves and collections via the schema's ON DELETE CASCADE.
    // boards + board_items don't FK to saves (image references live
    // in JSON data), so wipe them explicitly — board_items cascades
    // off boards.
    db.prepare('DELETE FROM saves').run();
    db.prepare('DELETE FROM collections').run();
    db.prepare('DELETE FROM tags').run();
    db.prepare('DELETE FROM boards').run();
  });
  tx();
  return {
    ok: true,
    files: rows.map((r) => ({ filePath: r.file_path, thumbPath: r.thumb_path })),
  };
}

function updateSave({ id, title, sourceUrl, aiDescription, ocrText, aiPrompt, embedding, meta, notes } = {}) {
  const db = getDatabase();
  const fields = [];
  const params = [];
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (sourceUrl !== undefined) { fields.push('source_url = ?'); params.push(sourceUrl); }
  if (aiDescription !== undefined) { fields.push('ai_description = ?'); params.push(aiDescription); }
  if (ocrText !== undefined) { fields.push('ocr_text = ?'); params.push(ocrText); }
  if (aiPrompt !== undefined) { fields.push('ai_prompt = ?'); params.push(aiPrompt); }
  if (embedding !== undefined) {
    fields.push('embedding = ?');
    params.push(embedding);
    invalidateEmbeddingCache();
  }
  if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
  if (meta !== undefined) {
    // Accept either a JSON string or an object — better-sqlite3 only
    // binds primitives, so any object gets serialized here.
    const v = meta == null ? null : (typeof meta === 'string' ? meta : JSON.stringify(meta));
    fields.push('meta = ?'); params.push(v);
  }
  if (!fields.length) return { ok: true };
  params.push(id);
  db.prepare(`UPDATE saves SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return { ok: true };
}

// Returns id + embedding (BLOB) for every save that has one. Used by
// the semantic-search ranker to compute cosine sim in JS — fine up to
// a few thousand saves; revisit if that scales out.
// Counts that drive the sidebar's smart-view badges:
//   all:      all non-trashed saves
//   unsorted: non-trashed saves that aren't in any bucket
//   trash:    soft-deleted saves
function getSmartViewCounts() {
  const db = getDatabase();
  const all = db.prepare('SELECT COUNT(*) AS n FROM saves WHERE deleted_at IS NULL').get();
  const unsorted = db.prepare(`
    SELECT COUNT(*) AS n FROM saves
    WHERE deleted_at IS NULL
      AND id NOT IN (SELECT save_id FROM collection_items)
  `).get();
  const trash = db.prepare('SELECT COUNT(*) AS n FROM saves WHERE deleted_at IS NOT NULL').get();
  const bookmarks = db.prepare(`
    SELECT COUNT(*) AS n FROM saves
    WHERE deleted_at IS NULL
      AND id IN (
        SELECT save_id FROM save_tags
        JOIN tags ON save_tags.tag_id = tags.id
        WHERE tags.name IN ('bookmark', 'instagram', 'x:bookmark', 'instagram:save')
      )
  `).get();
  // Saves whose calendar date matches today in some prior year — same
  // condition the 'onThisDay' view applies in getAllSaves.
  const onThisDay = db.prepare(`
    SELECT COUNT(*) AS n FROM saves
    WHERE deleted_at IS NULL
      AND strftime('%m-%d', created_at / 1000, 'unixepoch', 'localtime')
        = strftime('%m-%d', 'now', 'localtime')
      AND strftime('%Y', created_at / 1000, 'unixepoch', 'localtime')
        < strftime('%Y', 'now', 'localtime')
  `).get();
  return {
    all: all?.n ?? 0,
    unsorted: unsorted?.n ?? 0,
    trash: trash?.n ?? 0,
    bookmarks: bookmarks?.n ?? 0,
    onThisDay: onThisDay?.n ?? 0,
  };
}

function getSaveEmbeddings() {
  return getDatabase()
    .prepare('SELECT id, embedding FROM saves WHERE embedding IS NOT NULL')
    .all();
}

// ── In-memory embedding cache ──────────────────────────────────────
// Semantic search and find-similar used to re-read and re-parse every
// embedding BLOB from SQLite on every query. Cache them once as
// pre-NORMALIZED Float32Arrays so cosine similarity reduces to a dot
// product. ~6 KB per save → ~60 MB at 10k saves, main-process only.
// Trashed saves stay in the cache on purpose: scored candidates are
// intersected with live rows downstream, and keeping them means a
// restore needs no invalidation.
let embeddingCache = null;

function invalidateEmbeddingCache() {
  embeddingCache = null;
}

function normalizeEmbedding(buf) {
  const src = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const out = new Float32Array(src.length);
  let norm = 0;
  for (let i = 0; i < src.length; i += 1) norm += src[i] * src[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] / norm;
  return out;
}

function getSaveEmbeddingsCached() {
  if (embeddingCache) return embeddingCache;
  embeddingCache = getSaveEmbeddings().map((r) => ({
    id: r.id,
    vec: normalizeEmbedding(r.embedding),
  }));
  return embeddingCache;
}

// ── Smart categories ─────────────────────────────────────────────
// Internal classifier-owned lenses. These helpers deliberately do not
// touch tags, folders, boards, search, or import behavior.

const SMART_CATEGORY_STATUSES = new Set(['candidate', 'visible', 'hidden', 'archived']);
const SMART_CATEGORY_CHANGE_KINDS = new Set(['created', 'renamed', 'merged', 'split']);
const SMART_CATEGORY_PRIMARY_WEIGHT = 0.75;
const SMART_CATEGORY_NAV_MIN_PRIMARY_MEMBERS = 5;
const SMART_CATEGORY_RECENT_CHANGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function clampUnit(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function jsonString(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeSmartCategory(row) {
  if (!row) return null;
  return {
    ...row,
    frozen_name: !!row.frozen_name,
  };
}

function normalizeTopicProfile(row) {
  if (!row) return null;
  return {
    ...row,
    concepts: parseJsonField(row.concepts, []),
  };
}

function normalizeMembership(row) {
  if (!row) return null;
  return {
    ...row,
    evidence: parseJsonField(row.evidence, row.evidence || null),
  };
}

function createSmartCategory({
  id,
  name,
  description,
  status = 'candidate',
  parentId = null,
  centroidEmbedding = null,
  visibilityScore = 0,
  memberCount = 0,
  createdAt,
  updatedAt,
  lastChangedAt,
  changeKind = 'created',
  frozenName = false,
} = {}) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'missing-name' };
  if (!SMART_CATEGORY_STATUSES.has(status)) return { ok: false, reason: 'invalid-status' };
  if (changeKind != null && !SMART_CATEGORY_CHANGE_KINDS.has(changeKind)) {
    return { ok: false, reason: 'invalid-change-kind' };
  }
  const now = Date.now();
  const record = {
    id: id || crypto.randomUUID(),
    name: trimmed,
    description: description || null,
    status,
    parent_id: parentId || null,
    centroid_embedding: centroidEmbedding || null,
    visibility_score: clampUnit(visibilityScore),
    member_count: Math.max(0, Number(memberCount) || 0),
    created_at: Number.isFinite(createdAt) ? createdAt : now,
    updated_at: Number.isFinite(updatedAt) ? updatedAt : now,
    last_changed_at: Number.isFinite(lastChangedAt) ? lastChangedAt : now,
    change_kind: changeKind || null,
    frozen_name: frozenName ? 1 : 0,
  };
  getDatabase().prepare(`
    INSERT INTO smart_categories
      (id, name, description, status, parent_id, centroid_embedding,
       visibility_score, member_count, created_at, updated_at,
       last_changed_at, change_kind, frozen_name)
    VALUES
      (@id, @name, @description, @status, @parent_id, @centroid_embedding,
       @visibility_score, @member_count, @created_at, @updated_at,
       @last_changed_at, @change_kind, @frozen_name)
  `).run(record);
  return { ok: true, category: normalizeSmartCategory(record) };
}

function getSmartCategory(id) {
  return normalizeSmartCategory(
    getDatabase().prepare('SELECT * FROM smart_categories WHERE id = ?').get(id),
  );
}

function updateSmartCategoryCentroidEmbedding({
  categoryId,
  centroidEmbedding = null,
  updatedAt,
} = {}) {
  if (!categoryId || !centroidEmbedding) return { ok: false, reason: 'missing-centroid' };
  const at = Number.isFinite(updatedAt) ? updatedAt : Date.now();
  const { changes } = getDatabase()
    .prepare('UPDATE smart_categories SET centroid_embedding = ?, updated_at = ? WHERE id = ?')
    .run(centroidEmbedding, at, categoryId);
  return { ok: changes > 0, reason: changes > 0 ? null : 'not-found' };
}

function listSmartCategories({ status = null, includeArchived = false } = {}) {
  const params = [];
  const where = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  } else if (!includeArchived) {
    where.push("status != 'archived'");
  }
  const sql = `SELECT * FROM smart_categories${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY frozen_name DESC, visibility_score DESC, updated_at DESC`;
  return getDatabase().prepare(sql).all(...params).map(normalizeSmartCategory);
}

function listNavigableSmartCategories({
  minPrimaryMembers = SMART_CATEGORY_NAV_MIN_PRIMARY_MEMBERS,
  minVisibilityScore = 0,
  recentChangeWindowMs = SMART_CATEGORY_RECENT_CHANGE_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const minMembers = Math.max(1, Number(minPrimaryMembers) || SMART_CATEGORY_NAV_MIN_PRIMARY_MEMBERS);
  const minScore = clampUnit(minVisibilityScore, 0);
  const at = Number.isFinite(now) ? now : Date.now();
  const changeWindow = Math.max(0, Number(recentChangeWindowMs) || 0);
  return getDatabase()
    .prepare(`
      SELECT c.*,
             COUNT(m.save_id) AS primary_member_count
        FROM smart_categories c
        JOIN smart_category_members m
          ON m.category_id = c.id
         AND m.weight >= ?
        JOIN saves s
          ON s.id = m.save_id
         AND s.deleted_at IS NULL
       WHERE c.status = 'visible'
         AND c.visibility_score > ?
       GROUP BY c.id
      HAVING primary_member_count >= ?
       ORDER BY c.frozen_name DESC,
                c.visibility_score DESC,
                primary_member_count DESC,
                c.updated_at DESC
    `)
    .all(SMART_CATEGORY_PRIMARY_WEIGHT, minScore, minMembers)
    .map((row) => {
      const category = normalizeSmartCategory(row);
      const changedAt = Number(category.last_changed_at) || 0;
      const recent = category.change_kind === 'renamed'
        && changedAt > 0
        && at >= changedAt
        && at - changedAt <= changeWindow;
      let note = null;
      if (recent) {
        const oldName = getDatabase()
          .prepare(`
            SELECT alias FROM smart_category_aliases
            WHERE category_id = ? AND source = 'old_name'
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .get(category.id)?.alias;
        note = oldName
          ? `Renamed from "${oldName}". Old name still works in search.`
          : 'Renamed recently. Old names still work in search.';
      }
      return {
        ...category,
        primary_member_count: Number(row.primary_member_count) || 0,
        recent_change: recent,
        recent_change_kind: recent ? category.change_kind : null,
        recent_change_note: note,
      };
    });
}

function setSmartCategoryStatus(id, status, { restoreHidden = false, rebuild = false } = {}) {
  if (!id || !SMART_CATEGORY_STATUSES.has(status)) return { ok: false };
  const current = getSmartCategory(id);
  if (!current) return { ok: false, reason: 'not-found' };
  if (
    current.status === 'hidden'
    && (status === 'visible' || status === 'candidate')
    && !restoreHidden
    && !rebuild
  ) {
    return { ok: false, reason: 'hidden-requires-restore' };
  }
  const now = Date.now();
  const { changes } = getDatabase()
    .prepare('UPDATE smart_categories SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, id);
  return { ok: changes > 0 };
}

function hideSmartCategory(id) {
  return setSmartCategoryStatus(id, 'hidden');
}

function archiveSmartCategory(id) {
  return setSmartCategoryStatus(id, 'archived');
}

function restoreSmartCategory(id, { status = 'visible' } = {}) {
  return setSmartCategoryStatus(id, status, { restoreHidden: true });
}

function pinSmartCategory(id, pinned = true) {
  if (!id) return { ok: false };
  const now = Date.now();
  const { changes } = getDatabase()
    .prepare('UPDATE smart_categories SET frozen_name = ?, updated_at = ? WHERE id = ?')
    .run(pinned ? 1 : 0, now, id);
  return { ok: changes > 0 };
}

function renameSmartCategory({
  id,
  name,
  automatic = true,
  changedAt,
} = {}) {
  const trimmed = (name || '').trim();
  if (!id) return { ok: false, reason: 'missing-id' };
  if (!trimmed) return { ok: false, reason: 'missing-name' };
  const current = getSmartCategory(id);
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.frozen_name && automatic) {
    return { ok: false, reason: 'name-frozen' };
  }
  if (current.name === trimmed) {
    return { ok: true, renamed: false, category: current };
  }

  const at = Number.isFinite(changedAt) ? changedAt : Date.now();
  const tx = getDatabase().transaction(() => {
    upsertSmartCategoryAlias({
      categoryId: id,
      alias: current.name,
      source: 'old_name',
      createdAt: at,
    });
    getDatabase()
      .prepare(`
        UPDATE smart_categories
           SET name = ?,
               updated_at = ?,
               last_changed_at = ?,
               change_kind = 'renamed'
         WHERE id = ?
      `)
      .run(trimmed, at, at, id);
  });
  tx();
  return { ok: true, renamed: true, category: getSmartCategory(id) };
}

function upsertSmartCategoryAlias({
  id,
  categoryId,
  alias,
  source = 'model_synonym',
  createdAt,
} = {}) {
  const trimmed = (alias || '').trim();
  if (!categoryId || !trimmed) return { ok: false };
  const record = {
    id: id || crypto.randomUUID(),
    category_id: categoryId,
    alias: trimmed,
    source,
    created_at: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
  getDatabase().prepare(`
    INSERT INTO smart_category_aliases (id, category_id, alias, source, created_at)
    VALUES (@id, @category_id, @alias, @source, @created_at)
    ON CONFLICT(category_id, alias) DO UPDATE SET
      source = excluded.source,
      created_at = excluded.created_at
  `).run(record);
  return { ok: true, alias: record };
}

function applySmartCategoryTaxonomyChanges({ renames = [], aliases = [], changedAt } = {}) {
  const at = Number.isFinite(changedAt) ? changedAt : Date.now();
  let renamedCount = 0;
  let aliasCount = 0;
  const tx = getDatabase().transaction(() => {
    for (const rename of Array.isArray(renames) ? renames : []) {
      const result = renameSmartCategory({
        id: rename.id,
        name: rename.name,
        automatic: rename.automatic !== false,
        changedAt: Number.isFinite(rename.changedAt) ? rename.changedAt : at,
      });
      if (!result?.ok) throw new Error(result?.reason || 'rename-failed');
      if (result.renamed !== false) renamedCount += 1;
    }
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      const result = upsertSmartCategoryAlias({
        categoryId: alias.categoryId,
        alias: alias.alias,
        source: alias.source || 'model_synonym',
        createdAt: Number.isFinite(alias.createdAt) ? alias.createdAt : at,
      });
      if (!result?.ok) throw new Error(result?.reason || 'alias-failed');
      aliasCount += 1;
    }
  });
  try {
    tx();
  } catch (err) {
    return { ok: false, reason: err?.message || 'taxonomy-apply-failed' };
  }
  return { ok: true, renamedCount, aliasCount };
}

function getSmartCategoryAliases(categoryId) {
  return getDatabase()
    .prepare('SELECT * FROM smart_category_aliases WHERE category_id = ? ORDER BY alias ASC')
    .all(categoryId);
}

function findSmartCategoryAliases(alias) {
  const q = (alias || '').trim();
  if (!q) return [];
  return getDatabase()
    .prepare(`
      SELECT a.*, c.name AS category_name, c.status AS category_status
      FROM smart_category_aliases a
      JOIN smart_categories c ON c.id = a.category_id
      WHERE LOWER(a.alias) = LOWER(?)
      ORDER BY c.updated_at DESC
    `)
    .all(q);
}

function upsertSaveTopicProfile({
  saveId,
  concepts = [],
  contentType = null,
  intentGuess = null,
  summary = null,
  embedding = null,
  confidence = 0,
  updatedAt,
} = {}) {
  if (!saveId) return { ok: false };
  const record = {
    save_id: saveId,
    concepts: jsonString(Array.isArray(concepts) ? concepts : [], '[]'),
    content_type: contentType || null,
    intent_guess: intentGuess || null,
    summary: summary || null,
    embedding: embedding || null,
    confidence: clampUnit(confidence),
    updated_at: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
  getDatabase().prepare(`
    INSERT INTO save_topic_profiles
      (save_id, concepts, content_type, intent_guess, summary, embedding, confidence, updated_at)
    VALUES
      (@save_id, @concepts, @content_type, @intent_guess, @summary, @embedding, @confidence, @updated_at)
    ON CONFLICT(save_id) DO UPDATE SET
      concepts = excluded.concepts,
      content_type = excluded.content_type,
      intent_guess = excluded.intent_guess,
      summary = excluded.summary,
      embedding = excluded.embedding,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `).run(record);
  return { ok: true, profile: normalizeTopicProfile(record) };
}

function getSaveTopicProfile(saveId) {
  return normalizeTopicProfile(
    getDatabase().prepare('SELECT * FROM save_topic_profiles WHERE save_id = ?').get(saveId),
  );
}

function upsertSmartCategoryMembership({
  categoryId,
  saveId,
  weight,
  evidence = null,
  assignedAt,
  updatedAt,
} = {}) {
  if (!categoryId || !saveId) return { ok: false };
  const now = Date.now();
  const record = {
    category_id: categoryId,
    save_id: saveId,
    weight: clampUnit(weight),
    evidence: jsonString(evidence, null),
    assigned_at: Number.isFinite(assignedAt) ? assignedAt : now,
    updated_at: Number.isFinite(updatedAt) ? updatedAt : now,
  };
  getDatabase().prepare(`
    INSERT INTO smart_category_members
      (category_id, save_id, weight, evidence, assigned_at, updated_at)
    VALUES
      (@category_id, @save_id, @weight, @evidence, @assigned_at, @updated_at)
    ON CONFLICT(category_id, save_id) DO UPDATE SET
      weight = excluded.weight,
      evidence = excluded.evidence,
      updated_at = excluded.updated_at
  `).run(record);
  getDatabase().prepare(`
    UPDATE smart_categories
       SET member_count = (
         SELECT COUNT(*) FROM smart_category_members
         WHERE category_id = ? AND weight >= 0.45
       ),
       updated_at = ?
     WHERE id = ?
  `).run(categoryId, now, categoryId);
  return { ok: true, membership: normalizeMembership(record) };
}

function getSmartCategoryMembers(categoryId, { minWeight = 0 } = {}) {
  return getDatabase()
    .prepare(`
      SELECT m.*, s.created_at AS save_created_at
      FROM smart_category_members m
      JOIN saves s ON s.id = m.save_id
      WHERE m.category_id = ? AND m.weight >= ? AND s.deleted_at IS NULL
      ORDER BY m.weight DESC, s.created_at DESC
    `)
    .all(categoryId, clampUnit(minWeight))
    .map(normalizeMembership);
}

function getSmartCategoryMemberTopicEmbeddings(categoryId, { minWeight = 0.45 } = {}) {
  if (!categoryId) return [];
  return getDatabase()
    .prepare(`
      SELECT m.save_id, p.embedding, m.weight
        FROM smart_category_members m
        JOIN save_topic_profiles p
          ON p.save_id = m.save_id
         AND p.embedding IS NOT NULL
        JOIN saves s
          ON s.id = m.save_id
         AND s.deleted_at IS NULL
       WHERE m.category_id = ?
         AND m.weight >= ?
       ORDER BY m.weight DESC, s.created_at DESC
    `)
    .all(categoryId, clampUnit(minWeight));
}

function getSmartCategorySaves(categoryId, { minWeight = SMART_CATEGORY_PRIMARY_WEIGHT } = {}) {
  if (!categoryId) return [];
  return getDatabase()
    .prepare(`
      SELECT ${SAVE_LIST_COLUMNS.split(', ').map((column) => `s.${column}`).join(', ')},
             m.weight AS smart_category_weight,
             m.evidence AS smart_category_evidence,
             m.updated_at AS smart_category_updated_at
        FROM smart_category_members m
        JOIN smart_categories c
          ON c.id = m.category_id
         AND c.status = 'visible'
        JOIN saves s
          ON s.id = m.save_id
         AND s.deleted_at IS NULL
       WHERE m.category_id = ?
         AND m.weight >= ?
       ORDER BY m.weight DESC, s.created_at DESC
    `)
    .all(categoryId, clampUnit(minWeight));
}

function getSmartCategoriesForSave(saveId, { minWeight = 0 } = {}) {
  return getDatabase()
    .prepare(`
      SELECT m.*, c.name, c.status
      FROM smart_category_members m
      JOIN smart_categories c ON c.id = m.category_id
      WHERE m.save_id = ? AND m.weight >= ?
      ORDER BY m.weight DESC, c.name ASC
    `)
    .all(saveId, clampUnit(minWeight))
    .map(normalizeMembership);
}

function recordSmartCategoryRun({
  id,
  runType,
  startedAt,
  finishedAt = null,
  inputSaveCount = 0,
  createdCount = 0,
  renamedCount = 0,
  mergedCount = 0,
  splitCount = 0,
  failedCount = 0,
  provider = null,
  error = null,
  metadata = null,
} = {}) {
  if (!runType) return { ok: false, reason: 'missing-run-type' };
  const record = {
    id: id || crypto.randomUUID(),
    run_type: runType,
    started_at: Number.isFinite(startedAt) ? startedAt : Date.now(),
    finished_at: Number.isFinite(finishedAt) ? finishedAt : null,
    input_save_count: Math.max(0, Number(inputSaveCount) || 0),
    created_count: Math.max(0, Number(createdCount) || 0),
    renamed_count: Math.max(0, Number(renamedCount) || 0),
    merged_count: Math.max(0, Number(mergedCount) || 0),
    split_count: Math.max(0, Number(splitCount) || 0),
    failed_count: Math.max(0, Number(failedCount) || 0),
    provider,
    error,
    metadata: jsonString(metadata, null),
  };
  getDatabase().prepare(`
    INSERT INTO smart_category_runs
      (id, run_type, started_at, finished_at, input_save_count,
       created_count, renamed_count, merged_count, split_count,
       failed_count, provider, error, metadata)
    VALUES
      (@id, @run_type, @started_at, @finished_at, @input_save_count,
       @created_count, @renamed_count, @merged_count, @split_count,
       @failed_count, @provider, @error, @metadata)
  `).run(record);
  return { ok: true, run: record };
}

function listSmartCategoryRuns({ limit = 20 } = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  return getDatabase()
    .prepare('SELECT * FROM smart_category_runs ORDER BY started_at DESC LIMIT ?')
    .all(n);
}

function getPendingSmartCategorySaves({ limit = 50 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  return getDatabase()
    .prepare(`
      SELECT ${SAVE_LIST_COLUMNS.split(', ').map((column) => `s.${column}`).join(', ')}
        FROM saves s
        LEFT JOIN save_topic_profiles p ON p.save_id = s.id
       WHERE s.deleted_at IS NULL
         AND (
           p.save_id IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM smart_category_members m
               JOIN smart_categories c ON c.id = m.category_id
              WHERE m.save_id = s.id
                AND c.status IN ('visible', 'candidate')
           )
         )
       ORDER BY s.created_at DESC
       LIMIT ?
    `)
    .all(n);
}

function getSavesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  // Same renderer-bound column list as getAllSaves — these rows flow
  // straight to the grid as semantic-search candidates.
  return getDatabase()
    .prepare(`SELECT ${SAVE_LIST_COLUMNS} FROM saves WHERE id IN (${placeholders})`)
    .all(...ids);
}

// Saves that haven't been fully through the AI pipeline. Catches both
// "never processed" (embedding NULL) and "processed before a newer
// signal was added" (ocr_text NULL but embedding present). After a
// successful processing pass we set ocr_text to '' instead of NULL
// when no text is found, so re-runs don't keep re-processing the same
// rows forever.
const UNINDEXED_WHERE = 'embedding IS NULL OR ocr_text IS NULL';

function getUnindexedSaves() {
  return getDatabase()
    .prepare(`SELECT id, file_path, title FROM saves WHERE ${UNINDEXED_WHERE} ORDER BY created_at DESC`)
    .all();
}

function getUnindexedCount() {
  return getDatabase()
    .prepare(`SELECT COUNT(*) AS c FROM saves WHERE ${UNINDEXED_WHERE}`)
    .get().c;
}

// ── Collections ────────────────────────────────────────────────────────────

function getAllCollections() {
  // save_count rolls up: a parent counts its own members plus its
  // children's, deduped (a save in parent AND child counts once).
  return getDatabase().prepare(`
    SELECT c.id, c.name, c.color, c.created_at, c.order_index, c.parent_id,
           (SELECT COUNT(DISTINCT ci.save_id) FROM collection_items ci
             WHERE ci.collection_id = c.id
                OR ci.collection_id IN (SELECT id FROM collections k WHERE k.parent_id = c.id)
           ) AS save_count
    FROM collections c
    ORDER BY c.order_index ASC, c.created_at ASC
  `).all();
}

// Same shape as getAllCollections plus a `thumbs: string[]` field
// containing up to four of the most-recent thumbnails per bucket.
// Powers the Folders-mode tile grid where each folder renders its
// fanned stack artwork — same recipe as FeaturedBuckets' cards on
// the Library page, which fan four thumbs. Window function does the
// per-collection LIMIT 4 in a single query; group_concat aggregates
// the paths into a delimiter-joined string (x'01' = SOH, can never
// appear in a path).
function getAllCollectionsWithThumbs() {
  const rows = getDatabase().prepare(`
    WITH membership AS (
      -- Roll-up membership: every item row counts for its own
      -- collection AND for that collection's parent (one level).
      -- GROUP BY dedups a save that sits in both parent and child;
      -- MAX(added_at) keeps "latest drop on top" honest either way.
      SELECT cid, save_id, MAX(added_at) AS added_at FROM (
        SELECT ci.collection_id AS cid, ci.save_id, ci.added_at FROM collection_items ci
        UNION ALL
        SELECT k.parent_id AS cid, ci.save_id, ci.added_at
        FROM collection_items ci
        JOIN collections k ON k.id = ci.collection_id
        WHERE k.parent_id IS NOT NULL
      )
      GROUP BY cid, save_id
    ),
    ranked AS (
      -- thumb_or_file mirrors the FeaturedBuckets fallback so legacy
      -- saves with empty thumb_path still feed the fanned tile. GIFs
      -- get the original file_path so they animate in the stack
      -- instead of showing the static first-frame JPG that sharp
      -- generates for the thumb_path.
      SELECT m.cid AS collection_id,
             CASE
               WHEN LOWER(s.file_path) LIKE '%.gif' THEN s.file_path
               ELSE COALESCE(NULLIF(s.thumb_path, ''), s.file_path)
             END AS thumb_or_file,
             ROW_NUMBER() OVER (
               PARTITION BY m.cid
               ORDER BY m.added_at DESC, s.created_at DESC
             ) AS rn
      FROM membership m
      JOIN saves s ON s.id = m.save_id
      WHERE s.deleted_at IS NULL
    ),
    top_thumbs AS (
      -- Concatenate in rn order (newest drop first) via the aggregate
      -- ORDER BY — plain group_concat leaves the order undefined, so
      -- the cover thumb (thumbs[0]) could otherwise be an older save
      -- instead of the most recently added one.
      SELECT collection_id,
             group_concat(thumb_or_file, x'01' ORDER BY rn) AS thumbs
      FROM ranked
      WHERE rn <= 4
      GROUP BY collection_id
    )
    SELECT c.id, c.name, c.color, c.created_at, c.order_index, c.parent_id,
           (SELECT COUNT(*) FROM membership m WHERE m.cid = c.id) AS save_count,
           tt.thumbs AS thumbs_blob
    FROM collections c
    LEFT JOIN top_thumbs tt ON tt.collection_id = c.id
    ORDER BY c.order_index ASC, c.created_at ASC
  `).all();
  return rows.map((row) => {
    const { thumbs_blob, ...rest } = row;
    return { ...rest, thumbs: thumbs_blob ? thumbs_blob.split('\x01') : [] };
  });
}

function getCollectionsForSave(saveId) {
  return getDatabase().prepare(`
    SELECT c.* FROM collections c
    JOIN collection_items ci ON ci.collection_id = c.id
    WHERE ci.save_id = ?
    ORDER BY c.order_index ASC, c.created_at ASC
  `).all(saveId);
}

// Returns the ids of collections that contain ALL of the given saves.
// Used to grey out / hide "Add to Bucket" entries that would be a
// no-op for every selected card.
function getCollectionsContainingAll(saveIds) {
  if (!Array.isArray(saveIds) || saveIds.length === 0) return [];
  const placeholders = saveIds.map(() => '?').join(',');
  const rows = getDatabase().prepare(`
    SELECT collection_id AS id FROM collection_items
    WHERE save_id IN (${placeholders})
    GROUP BY collection_id
    HAVING COUNT(DISTINCT save_id) = ?
  `).all(...saveIds, saveIds.length);
  return rows.map((r) => r.id);
}

function createCollection({ name, color, parentId } = {}) {
  const db = getDatabase();
  const next = db.prepare(
    'SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM collections'
  ).get();
  // Resolve / validate the parent. We only allow one level of nesting,
  // so a parent that's itself a child is rejected (silently flattened
  // to top-level rather than rejected outright — this is forgiving for
  // future callers and keeps the constraint enforced server-side).
  let parent_id = null;
  if (parentId) {
    const parent = db.prepare(
      'SELECT id, parent_id FROM collections WHERE id = ?'
    ).get(parentId);
    if (parent && !parent.parent_id) parent_id = parent.id;
  }
  const record = {
    id: crypto.randomUUID(),
    name: name || 'Untitled',
    color: color || '#007aff',
    created_at: Date.now(),
    order_index: next.n,
    parent_id,
  };
  db.prepare(
    'INSERT INTO collections (id, name, color, created_at, order_index, parent_id) VALUES (@id, @name, @color, @created_at, @order_index, @parent_id)'
  ).run(record);
  return record;
}

// ── Semantic index persistence ────────────────────────────────────────────

function createSemanticGeneration({
  id,
  model,
  dimension,
  sourceVersion,
  status = 'building',
  createdAt,
} = {}) {
  if (!id || !model || !Number.isInteger(sourceVersion)) {
    return { ok: false, reason: 'invalid' };
  }
  const database = getDatabase();
  const now = Number.isFinite(createdAt) ? createdAt : Date.now();
  const record = {
    id,
    model,
    dimension: Number.isInteger(dimension) && dimension > 0 ? dimension : null,
    source_version: sourceVersion,
    status,
    created_at: now,
    activated_at: status === 'active' ? now : null,
  };
  const create = database.transaction(() => {
    if (status === 'building') {
      const existing = database.prepare(`
        SELECT id FROM semantic_index_generations
         WHERE status = 'building'
         LIMIT 1
      `).get();
      if (existing) {
        return { ok: false, reason: 'building_exists', generationId: existing.id };
      }
    }
    database.prepare(`
      INSERT INTO semantic_index_generations
        (id, model, dimension, source_version, status, created_at, activated_at)
      VALUES
        (@id, @model, @dimension, @source_version, @status, @created_at, @activated_at)
    `).run(record);
    if (status === 'active') {
      database.prepare(
        "UPDATE semantic_index_generations SET status = 'retired' WHERE status = 'active' AND id != ?",
      ).run(id);
      database.prepare(`
        UPDATE semantic_index_state
           SET active_generation_id = ?, updated_at = ?
         WHERE id = 1
      `).run(id, now);
    } else if (status === 'building') {
      database.prepare(`
        UPDATE semantic_index_state
           SET building_generation_id = ?, updated_at = ?
         WHERE id = 1
      `).run(id, now);
    }
    return null;
  });
  const rejected = create();
  if (rejected) return rejected;
  return database.prepare('SELECT * FROM semantic_index_generations WHERE id = ?').get(id);
}

function getSemanticIndexState() {
  const row = getDatabase().prepare(`
    SELECT active_generation_id, building_generation_id, paused,
           pause_reason, paused_at, updated_at
      FROM semantic_index_state
     WHERE id = 1
  `).get();
  return { ...row, paused: !!row.paused };
}

function enqueueSemanticIndexJob({
  id,
  generationId,
  saveId,
  kind = 'incremental',
  sourceHash,
  now,
} = {}) {
  if (!generationId || !saveId || !sourceHash) return { ok: false, reason: 'invalid' };
  const database = getDatabase();
  const timestamp = Number.isFinite(now) ? now : Date.now();
  database.prepare(`
    INSERT INTO semantic_index_jobs
      (id, generation_id, save_id, kind, source_hash, state, retry_count, retryable,
       available_at, created_at, updated_at)
    VALUES
      (@id, @generation_id, @save_id, @kind, @source_hash, 'pending', 0, 0,
       @available_at, @created_at, @updated_at)
    ON CONFLICT(generation_id, save_id, kind) DO UPDATE SET
      source_hash = excluded.source_hash,
      state = 'pending',
      retry_count = CASE
        WHEN semantic_index_jobs.source_hash = excluded.source_hash
        THEN semantic_index_jobs.retry_count ELSE 0 END,
      retryable = 0,
      available_at = excluded.available_at,
      error = NULL,
      updated_at = excluded.updated_at,
      started_at = NULL,
      finished_at = NULL
  `).run({
    id: id || crypto.randomUUID(),
    generation_id: generationId,
    save_id: saveId,
    kind,
    source_hash: sourceHash,
    available_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return database.prepare(`
    SELECT * FROM semantic_index_jobs
     WHERE generation_id = ? AND save_id = ? AND kind = ?
  `).get(generationId, saveId, kind);
}

function claimSemanticIndexJob(kind, now = Date.now()) {
  const database = getDatabase();
  if (database.prepare('SELECT paused FROM semantic_index_state WHERE id = 1').get().paused) {
    return undefined;
  }
  const claim = database.transaction(() => {
    const row = database.prepare(`
      SELECT j.*
        FROM semantic_index_jobs j
        JOIN semantic_index_generations g ON g.id = j.generation_id
        JOIN semantic_index_state s ON s.id = 1
       WHERE j.state = 'pending'
         AND j.available_at <= ?
         AND (? IS NULL OR j.kind = ?)
         AND g.status IN ('active', 'building')
         AND (
           (j.kind = 'incremental' AND j.generation_id = s.active_generation_id)
           OR
           (j.kind = 'rebuild' AND j.generation_id = s.building_generation_id)
         )
       ORDER BY CASE j.kind WHEN 'incremental' THEN 0 ELSE 1 END,
                j.available_at ASC, j.created_at ASC
       LIMIT 1
    `).get(now, kind || null, kind || null);
    if (!row) return undefined;
    const result = database.prepare(`
      UPDATE semantic_index_jobs
         SET state = 'running', retryable = 0,
             started_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND state = 'pending'
    `).run(now, now, row.id);
    if (result.changes !== 1) return undefined;
    return database.prepare('SELECT * FROM semantic_index_jobs WHERE id = ?').get(row.id);
  });
  return claim();
}

function vectorBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function isValidFloat32Vector(bytes, dimension) {
  if (!bytes || !Number.isInteger(dimension) || dimension < 1) return false;
  if (bytes.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) return false;
  for (let i = 0; i < dimension; i += 1) {
    if (!Number.isFinite(bytes.readFloatLE(i * Float32Array.BYTES_PER_ELEMENT))) return false;
  }
  return true;
}

function completeSemanticIndexJob({
  id,
  sourceHash,
  model,
  dimension,
  vector,
  now,
  activate = true,
} = {}) {
  const database = getDatabase();
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const bytes = vectorBuffer(vector);
  const complete = database.transaction(() => {
    const job = database.prepare('SELECT * FROM semantic_index_jobs WHERE id = ?').get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.state !== 'running') {
      return { ok: false, reason: job.source_hash !== sourceHash ? 'stale' : 'not_running' };
    }
    if (job.source_hash !== sourceHash) return { ok: false, reason: 'stale' };
    const generation = database.prepare(
      'SELECT * FROM semantic_index_generations WHERE id = ?',
    ).get(job.generation_id);
    if (!generation || generation.model !== model || !Number.isInteger(dimension) || dimension < 1) {
      return { ok: false, reason: 'invalid_vector_identity' };
    }
    if (!isValidFloat32Vector(bytes, dimension)) {
      return { ok: false, reason: 'invalid_vector_payload' };
    }
    if (generation.dimension && generation.dimension !== dimension) {
      return { ok: false, reason: 'dimension_mismatch' };
    }

    database.prepare(`
      UPDATE semantic_index_generations
         SET dimension = COALESCE(dimension, ?)
       WHERE id = ?
    `).run(dimension, generation.id);
    database.prepare(`
      INSERT INTO semantic_vectors
        (generation_id, save_id, model, dimension, source_hash, vector, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, save_id) DO UPDATE SET
        model = excluded.model,
        dimension = excluded.dimension,
        source_hash = excluded.source_hash,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `).run(
      generation.id,
      job.save_id,
      model,
      dimension,
      sourceHash,
      bytes,
      timestamp,
      timestamp,
    );
    database.prepare(`
      UPDATE semantic_index_jobs
         SET state = 'completed', retryable = 0,
             updated_at = ?, finished_at = ?, error = NULL
       WHERE id = ?
    `).run(timestamp, timestamp, id);

    const indexState = database.prepare(`
      SELECT building_generation_id FROM semantic_index_state WHERE id = 1
    `).get();
    if (
      generation.status === 'building'
      && indexState.building_generation_id === generation.id
      && activate !== false
    ) {
      const incomplete = database.prepare(`
        SELECT COUNT(*) AS n
          FROM semantic_index_jobs j
          LEFT JOIN semantic_vectors v
            ON v.generation_id = j.generation_id
           AND v.save_id = j.save_id
           AND v.source_hash = j.source_hash
           AND v.model = ?
           AND v.dimension = ?
         WHERE j.generation_id = ?
           AND (j.state != 'completed' OR v.save_id IS NULL)
      `).get(generation.model, dimension, generation.id).n;
      if (incomplete === 0) {
        database.prepare(`
          UPDATE semantic_index_generations
             SET status = 'retired'
           WHERE status = 'active' AND id != ?
        `).run(generation.id);
        database.prepare(`
          UPDATE semantic_index_generations
             SET status = 'active', activated_at = ?, completed_at = ?
           WHERE id = ?
        `).run(timestamp, timestamp, generation.id);
        database.prepare(`
          UPDATE semantic_index_state
             SET active_generation_id = ?, building_generation_id = NULL, updated_at = ?
           WHERE id = 1
        `).run(generation.id, timestamp);
      }
    }
    return { ok: true, saveId: job.save_id, generationId: generation.id };
  });
  return complete();
}

function failSemanticIndexJob({ id, error, retryable = false, retryAt, now } = {}) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const availableAt = Number.isFinite(retryAt) ? retryAt : timestamp;
  const result = getDatabase().prepare(`
    UPDATE semantic_index_jobs
       SET state = ?, retry_count = retry_count + 1, retryable = ?,
           available_at = ?, error = ?, updated_at = ?,
           started_at = CASE WHEN ? = 1 THEN NULL ELSE started_at END,
           finished_at = CASE WHEN ? = 1 THEN NULL ELSE ? END
     WHERE id = ? AND state = 'running'
  `).run(
    retryable ? 'pending' : 'failed',
    retryable ? 1 : 0,
    availableAt,
    error || null,
    timestamp,
    retryable ? 1 : 0,
    retryable ? 1 : 0,
    timestamp,
    id,
  );
  return { ok: result.changes === 1 };
}

function pauseSemanticIndex({ reason, now } = {}) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  getDatabase().prepare(`
    UPDATE semantic_index_state
       SET paused = 1, pause_reason = ?, paused_at = ?, updated_at = ?
     WHERE id = 1
  `).run(reason || null, timestamp, timestamp);
  return getSemanticIndexState();
}

function resumeSemanticIndex(now = Date.now()) {
  getDatabase().prepare(`
    UPDATE semantic_index_state
       SET paused = 0, pause_reason = NULL, paused_at = NULL, updated_at = ?
     WHERE id = 1
  `).run(now);
  return getSemanticIndexState();
}

function retrySemanticFailures(ids, now = Date.now()) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, count: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const result = getDatabase().prepare(`
    UPDATE semantic_index_jobs
       SET state = 'pending', available_at = ?, error = NULL,
           retryable = 0, updated_at = ?, started_at = NULL, finished_at = NULL
     WHERE state = 'failed' AND id IN (${placeholders})
  `).run(now, now, ...ids);
  return { ok: true, count: result.changes };
}

function dismissSemanticFailures(ids, now = Date.now()) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, count: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const result = getDatabase().prepare(`
    UPDATE semantic_index_jobs
       SET state = 'dismissed', updated_at = ?, finished_at = ?
     WHERE state = 'failed' AND id IN (${placeholders})
  `).run(now, now, ...ids);
  return { ok: true, count: result.changes };
}

function cancelSemanticGeneration(generationId, now = Date.now()) {
  const database = getDatabase();
  const cancel = database.transaction(() => {
    const generation = database.prepare(
      'SELECT status FROM semantic_index_generations WHERE id = ?',
    ).get(generationId);
    if (!generation) return { ok: false, reason: 'not_found' };
    if (generation.status !== 'building') return { ok: false, reason: 'not_building' };
    database.prepare('DELETE FROM semantic_index_jobs WHERE generation_id = ?').run(generationId);
    database.prepare('DELETE FROM semantic_vectors WHERE generation_id = ?').run(generationId);
    database.prepare(`
      UPDATE semantic_index_generations
         SET status = 'cancelled', cancelled_at = ?, completed_at = ?
       WHERE id = ?
    `).run(now, now, generationId);
    database.prepare(`
      UPDATE semantic_index_state
         SET building_generation_id = CASE
               WHEN building_generation_id = ? THEN NULL ELSE building_generation_id END,
             updated_at = ?
       WHERE id = 1
    `).run(generationId, now);
    return { ok: true };
  });
  return cancel();
}

function getSemanticIndexStatus() {
  const database = getDatabase();
  const state = getSemanticIndexState();
  const counts = Object.fromEntries(database.prepare(`
    SELECT j.state, COUNT(*) AS n
      FROM semantic_index_jobs j
      JOIN semantic_index_state s ON s.id = 1
      JOIN semantic_index_generations g ON g.id = j.generation_id
     WHERE (j.generation_id = s.active_generation_id AND g.status = 'active')
        OR (j.generation_id = s.building_generation_id AND g.status = 'building')
     GROUP BY j.state
  `).all().map((row) => [row.state, row.n]));
  return {
    ...state,
    waiting: counts.pending || 0,
    running: counts.running || 0,
    failed: counts.failed || 0,
    dismissed: counts.dismissed || 0,
  };
}

function listSemanticIndexJobs({ generationId, saveId, kind, state } = {}) {
  const clauses = [];
  const params = [];
  if (generationId) { clauses.push('generation_id = ?'); params.push(generationId); }
  if (saveId) { clauses.push('save_id = ?'); params.push(saveId); }
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  if (state) { clauses.push('state = ?'); params.push(state); }
  return getDatabase().prepare(`
    SELECT * FROM semantic_index_jobs
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at ASC, id ASC
  `).all(...params);
}

function getActiveSemanticVectors() {
  return getDatabase().prepare(`
    SELECT v.*
      FROM semantic_vectors v
      JOIN semantic_index_state s ON s.id = 1 AND s.active_generation_id = v.generation_id
      JOIN semantic_index_generations g ON g.id = v.generation_id
     WHERE g.status = 'active'
       AND g.model = v.model
       AND g.dimension = v.dimension
     ORDER BY v.save_id ASC
  `).all();
}

function getSemanticVector(saveId) {
  return getDatabase().prepare(`
    SELECT v.*
      FROM semantic_vectors v
      JOIN semantic_index_state s ON s.id = 1 AND s.active_generation_id = v.generation_id
      JOIN semantic_index_generations g ON g.id = v.generation_id
     WHERE v.save_id = ?
       AND g.status = 'active'
       AND g.model = v.model
       AND g.dimension = v.dimension
  `).get(saveId);
}

// ── Video analysis persistence ────────────────────────────────────────────

const MAX_VIDEO_RETRY_BACKOFF_MS = 15 * 60 * 1000;

function enqueueVideoAnalysis({ id, saveId, fingerprint, promptVersion, now } = {}) {
  if (!saveId || !fingerprint || !Number.isInteger(promptVersion) || promptVersion < 1) {
    return { ok: false, reason: 'invalid' };
  }
  const database = getDatabase();
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const enqueue = database.transaction(() => {
    const current = database.prepare(`
      SELECT * FROM video_analysis_jobs
       WHERE save_id = ? AND state != 'superseded'
       ORDER BY updated_at DESC LIMIT 1
    `).get(saveId);
    if (current && current.fingerprint === fingerprint) return current;

    const remembered = database.prepare(`
      SELECT * FROM video_analysis_jobs
       WHERE save_id = ? AND fingerprint = ?
       LIMIT 1
    `).get(saveId, fingerprint);

    if (current) {
      database.prepare(`
        UPDATE video_analysis_jobs
           SET superseded_from_state = CASE
                 WHEN state = 'running' THEN 'pending' ELSE state END,
               state = 'superseded', updated_at = ?,
               finished_at = COALESCE(finished_at, ?)
         WHERE id = ?
      `).run(timestamp, timestamp, current.id);
    }
    // Only unresolved output is replaceable. Accepted and dismissed rows are
    // durable history tied to their original fingerprint.
    database.prepare(`
      DELETE FROM video_tag_suggestions
       WHERE save_id = ? AND state = 'suggested'
    `).run(saveId);

    if (remembered) {
      const restoredState = remembered.superseded_from_state || 'pending';
      database.prepare(`
        UPDATE video_analysis_jobs
           SET state = ?, superseded_from_state = NULL, updated_at = ?,
               started_at = CASE WHEN ? = 'pending' THEN NULL ELSE started_at END,
               finished_at = CASE WHEN ? = 'pending' THEN NULL ELSE finished_at END
         WHERE id = ?
      `).run(restoredState, timestamp, restoredState, restoredState, remembered.id);
      return database.prepare('SELECT * FROM video_analysis_jobs WHERE id = ?').get(remembered.id);
    }

    const record = {
      id: id || crypto.randomUUID(),
      save_id: saveId,
      fingerprint,
      prompt_version: promptVersion,
      available_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    };
    database.prepare(`
      INSERT INTO video_analysis_jobs
        (id, save_id, fingerprint, prompt_version, state, retry_count, retryable,
         available_at, created_at, updated_at)
      VALUES
        (@id, @save_id, @fingerprint, @prompt_version, 'pending', 0, 0,
         @available_at, @created_at, @updated_at)
    `).run(record);
    return database.prepare('SELECT * FROM video_analysis_jobs WHERE id = ?').get(record.id);
  });
  return enqueue();
}

function claimVideoAnalysis(now = Date.now()) {
  const database = getDatabase();
  const claim = database.transaction(() => {
    const row = database.prepare(`
      SELECT * FROM video_analysis_jobs
       WHERE state = 'pending'
         AND available_at <= ?
       ORDER BY available_at ASC, created_at ASC
       LIMIT 1
    `).get(now);
    if (!row) return undefined;
    const result = database.prepare(`
      UPDATE video_analysis_jobs
         SET state = 'running', retryable = 0,
             started_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND state = 'pending'
    `).run(now, now, row.id);
    if (result.changes !== 1) return undefined;
    return database.prepare('SELECT * FROM video_analysis_jobs WHERE id = ?').get(row.id);
  });
  return claim();
}

function normalizeTagName(name) {
  return (name || '').trim().toLowerCase().replace(/^#+/, '');
}

function completeVideoAnalysis({ id, fingerprint, suggestions = [], unavailable = false, now } = {}) {
  const database = getDatabase();
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const complete = database.transaction(() => {
    const job = database.prepare('SELECT * FROM video_analysis_jobs WHERE id = ?').get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.state !== 'running') return { ok: false, reason: 'not_running' };
    if (job.fingerprint !== fingerprint) return { ok: false, reason: 'stale' };

    database.prepare(`
      DELETE FROM video_tag_suggestions
       WHERE job_id = ? AND state = 'suggested'
    `).run(id);
    const insert = database.prepare(`
      INSERT OR IGNORE INTO video_tag_suggestions
        (id, job_id, save_id, fingerprint, name, confidence, evidence,
         state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', ?)
    `);
    if (!unavailable) {
      for (const suggestion of suggestions) {
        const name = normalizeTagName(suggestion && suggestion.name);
        if (!name) continue;
        const evidence = Array.isArray(suggestion.evidence) ? suggestion.evidence : [];
        insert.run(
          crypto.randomUUID(),
          job.id,
          job.save_id,
          job.fingerprint,
          name,
          suggestion.confidence || 'high',
          JSON.stringify(evidence),
          timestamp,
        );
      }
    }
    database.prepare(`
      UPDATE video_analysis_jobs
         SET state = ?, error = NULL, updated_at = ?, finished_at = ?
       WHERE id = ?
    `).run(unavailable ? 'unavailable' : 'completed', timestamp, timestamp, id);
    return { ok: true, saveId: job.save_id };
  });
  return complete();
}

function failVideoAnalysis({ id, error, retryable = false, retryAt, now } = {}) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const requestedRetry = Number.isFinite(retryAt) ? retryAt : timestamp;
  const availableAt = retryable
    ? Math.min(Math.max(requestedRetry, timestamp), timestamp + MAX_VIDEO_RETRY_BACKOFF_MS)
    : timestamp;
  const result = getDatabase().prepare(`
    UPDATE video_analysis_jobs
       SET state = ?, retry_count = retry_count + 1, retryable = ?,
           available_at = ?, error = ?, updated_at = ?,
           started_at = CASE WHEN ? = 1 THEN NULL ELSE started_at END,
           finished_at = CASE WHEN ? = 1 THEN NULL ELSE ? END
     WHERE id = ? AND state = 'running'
  `).run(
    retryable ? 'pending' : 'failed',
    retryable ? 1 : 0,
    availableAt,
    error || null,
    timestamp,
    retryable ? 1 : 0,
    retryable ? 1 : 0,
    timestamp,
    id,
  );
  return { ok: result.changes === 1 };
}

function recoverBackgroundJobs(now = Date.now()) {
  const database = getDatabase();
  const recover = database.transaction(() => {
    const semantic = database.prepare(`
      UPDATE semantic_index_jobs
         SET state = 'pending', retryable = 0, started_at = NULL, updated_at = ?
       WHERE state = 'running'
    `).run(now).changes;
    const video = database.prepare(`
      UPDATE video_analysis_jobs
         SET state = 'pending', retryable = 0, started_at = NULL, updated_at = ?
       WHERE state = 'running'
    `).run(now).changes;
    return { semantic, video };
  });
  return recover();
}

function getVideoAnalysis(saveId) {
  return getDatabase().prepare(`
    SELECT * FROM video_analysis_jobs
     WHERE save_id = ? AND state != 'superseded'
     ORDER BY updated_at DESC LIMIT 1
  `).get(saveId);
}

function listVideoTagSuggestions(saveId) {
  return getDatabase().prepare(`
    SELECT * FROM video_tag_suggestions
     WHERE save_id = ?
     ORDER BY name ASC, created_at ASC
  `).all(saveId);
}

function acceptVideoTagSuggestion({ suggestionId, id, now } = {}) {
  const database = getDatabase();
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const resolve = database.transaction(() => {
    const suggestion = database.prepare(
      'SELECT * FROM video_tag_suggestions WHERE id = ?',
    ).get(suggestionId || id);
    if (!suggestion) return { ok: false, reason: 'not_found' };
    if (suggestion.state !== 'suggested') return { ok: false, reason: 'resolved' };
    let tag = database.prepare('SELECT id FROM tags WHERE name = ?').get(suggestion.name);
    if (!tag) {
      tag = { id: crypto.randomUUID() };
      database.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tag.id, suggestion.name);
    }
    database.prepare(
      'INSERT OR IGNORE INTO save_tags (save_id, tag_id) VALUES (?, ?)',
    ).run(suggestion.save_id, tag.id);
    database.prepare(`
      UPDATE video_tag_suggestions
         SET state = 'accepted', resolved_at = ?
       WHERE id = ? AND state = 'suggested'
    `).run(timestamp, suggestion.id);
    return { ok: true, saveId: suggestion.save_id };
  });
  return resolve();
}

function dismissVideoTagSuggestion({ suggestionId, id, now } = {}) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const database = getDatabase();
  const suggestion = database.prepare(
    'SELECT * FROM video_tag_suggestions WHERE id = ?',
  ).get(suggestionId || id);
  if (!suggestion) return { ok: false, reason: 'not_found' };
  if (suggestion.state !== 'suggested') return { ok: false, reason: 'resolved' };
  const result = database.prepare(`
    UPDATE video_tag_suggestions
       SET state = 'dismissed', resolved_at = ?
     WHERE id = ? AND state = 'suggested'
  `).run(timestamp, suggestion.id);
  return result.changes === 1
    ? { ok: true, saveId: suggestion.save_id }
    : { ok: false, reason: 'resolved' };
}

// ── Tags ───────────────────────────────────────────────────────────────────

// Internal tags are namespaced with a leading "__" (e.g. "__starter__",
// which the starter pack uses to find its images for "Start fresh"). They
// drive behaviour, not user organization, so they're filtered out of every
// tag query the UI reads — starter images then read as untagged. The
// ESCAPE clause treats the underscores as literals (otherwise LIKE's "_"
// wildcard would match anything).
const NOT_INTERNAL_TAG = `t.name NOT LIKE '\\_\\_%' ESCAPE '\\'`;

function getAllTags() {
  return getDatabase().prepare(`
    SELECT t.*, COUNT(st.save_id) AS save_count
    FROM tags t
    LEFT JOIN save_tags st ON st.tag_id = t.id
    WHERE ${NOT_INTERNAL_TAG}
    GROUP BY t.id
    ORDER BY t.name ASC
  `).all();
}

function getTagsForSave(saveId) {
  return getDatabase().prepare(`
    SELECT t.* FROM tags t
    JOIN save_tags st ON st.tag_id = t.id
    WHERE st.save_id = ? AND ${NOT_INTERNAL_TAG}
    ORDER BY t.name ASC
  `).all(saveId);
}

function addTagToSave({ saveId, name } = {}) {
  const trimmed = (name || '').trim().toLowerCase().replace(/^#+/, '');
  if (!trimmed || !saveId) return { ok: false };
  const db = getDatabase();
  let tag = db.prepare('SELECT * FROM tags WHERE name = ?').get(trimmed);
  if (!tag) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, trimmed);
    tag = { id, name: trimmed };
  }
  db.prepare(
    'INSERT OR IGNORE INTO save_tags (save_id, tag_id) VALUES (?, ?)'
  ).run(saveId, tag.id);
  return { ok: true, tag };
}

function removeTagFromSave({ saveId, tagId } = {}) {
  if (!saveId || !tagId) return { ok: false };
  const db = getDatabase();
  db.prepare('DELETE FROM save_tags WHERE save_id = ? AND tag_id = ?').run(saveId, tagId);
  // Sweep orphaned tags so the global tag list stays clean.
  db.prepare(
    'DELETE FROM tags WHERE id = ? AND id NOT IN (SELECT tag_id FROM save_tags)'
  ).run(tagId);
  return { ok: true };
}

// Rename a tag globally. If the new name already exists as another
// tag, merge the two — every save that had the old tag now points at
// the survivor and the renamed row is deleted. Idempotent on no-op.
function renameTag({ id, name } = {}) {
  const trimmed = (name || '').trim().toLowerCase().replace(/^#+/, '');
  if (!id || !trimmed) return { ok: false, reason: 'invalid' };
  const db = getDatabase();
  const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.name === trimmed) return { ok: true, tag: existing };

  const collision = db.prepare('SELECT * FROM tags WHERE name = ? AND id != ?').get(trimmed, id);
  if (collision) {
    // Merge: repoint every save_tags row from id → collision.id, then
    // delete the now-empty source tag. INSERT OR IGNORE handles the
    // case where a save already had both tags applied.
    const merge = db.transaction(() => {
      db.prepare(
        'INSERT OR IGNORE INTO save_tags (save_id, tag_id) SELECT save_id, ? FROM save_tags WHERE tag_id = ?',
      ).run(collision.id, id);
      db.prepare('DELETE FROM save_tags WHERE tag_id = ?').run(id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    });
    merge();
    return { ok: true, tag: collision, merged: true };
  }
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(trimmed, id);
  return { ok: true, tag: { ...existing, name: trimmed } };
}

// Hard-delete a tag everywhere — drops every save_tags edge first, then
// the tag row. Returns the number of saves that lost the tag so the UI
// can surface "removed from N saves" feedback.
function deleteTag(tagId) {
  if (!tagId) return { ok: false };
  const db = getDatabase();
  const txn = db.transaction(() => {
    const { changes } = db
      .prepare('DELETE FROM save_tags WHERE tag_id = ?')
      .run(tagId);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    return changes;
  });
  const removed = txn();
  return { ok: true, removed };
}

// Bulk-cleanup for the tag manager — drops every tag that no save
// references. Single statement so 1000-tag libraries don't pay
// transaction overhead per row.
function deleteUnusedTags() {
  const db = getDatabase();
  const { changes } = db
    .prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM save_tags WHERE tag_id IS NOT NULL)')
    .run();
  return { ok: true, deleted: changes };
}

function reorderCollections(orderedIds) {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE collections SET order_index = ? WHERE id = ?');
  const txn = db.transaction((ids) => {
    ids.forEach((id, idx) => stmt.run(idx, id));
  });
  txn(orderedIds);
  return { ok: true };
}

function renameCollection({ id, name } = {}) {
  getDatabase().prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, id);
  return { ok: true };
}

// Move a folder under a different parent — or back to the top level
// when parentId is null. Enforces the schema's one-level cap by
// rejecting moves that would create a grandparent-grandchild chain
// (i.e. trying to nest under a folder that's itself nested) and by
// preventing self-parenting / cycles.
function setCollectionParent({ id, parentId } = {}) {
  if (!id || id === parentId) return { ok: false, reason: 'invalid' };
  const db = getDatabase();
  if (parentId) {
    const parent = db
      .prepare('SELECT id, parent_id FROM collections WHERE id = ?')
      .get(parentId);
    if (!parent) return { ok: false, reason: 'parent-missing' };
    if (parent.parent_id) return { ok: false, reason: 'too-deep' };
    // If the moving folder already has children, demoting it under
    // a parent would create a 3-level chain. Promote its children
    // to the top level first.
    db.prepare('UPDATE collections SET parent_id = NULL WHERE parent_id = ?').run(id);
  }
  db.prepare('UPDATE collections SET parent_id = ? WHERE id = ?')
    .run(parentId || null, id);
  return { ok: true };
}

function deleteCollection(id) {
  const db = getDatabase();
  // Promote any children to top-level rather than cascading the
  // delete. Less destructive — users who accidentally delete a parent
  // can still find the children in the sidebar afterward, with all
  // their saves intact.
  db.prepare('UPDATE collections SET parent_id = NULL WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  return { ok: true };
}

function addSaveToCollection({ collectionId, saveId } = {}) {
  getDatabase().prepare(
    'INSERT OR IGNORE INTO collection_items (collection_id, save_id, added_at) VALUES (?, ?, ?)'
  ).run(collectionId, saveId, Date.now());
  return { ok: true };
}

function removeSaveFromCollection({ collectionId, saveId } = {}) {
  getDatabase().prepare(
    'DELETE FROM collection_items WHERE collection_id = ? AND save_id = ?'
  ).run(collectionId, saveId);
  return { ok: true };
}

// ── Boards ──────────────────────────────────────────────────────────
//
// Boards are an infinite-canvas surface. A board has many board_items,
// where each item has type-specific data stashed as a JSON blob in the
// `data` column. Position/size live as columns so we can index/query
// them later if needed (e.g. compute board bounds for thumbnails).

function listBoards() {
  return getDatabase().prepare(
    'SELECT id, name, thumb_path, created_at, updated_at, order_index FROM boards ORDER BY order_index ASC, created_at ASC'
  ).all();
}

function reorderBoards(orderedIds) {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE boards SET order_index = ? WHERE id = ?');
  const txn = db.transaction((ids) => {
    ids.forEach((id, idx) => stmt.run(idx, id));
  });
  txn(orderedIds);
  return { ok: true };
}

// Same shape as listBoards plus a `thumbs: string[]` field with up
// to four save thumbnails — the first image items on the canvas
// ordered bottom-up. Powers the Boards-mode tile grid where each
// board renders as a small mosaic of its content. board_items.data
// is JSON; json_extract pulls saveId out without needing a join
// through a materialised intermediate. Filters by deleted_at on
// the joined save so stale references to trashed saves don't
// appear as broken thumbs.
function listBoardsWithThumbs() {
  const rows = getDatabase().prepare(`
    WITH item_data AS (
      -- Pull every board item with the geometry + minimal type data
      -- the snapshot renderer needs. Image items resolve their save's
      -- thumb_path here so the renderer doesn't need a separate lookup.
      SELECT bi.board_id, bi.type, bi.x, bi.y, bi.width, bi.height,
             bi.rotation, bi.z_index,
             json_extract(bi.data, '$.kind')         AS kind,
             json_extract(bi.data, '$.fill')         AS fill,
             json_extract(bi.data, '$.stroke')       AS stroke,
             json_extract(bi.data, '$.strokeWidth')  AS stroke_width,
             json_extract(bi.data, '$.fontSize')     AS font_size,
             json_extract(bi.data, '$.text')         AS text_content,
             CASE WHEN bi.type = 'image'
                  THEN CASE
                         WHEN LOWER(s.file_path) LIKE '%.gif' THEN s.file_path
                         ELSE COALESCE(NULLIF(s.thumb_path, ''), s.file_path)
                       END
                  ELSE NULL END                       AS thumb_path
        FROM board_items bi
        LEFT JOIN saves s
          ON s.id = json_extract(bi.data, '$.saveId')
         AND s.deleted_at IS NULL
       ORDER BY bi.board_id, bi.z_index ASC
    ),
    items_per_board AS (
      SELECT board_id,
             json_group_array(json_object(
               'type', type,
               'x', x, 'y', y, 'width', width, 'height', height,
               'rotation', rotation,
               'kind', kind,
               'fill', fill,
               'stroke', stroke,
               'strokeWidth', stroke_width,
               'fontSize', font_size,
               'text', text_content,
               'thumb_path', thumb_path
             )) AS items_json
        FROM item_data
       GROUP BY board_id
    )
    SELECT b.id, b.name, b.thumb_path, b.created_at, b.updated_at, b.order_index,
           COALESCE(ipb.items_json, '[]') AS items_json
      FROM boards b
      LEFT JOIN items_per_board ipb ON ipb.board_id = b.id
     ORDER BY b.order_index ASC, b.created_at ASC
  `).all();
  return rows.map((row) => {
    const { items_json, ...rest } = row;
    let items = [];
    try { items = JSON.parse(items_json || '[]'); } catch { items = []; }
    return { ...rest, items };
  });
}

function getBoard(id) {
  return getDatabase().prepare(
    'SELECT id, name, thumb_path, created_at, updated_at FROM boards WHERE id = ?'
  ).get(id);
}

function createBoard({ name = 'Untitled board' } = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDatabase().prepare(
    'INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(id, name, now, now);
  return { id, name, thumb_path: null, created_at: now, updated_at: now };
}

function renameBoard({ id, name } = {}) {
  getDatabase().prepare(
    'UPDATE boards SET name = ?, updated_at = ? WHERE id = ?'
  ).run(name, Date.now(), id);
  return { ok: true };
}

function deleteBoard(id) {
  // ON DELETE CASCADE drops board_items automatically.
  getDatabase().prepare('DELETE FROM boards WHERE id = ?').run(id);
  return { ok: true };
}

function touchBoard(id) {
  getDatabase().prepare(
    'UPDATE boards SET updated_at = ? WHERE id = ?'
  ).run(Date.now(), id);
}

function getBoardItems(boardId) {
  const rows = getDatabase().prepare(
    'SELECT id, board_id, type, x, y, width, height, rotation, z_index, data, created_at, updated_at FROM board_items WHERE board_id = ? ORDER BY z_index ASC'
  ).all(boardId);
  // Hydrate the JSON blob for the renderer; raw column stays as text.
  return rows.map((r) => ({
    ...r,
    data: r.data ? safeParseJSON(r.data) : {},
  }));
}

// Tiny preview slice for the sidebar's board hover fan — up to N
// image items with the corresponding save's file_path / thumb_path
// joined in. Avoids a round-trip per item from the renderer.
function getBoardPreviewSaves(boardId, limit = 4) {
  if (!boardId) return [];
  const rows = getDatabase().prepare(
    `SELECT data, z_index, created_at FROM board_items
       WHERE board_id = ? AND type = 'image'
       ORDER BY z_index ASC, created_at ASC`,
  ).all(boardId);
  const saveIds = [];
  for (const r of rows) {
    const data = r.data ? safeParseJSON(r.data) : {};
    if (data && typeof data.saveId === 'string') saveIds.push(data.saveId);
    if (saveIds.length >= limit) break;
  }
  if (saveIds.length === 0) return [];
  const placeholders = saveIds.map(() => '?').join(',');
  const saves = getDatabase().prepare(
    `SELECT id, file_path, thumb_path, title FROM saves
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
  ).all(...saveIds);
  // Preserve the order of saveIds (most-recent-first per board layer).
  const byId = new Map(saves.map((s) => [s.id, s]));
  return saveIds.map((id) => byId.get(id)).filter(Boolean);
}

// All save ids referenced by a board's image items. Used by the
// BoardLibraryDrawer to mark library cards that are already on the
// canvas with an "in this space" badge.
function getBoardSaveIds(boardId) {
  if (!boardId) return [];
  const rows = getDatabase().prepare(
    `SELECT json_extract(data, '$.saveId') AS save_id
       FROM board_items
      WHERE board_id = ? AND type = 'image'`,
  ).all(boardId);
  const ids = [];
  for (const r of rows) {
    if (typeof r.save_id === 'string' && r.save_id) ids.push(r.save_id);
  }
  return ids;
}

// Reverse lookup: every board that contains the given save as an
// image item, with the board's display name. Drives the Spaces row
// in the DetailPanel so users can jump from a save to any board it
// lives on.
function getBoardsForSave(saveId) {
  if (!saveId) return [];
  return getDatabase().prepare(
    `SELECT DISTINCT b.id, b.name, b.updated_at
       FROM board_items bi
       JOIN boards b ON b.id = bi.board_id
      WHERE bi.type = 'image'
        AND json_extract(bi.data, '$.saveId') = ?
      ORDER BY b.updated_at DESC`,
  ).all(saveId);
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function upsertBoardItem({ boardId, item } = {}) {
  if (!boardId || !item) return { ok: false };
  const now = Date.now();
  const id = item.id || crypto.randomUUID();
  const dataStr = JSON.stringify(item.data || {});
  const existing = getDatabase().prepare(
    'SELECT id FROM board_items WHERE id = ?'
  ).get(id);

  if (existing) {
    getDatabase().prepare(
      `UPDATE board_items SET
         type = ?, x = ?, y = ?, width = ?, height = ?, rotation = ?,
         z_index = ?, data = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      item.type, item.x, item.y, item.width ?? null, item.height ?? null,
      item.rotation ?? 0, item.z_index ?? 0, dataStr, now, id,
    );
  } else {
    getDatabase().prepare(
      `INSERT INTO board_items
         (id, board_id, type, x, y, width, height, rotation, z_index, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, boardId, item.type, item.x, item.y,
      item.width ?? null, item.height ?? null,
      item.rotation ?? 0, item.z_index ?? 0, dataStr,
      item.created_at || now, now,
    );
  }
  touchBoard(boardId);
  return { id, updated_at: now };
}

function bulkUpdateBoardItems({ boardId, items } = {}) {
  if (!boardId || !Array.isArray(items) || items.length === 0) return { ok: true };
  const db = getDatabase();
  const tx = db.transaction(() => {
    for (const it of items) {
      upsertBoardItem({ boardId, item: it });
    }
  });
  tx();
  return { ok: true };
}

function deleteBoardItem({ boardId, itemId } = {}) {
  getDatabase().prepare(
    'DELETE FROM board_items WHERE id = ? AND board_id = ?'
  ).run(itemId, boardId);
  touchBoard(boardId);
  return { ok: true };
}

function deleteBoardItems({ boardId, itemIds } = {}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return { ok: true };
  const placeholders = itemIds.map(() => '?').join(',');
  getDatabase().prepare(
    `DELETE FROM board_items WHERE board_id = ? AND id IN (${placeholders})`
  ).run(boardId, ...itemIds);
  touchBoard(boardId);
  return { ok: true };
}

module.exports = {
  initDatabase,
  markSaveViewed,
  getRecentlyViewed,
  getSaveEmbeddingsCached,
  invalidateEmbeddingCache,
  getDatabase,
  closeDatabase,
  reopenDatabase,
  getDatabasePath,
  insertSave,
  getReclaimableSaves,
  updateSaveStorage,
  // Source tombstones (X bookmark / IG saved-post dismiss/dedup)
  tweetKeyFromUrl,
  igKeyFromUrl,
  sourceKeyFromUrl,
  isTweetDismissed,
  dismissTweet,
  undismissTweet,
  findSaveByHash,
  backfillContentHashes,
  findSimilarByPalette,
  getAllSaves,
  getSave,
  deleteSave,
  restoreSave,
  permanentlyDeleteSave,
  emptyTrash,
  purgeTrashBefore,
  wipeLibrary,
  updateSave,
  getSaveEmbeddings,
  getSmartViewCounts,
  getSavesByIds,
  getUnindexedSaves,
  getUnindexedCount,
  filterByColor,
  createSmartCategory,
  getSmartCategory,
  updateSmartCategoryCentroidEmbedding,
  listSmartCategories,
  listNavigableSmartCategories,
  setSmartCategoryStatus,
  hideSmartCategory,
  archiveSmartCategory,
  restoreSmartCategory,
  pinSmartCategory,
  renameSmartCategory,
  upsertSmartCategoryAlias,
  applySmartCategoryTaxonomyChanges,
  getSmartCategoryAliases,
  findSmartCategoryAliases,
  upsertSaveTopicProfile,
  getSaveTopicProfile,
  upsertSmartCategoryMembership,
  getSmartCategoryMembers,
  getSmartCategoryMemberTopicEmbeddings,
  getSmartCategorySaves,
  getSmartCategoriesForSave,
  recordSmartCategoryRun,
  listSmartCategoryRuns,
  getPendingSmartCategorySaves,
  // Semantic index
  createSemanticGeneration,
  getSemanticIndexState,
  enqueueSemanticIndexJob,
  claimSemanticIndexJob,
  completeSemanticIndexJob,
  failSemanticIndexJob,
  pauseSemanticIndex,
  resumeSemanticIndex,
  retrySemanticFailures,
  dismissSemanticFailures,
  cancelSemanticGeneration,
  getSemanticIndexStatus,
  listSemanticIndexJobs,
  getActiveSemanticVectors,
  getSemanticVector,
  // Video analysis
  enqueueVideoAnalysis,
  claimVideoAnalysis,
  completeVideoAnalysis,
  failVideoAnalysis,
  recoverBackgroundJobs,
  getVideoAnalysis,
  listVideoTagSuggestions,
  acceptVideoTagSuggestion,
  dismissVideoTagSuggestion,
  getAllCollections,
  getAllCollectionsWithThumbs,
  getCollectionsForSave,
  getCollectionsContainingAll,
  createCollection,
  renameCollection,
  setCollectionParent,
  deleteCollection,
  reorderCollections,
  reorderBoards,
  addSaveToCollection,
  removeSaveFromCollection,
  getAllTags,
  getTagsForSave,
  addTagToSave,
  removeTagFromSave,
  renameTag,
  deleteTag,
  deleteUnusedTags,
  getIntegrityResult,
  // Boards
  listBoards,
  listBoardsWithThumbs,
  getBoard,
  createBoard,
  renameBoard,
  deleteBoard,
  getBoardItems,
  getBoardPreviewSaves,
  getBoardSaveIds,
  getBoardsForSave,
  upsertBoardItem,
  bulkUpdateBoardItems,
  deleteBoardItem,
  deleteBoardItems,
};
