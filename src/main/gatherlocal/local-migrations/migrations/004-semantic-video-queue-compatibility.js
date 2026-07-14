// Frozen from the compatibility migration completed by 7a1edbc and retained
// through f732fbd. It upgrades migration 003's deliberately older schema.
function hasColumn(database, table, name) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

function addColumnIfMissing(database, table, name, type) {
  if (!hasColumn(database, table, name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function apply(database) {
  addColumnIfMissing(
    database,
    'semantic_index_jobs',
    'retryable',
    'INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1))',
  );
  addColumnIfMissing(
    database,
    'video_analysis_jobs',
    'retryable',
    'INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1))',
  );
  addColumnIfMissing(
    database,
    'video_analysis_jobs',
    'superseded_from_state',
    `TEXT CHECK (superseded_from_state IS NULL OR superseded_from_state IN
      ('pending', 'completed', 'failed', 'unavailable'))`,
  );

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
      DELETE FROM semantic_index_jobs
       WHERE generation_id IN (
         SELECT id FROM semantic_index_generations
          WHERE status = 'building' AND id != ?
       )
    `).run(survivor.id);
    database.prepare(`
      DELETE FROM semantic_vectors
       WHERE generation_id IN (
         SELECT id FROM semantic_index_generations
          WHERE status = 'building' AND id != ?
       )
    `).run(survivor.id);
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
}

function verify(database) {
  try {
    const semanticColumns = database.prepare('PRAGMA table_info(semantic_index_jobs)').all();
    const videoColumns = database.prepare('PRAGMA table_info(video_analysis_jobs)').all();
    const index = database.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_semantic_generations_one_building'
    `).get();
    const building = database.prepare(`
      SELECT COUNT(*) AS count FROM semantic_index_generations WHERE status = 'building'
    `).get();
    const state = database.prepare(`
      SELECT building_generation_id FROM semantic_index_state WHERE id = 1
    `).get();
    const pointerValid = state?.building_generation_id == null || !!database.prepare(`
      SELECT 1 FROM semantic_index_generations WHERE id = ? AND status = 'building'
    `).get(state.building_generation_id);
    return semanticColumns.some((column) => column.name === 'retryable')
      && videoColumns.some((column) => column.name === 'retryable')
      && videoColumns.some((column) => column.name === 'superseded_from_state')
      && /UNIQUE INDEX/i.test(index?.sql || '')
      && building.count <= 1
      && pointerValid;
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
