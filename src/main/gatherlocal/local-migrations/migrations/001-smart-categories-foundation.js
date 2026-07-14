// Frozen from the migration introduced by 59bdda6.
const SQL = `
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
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_smart_category_runs_started
  ON smart_category_runs(started_at DESC);
`;

const TABLES = Object.freeze([
  'smart_categories',
  'smart_category_aliases',
  'smart_category_members',
  'save_topic_profiles',
  'smart_category_runs',
]);

const REQUIRED_COLUMNS = Object.freeze({
  smart_categories: Object.freeze([
    'id', 'name', 'description', 'status', 'parent_id', 'centroid_embedding',
    'visibility_score', 'member_count', 'created_at', 'updated_at',
    'last_changed_at', 'change_kind', 'frozen_name',
  ]),
  smart_category_aliases: Object.freeze(['id', 'category_id', 'alias', 'source', 'created_at']),
  smart_category_members: Object.freeze([
    'category_id', 'save_id', 'weight', 'evidence', 'assigned_at', 'updated_at',
  ]),
  save_topic_profiles: Object.freeze([
    'save_id', 'concepts', 'content_type', 'intent_guess', 'summary', 'embedding',
    'confidence', 'updated_at',
  ]),
  smart_category_runs: Object.freeze([
    'id', 'run_type', 'started_at', 'finished_at', 'input_save_count',
    'created_count', 'renamed_count', 'merged_count', 'split_count',
    'failed_count', 'provider', 'error',
  ]),
});

const INDEXES = Object.freeze([
  'idx_smart_categories_status',
  'idx_smart_categories_parent_id',
  'idx_smart_category_aliases_alias',
  'idx_smart_category_members_save',
  'idx_smart_category_members_category_weight',
  'idx_smart_category_runs_started',
]);

function apply(database) {
  database.exec(SQL);
}

function verify(database) {
  try {
    for (const table of TABLES) {
      const definition = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table);
      if (!definition?.sql) return false;
      const actual = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      if (REQUIRED_COLUMNS[table].some((column) => !actual.has(column))) return false;
    }
    const indexes = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all().map((row) => row.name));
    if (INDEXES.some((name) => !indexes.has(name))) return false;
    const categorySql = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'smart_categories'",
    ).get().sql;
    const memberSql = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'smart_category_members'",
    ).get().sql;
    return /status IN \('candidate', 'visible', 'hidden', 'archived'\)/i.test(categorySql)
      && /PRIMARY KEY \(category_id, save_id\)/i.test(memberSql)
      && /weight >= 0 AND weight <= 1/i.test(memberSql);
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
