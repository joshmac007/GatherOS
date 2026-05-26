#!/usr/bin/env node
// Build the bundled starter pack from your live library.
//
// Picks every save in a collection named "starter pack" (case
// insensitive — call it "Starter Pack" or "starter pack", whatever
// reads best in the UI), copies their image files into a temp dir,
// and writes them into src/main/starter-pack.zip so the next time
// the app boots, installStarterPack() can ingest them.
//
// Run from the repo root:
//   node scripts/build-starter-pack.js
//
// Env overrides:
//   LIBRARY=/path/to/library         skip auto-detect, use this root
//   COLLECTION="Starter Pack"        use a differently-named collection
//   OUT=path/to/output.zip           write somewhere other than the
//                                    default src/main/starter-pack.zip
//
// Requires the system `zip` command (default on macOS + Linux). No
// new npm deps — we read the SQLite DB with the better-sqlite3
// already in the project's devDependencies and shell out for the
// archive itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'src', 'main', 'starter-pack.zip');
const DEFAULT_COLLECTION = (process.env.COLLECTION || 'starter pack').toLowerCase();
const OUT = path.resolve(process.env.OUT || DEFAULT_OUT);
// How many saves to pull when falling back to "most recent".
// Override with COUNT=NN. Larger than a curated pack would be in
// production, but it's a sane default for dev: enough to feel
// real, not so many that the install takes ages.
const RECENT_FALLBACK_COUNT = Number.parseInt(process.env.COUNT || '24', 10);

function fail(msg) {
  console.error(`\n[starter-pack] ${msg}\n`);
  process.exit(1);
}

// Mirror Electron's app.getPath('userData') resolution for the
// product name 'GatherOS'. Brett runs macOS; covering linux as a
// nice-to-have. Windows users can pass LIBRARY=... explicitly.
function defaultUserDataDir() {
  const productName = 'GatherOS';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', productName);
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdg, productName);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', productName);
  }
  return null;
}

