// Frozen from AI_DOMAIN_SCHEMA as introduced by 42677c2. Do not replace with
// the evolved runtime schema: migration 004 owns later compatibility changes.
const SQL = `
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
  available_at     INTEGER NOT NULL,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  UNIQUE (generation_id, save_id, kind),
  CHECK (kind IN ('incremental', 'rebuild')),
  CHECK (state IN ('pending', 'running', 'completed', 'failed', 'dismissed')),
  CHECK (retry_count >= 0)
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
  retry_count      INTEGER NOT NULL DEFAULT 0,
  available_at     INTEGER NOT NULL,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  UNIQUE (save_id, fingerprint),
  CHECK (prompt_version > 0),
  CHECK (state IN ('pending', 'running', 'completed', 'failed', 'unavailable', 'superseded')),
  CHECK (retry_count >= 0)
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

const TABLES = Object.freeze([
  'semantic_index_generations',
  'semantic_index_state',
  'semantic_vectors',
  'semantic_index_jobs',
  'video_analysis_jobs',
  'video_tag_suggestions',
]);

const REQUIRED_COLUMNS = Object.freeze({
  semantic_index_generations: Object.freeze([
    'id', 'model', 'dimension', 'source_version', 'status', 'created_at',
    'activated_at', 'completed_at', 'cancelled_at',
  ]),
  semantic_index_state: Object.freeze([
    'id', 'active_generation_id', 'building_generation_id', 'paused',
    'pause_reason', 'paused_at', 'updated_at',
  ]),
  semantic_vectors: Object.freeze([
    'generation_id', 'save_id', 'model', 'dimension', 'source_hash', 'vector',
    'created_at', 'updated_at',
  ]),
  semantic_index_jobs: Object.freeze([
    'id', 'generation_id', 'save_id', 'kind', 'source_hash', 'state',
    'retry_count', 'available_at', 'error', 'created_at', 'updated_at',
    'started_at', 'finished_at',
  ]),
  video_analysis_jobs: Object.freeze([
    'id', 'save_id', 'fingerprint', 'prompt_version', 'state', 'retry_count',
    'available_at', 'error', 'created_at', 'updated_at', 'started_at', 'finished_at',
  ]),
  video_tag_suggestions: Object.freeze([
    'id', 'job_id', 'save_id', 'fingerprint', 'name', 'confidence', 'evidence',
    'state', 'created_at', 'resolved_at',
  ]),
});

const INDEXES = Object.freeze([
  'idx_semantic_generations_status',
  'idx_semantic_vectors_save',
  'idx_semantic_jobs_ready',
  'idx_semantic_jobs_generation',
  'idx_video_analysis_ready',
  'idx_video_analysis_save',
  'idx_video_suggestions_save',
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
    const state = database.prepare('SELECT id FROM semantic_index_state WHERE id = 1').get();
    const generationSql = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'semantic_index_generations'",
    ).get().sql;
    const semanticJobSql = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'semantic_index_jobs'",
    ).get().sql;
    const videoJobSql = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'video_analysis_jobs'",
    ).get().sql;
    return state?.id === 1
      && /status IN \('building', 'active', 'retired', 'cancelled', 'failed'\)/i.test(generationSql)
      && /UNIQUE \(generation_id, save_id, kind\)/i.test(semanticJobSql)
      && /UNIQUE \(save_id, fingerprint\)/i.test(videoJobSql);
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
