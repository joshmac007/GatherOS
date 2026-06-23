# GatherOS architecture & web-forward guardrails

This is a decision reference, not a spec. GatherOS is a local-first macOS
(Electron) app today, but we want the option to ship a **browser version**
later without a rewrite. The rule for every near-term decision:

> **Don't walk through one-way doors.** Keep the web option open with cheap
> seams now — not by building the backend today.

The deciding architectural bet: eventually the **server becomes the system of
record**, and the desktop app becomes a *local-first client/cache* over a sync
API. If we design toward that, the browser app is "just another client of the
same API." If we bolt cloud features onto the side while local SQLite stays the
source of truth, we rebuild the backend from scratch when we do web.

---

## Current architecture (today)

| Layer | Where | Notes |
| --- | --- | --- |
| UI | `src/renderer/**` (React) | Already web tech. Biggest reusable asset. |
| IPC bridge | `src/main/preload.js` → `window.moodmark.*` | The only thing the renderer talks to. |
| Data | `src/main/db.js` (better-sqlite3) | One SQLite DB per library under `userData/libraries/<id>` (`library-registry.js`). |
| Assets | local FS `images/` + `thumbs/` | Served to the renderer via the `moodmark-file://` custom protocol (`src/main/index.js`); URL built by `fileUrl()` (`src/renderer/lib/fileUrl.js`). |
| Image writes | `src/main/storage.js` `_writeImageFiles` | Writes the **original** buffer + a 400×300 JPEG thumb. |
| Search | `src/main/ipc.js` | Keyword = SQL in `getAll`; semantic = in-process cosine over **all** embeddings. |
| AI | `src/main/openai.js` (server proxy), orchestrated by `maybeAIIndexInBackground` in `index.js` | Vision (title/description/OCR) + text embedding. |
| Identity | `src/main/licensing.js` session | Reuse as the future cloud account. |
| Capture | `src/main/capture.js` (native screenshot + hotkey), `src/main/extension-server.js` (local HTTP for bookmark sync) | Capture is macOS-only; the extension endpoint is already HTTP-shaped. |

---

## The one-way doors (and the cheap way to leave them open)

### 1. Never let local file paths reach the UI
The renderer must address an asset by **save ID + variant**, not by filesystem
path. Today `fileUrl(record.file_path)` encodes an absolute path into a
`moodmark-file://` URL — so the seam already exists, it's just keyed wrong.

- **Do now:** introduce `resolveAsset(saveId, variant)` → URL. Implement it over
  the existing `moodmark-file://` protocol (look the path up by ID server-side).
  The renderer stops ever seeing `file_path`.
- **Web later:** `resolveAsset` returns an `https://…` signed URL. UI unchanged.

### 2. Model image **variants**, not "one optimized file"
Storage/optimization work should produce **`thumb` / `preview` / `original`**,
because that trio is exactly what grid / focused view / export need — and what
cloud offload and web need.

- **Do now:** `_writeImageFiles` emits thumb + medium preview (+ original only
  when the user opts into "Original quality"). Record variants keyed by save ID.
- **Web later:** same variants live in object storage; nothing re-derived.

### 3. Make data access **query-shaped**, not "load everything"
`saves.getAll()` returns the whole library and the renderer filters/sorts in JS;
semantic search loads *every* embedding and cosines in-process. Neither survives
a browser (can't ship thousands of rows / all vectors to a client) — and they're
also the at-scale perf pain.

- **Do now:** move toward access that takes `{ search, filters, sort, limit,
  cursor }` and returns a page. That shape **is** the web API.
- **Web later:** the same query object hits an HTTP endpoint; vector search moves
  to pgvector/server.

### 4. Keep a data **seam** behind `window.moodmark`
All data ops go through one async client/repository module — promise-based, no
synchronous or filesystem assumptions leaking into components. Today it
dispatches to Electron IPC; later you swap the implementation to `fetch()`.

- **Do now:** don't sprinkle raw `window.moodmark.*` calls through components;
  route them through the seam.

### 5. Keep "source of truth" logic **portable**
Dedup-by-hash, search ranking, AI orchestration: keep as plain JS with no
`fs`/Electron assumptions baked into the core, so it can lift to a Node server.
Entangle nothing portable with native capture.

### 6. Tolerate "asset not local yet → fetch"
The focused view should handle an asset that isn't on disk (loading/placeholder,
then swap in) **even while everything is local today**. That's the exact code
path cloud offload and the web client both reuse.

---

## Already web-ready — protect these

- **UUID primary keys** (`crypto.randomUUID()`) — multi-device/multi-user safe.
  Don't use auto-increment integers as external IDs.
- **Tombstones + content hashes** (`deleted_at`, `content_hash`) — the fields a
  sync layer needs. Keep writing them.
- **AI via server proxy** — already the right shape.
- **The React renderer** — keep it transport-agnostic (rules 1 & 4).
- **A licensing/account session** — scope cloud assets to the account from day
  one (per-account, signed URLs); never build an anonymous storage model you'd
  have to migrate.

## Explicitly desktop-only (won't port — and that's fine)

- Native screenshot capture + global hotkey (`capture.js`).
- Local-first "no account, fully offline" mode. Web is online-first; expect to
  keep **both** modes rather than replace the desktop one.

On web, capture leans on the browser extension (already HTTP), drag-drop, and
URL paste instead of native screenshots.

---

## How this lands on the work in front of us

Optimized-import is the first down payment on web, not a detour. Done right it:

1. stores **variants** (thumb/preview/original), not one file (rule 2),
2. exposes them via **`resolveAsset(id, variant)`**, not paths (rule 1),
3. and makes the focused view tolerate **fetch-on-demand** (rule 6).

After that, "add cloud" is "change where `resolveAsset` points," and "add web" is
"swap the data seam's transport" — instead of two rewrites.
