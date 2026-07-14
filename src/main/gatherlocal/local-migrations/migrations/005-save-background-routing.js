// Frozen from the migration introduced by 8056d21.
const SQL = `
CREATE TABLE IF NOT EXISTS save_background_routes (
  save_id       TEXT PRIMARY KEY REFERENCES saves(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'pending',
  retry_count   INTEGER NOT NULL DEFAULT 0,
  available_at  INTEGER NOT NULL,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  CHECK (state IN ('pending', 'running', 'completed')),
  CHECK (retry_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_save_background_routes_ready
  ON save_background_routes(state, available_at, created_at);
`;

function apply(database) {
  database.exec(SQL);
}

function verify(database) {
  try {
    const table = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'save_background_routes'
    `).get();
    const index = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_save_background_routes_ready'
    `).get();
    return !!table && !!index;
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
