// Frozen from the migration introduced by a40406f.
function hasColumn(database, table, name) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

function apply(database) {
  if (!hasColumn(database, 'smart_category_runs', 'metadata')) {
    database.exec('ALTER TABLE smart_category_runs ADD COLUMN metadata TEXT');
  }
}

function verify(database) {
  try {
    return hasColumn(database, 'smart_category_runs', 'metadata');
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ apply, verify });
