// Durable per-save smart-category assignment state. One current row per save
// keeps retries, taxonomy/profile evidence, and terminal outcomes recoverable
// without inventing a second queue or backfilling every existing save.
const SQL = `
CREATE TABLE IF NOT EXISTS smart_category_assignment_state (
  save_id               TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
  profile_version       INTEGER,
  taxonomy_fingerprint  TEXT NOT NULL DEFAULT '',
  phase                 TEXT NOT NULL,
  state                 TEXT NOT NULL,
  outcome               TEXT,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  available_at          INTEGER NOT NULL,
  error                 TEXT,
  updated_at            INTEGER NOT NULL,
  completed_at          INTEGER,
  CHECK (phase IN ('profile', 'assignment')),
  CHECK (state IN ('retry_wait', 'exhausted', 'completed')),
  CHECK (outcome IS NULL OR outcome IN ('assigned', 'unmatched')),
  CHECK (retry_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_smart_category_assignment_pending
  ON smart_category_assignment_state(state, available_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_smart_category_assignment_taxonomy
  ON smart_category_assignment_state(taxonomy_fingerprint, state);
`;

const REQUIRED_COLUMNS = Object.freeze([
  'save_id', 'profile_version', 'taxonomy_fingerprint', 'phase', 'state',
  'outcome', 'retry_count', 'available_at', 'error', 'updated_at', 'completed_at',
]);

function apply(database) {
  database.exec(SQL);
}

function verify(database) {
  try {
    const definition = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'smart_category_assignment_state'",
    ).get();
    if (!definition?.sql) return false;
    const columns = new Set(database.prepare(
      'PRAGMA table_info(smart_category_assignment_state)',
    ).all().map((row) => row.name));
    if (REQUIRED_COLUMNS.some((column) => !columns.has(column))) return false;
    const indexes = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all().map((row) => row.name));
    if (!indexes.has('idx_smart_category_assignment_pending')) return false;
    if (!indexes.has('idx_smart_category_assignment_taxonomy')) return false;
    return /phase IN \('profile', 'assignment'\)/i.test(definition.sql)
      && /state IN \('retry_wait', 'exhausted', 'completed'\)/i.test(definition.sql)
      && /outcome IS NULL OR outcome IN \('assigned', 'unmatched'\)/i.test(definition.sql)
      && /save_id\s+TEXT\s+PRIMARY KEY/i.test(definition.sql);
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