function resolveLibraryRoot() {
  if (process.env.LIBRARY) return path.resolve(process.env.LIBRARY);
  const userData = defaultUserDataDir();
  if (!userData) fail('Unsupported platform — pass LIBRARY=/path/to/library explicitly.');
  const registryPath = path.join(userData, 'libraries.json');
  if (!fs.existsSync(registryPath)) {
    fail(`No registry at ${registryPath}. Open the app once to initialize it, or pass LIBRARY=... explicitly.`);
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  // On disk the key is `active`; the IPC layer translates that to
  // `activeId` for the renderer. We're reading the raw file so use
  // the on-disk shape.
  const activeId = registry.active
    || (Array.isArray(registry.libraries) && registry.libraries[0]?.id);
  if (!activeId) fail(`Couldn't determine active library from ${registryPath}.`);
  return path.join(userData, 'libraries', activeId);
}

function loadStarterContents(libraryRoot) {
  const dbPath = path.join(libraryRoot, 'moodmark.db');
  if (!fs.existsSync(dbPath)) fail(`No moodmark.db at ${dbPath}.`);
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    fail(`Couldn't load better-sqlite3 (${e.message}).
Run 'npm run pack:starter' (which launches under Electron's Node) instead of running this script with plain 'node'.`);
  }
  const db = new Database(dbPath, { readonly: true });

  // Prefer a curated collection so the pack is intentional. If it
  // isn't present, fall back to the N most recent live saves so the
  // script still produces a useful zip out of the box.
  const seed = db.prepare(`
    SELECT id, name FROM collections
    WHERE LOWER(name) = ?
    LIMIT 1
  `).get(DEFAULT_COLLECTION);

  let source;
  let saves;
  if (seed) {
    saves = db.prepare(`
      SELECT s.id, s.file_path, s.title
      FROM saves s
      JOIN collection_items ci ON ci.save_id = s.id
      WHERE ci.collection_id = ?
        AND s.deleted_at IS NULL
      ORDER BY ci.added_at ASC
    `).all(seed.id);
    source = `collection "${seed.name}"`;
  } else {
    saves = db.prepare(`
      SELECT id, file_path, title
      FROM saves
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RECENT_FALLBACK_COUNT);
    source = `${RECENT_FALLBACK_COUNT} most recent saves (no "${DEFAULT_COLLECTION}" collection)`;
  }

  // Pull every collection that contains at least one bundled save
  // so the installer can recreate the user's organization on the
  // fresh side. Items keep only the bundled-save IDs — extras
  // would dangle on install.
  const saveIds = saves.map((s) => s.id);
  let collections = [];
  let items = [];
  let boards = [];
  let boardItems = [];
  if (saveIds.length) {
    const placeholders = saveIds.map(() => '?').join(',');
    collections = db.prepare(`
      SELECT id, name, color
      FROM collections
      WHERE id IN (
        SELECT DISTINCT collection_id FROM collection_items
        WHERE save_id IN (${placeholders})
      )
      ORDER BY order_index ASC, name ASC
    `).all(...saveIds);
    items = db.prepare(`
      SELECT collection_id, save_id
      FROM collection_items
      WHERE save_id IN (${placeholders})
      ORDER BY added_at ASC
    `).all(...saveIds);

    // Boards (Spaces). Bundle every board that contains at least
    // one image item pointing at a bundled save. Drag in all of
    // each board's items so the layout (notes, lines, etc.) is
    // preserved — the installer remaps image items' data.saveId.
    boards = db.prepare(`
      SELECT id, name
      FROM boards
      WHERE id IN (
        SELECT DISTINCT board_id FROM board_items
        WHERE type = 'image'
          AND json_extract(data, '$.saveId') IN (${placeholders})
      )
      ORDER BY updated_at ASC
    `).all(...saveIds);
    if (boards.length) {
      const boardIds = boards.map((b) => b.id);
      const bp = boardIds.map(() => '?').join(',');
      boardItems = db.prepare(`
        SELECT id, board_id, type, x, y, width, height, rotation, z_index, data
        FROM board_items
        WHERE board_id IN (${bp})
        ORDER BY z_index ASC
      `).all(...boardIds);
    }
  }
  db.close();
  return { source, saves, collections, items, boards, boardItems };
}

function buildZip({ saves, collections, items, boards, boardItems }) {
  if (!saves.length) {
    fail('Collection is empty — add some saves to it first.');
  }

  // Stage files into a temp dir. We rename each image to its save
  // title (or filename stem if the title is empty) so the
  // installer's titleFromEntry produces the right title on the
  // other side. saveId → staged filename lookup feeds the
  // manifest, which lets the installer recreate collections by
  // mapping each member back to the inserted save's new id.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gatheros-starter-'));
  const staged = [];
  const seen = new Set();
  const saveIdToFilename = new Map();
  for (const row of saves) {
    if (!fs.existsSync(row.file_path)) {
      console.warn(`[starter-pack] skipping missing file: ${row.file_path}`);
      continue;
    }
    const ext = path.extname(row.file_path).toLowerCase() || '.png';
    const baseTitle = (row.title || path.basename(row.file_path, ext)).trim() || row.id;
    let name = baseTitle.replace(/[\/\\:*?"<>|\n\r\t]+/g, ' ').trim();
    let candidate = `${name}${ext}`;
    let i = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${name} (${i})${ext}`;
      i += 1;
    }
    seen.add(candidate.toLowerCase());
    const dest = path.join(stage, candidate);
    fs.copyFileSync(row.file_path, dest);
    staged.push(candidate);
    saveIdToFilename.set(row.id, candidate);
  }
  if (!staged.length) fail('All collection files were missing on disk.');

  // Manifest: collections + boards (Spaces) and which staged
  // filenames they reference. Installer reads this, creates the
  // collections / boards fresh, and uses the filename → new-save-id
  // map to wire memberships and image items back up. Item types
  // other than 'image' (notes, lines, etc.) keep their data verbatim.
  const manifest = {
    version: 1,
    collections: collections.map((c) => ({
      name: c.name,
      color: c.color,
      items: items
        .filter((it) => it.collection_id === c.id && saveIdToFilename.has(it.save_id))
        .map((it) => saveIdToFilename.get(it.save_id)),
    })).filter((c) => c.items.length > 0),
    boards: boards.map((b) => ({
      name: b.name,
      items: boardItems
        .filter((it) => it.board_id === b.id)
        .map((it) => {
          let data;
          try { data = JSON.parse(it.data); } catch { data = {}; }
          // Rewrite image-item references from the source save id to
          // the staged filename; the installer will swap it back to
          // the inserted save's new id.
          if (it.type === 'image' && data?.saveId && saveIdToFilename.has(data.saveId)) {
            data = { ...data, saveId: saveIdToFilename.get(data.saveId) };
          }
          return {
            type: it.type,
            x: it.x,
            y: it.y,
            width: it.width,
            height: it.height,
            rotation: it.rotation,
            z_index: it.z_index,
            data,
          };
        }),
    })),
  };
  const manifestPath = path.join(stage, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Clear any existing zip — `zip` appends by default, which would
  // accumulate stale entries across runs.
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  try {
    execFileSync('zip', [
      '-q', '-j', OUT,
      manifestPath,
      ...staged.map((f) => path.join(stage, f)),
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    fail(`'zip' failed (${e.message}). On macOS/Linux it's a system command; on Windows pass through WSL or install info-zip.`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  return { staged, manifest };
}

(function main() {
  const libraryRoot = resolveLibraryRoot();
  console.log(`[starter-pack] library: ${libraryRoot}`);
  const contents = loadStarterContents(libraryRoot);
  console.log(`[starter-pack] source: ${contents.source} (${contents.saves.length} saves, ${contents.collections.length} collections, ${contents.boards.length} boards)`);
  const { staged, manifest } = buildZip(contents);
  console.log(`[starter-pack] wrote ${staged.length} entries + ${manifest.collections.length} collection(s) + ${manifest.boards.length} board(s) → ${path.relative(REPO_ROOT, OUT)}`);
  console.log('[starter-pack] done.');
})();
