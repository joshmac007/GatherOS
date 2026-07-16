// Tiny shared module so capture.js and ipc.js don't have to import the
// main BrowserWindow setup just to fire a "save:created" + toast.

let savedNotifier = () => {};
let duplicateNotifier = () => {};
let bookmarkNotifier = () => {};
let bookmarkFailedNotifier = () => {};
let errorNotifier = () => {};
let saveChangedNotifier = () => {};

function setSaveNotifier(fn) {
  savedNotifier = typeof fn === 'function' ? fn : () => {};
}

// Quiet, batched save path for X bookmark syncs — no per-item toast,
// sound or grid land-animation; the index.js handler collects them and
// emits a single "Synced N bookmarks" summary.
function setBookmarkNotifier(fn) {
  bookmarkNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifyBookmarkSaved(record, options) {
  bookmarkNotifier(record, options);
}

// A bookmark that arrived from the extension but failed to persist.
// Counted into the same batch so the summary toast can say
// "· N failed" instead of silently under-reporting.
function setBookmarkFailedNotifier(fn) {
  bookmarkFailedNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifyBookmarkFailed() {
  bookmarkFailedNotifier();
}

// Generic user-facing error line for fire-and-forget main-process
// paths (dock drops, background saves) that previously only logged.
// Renders as a plain action toast in the window.
function setErrorNotifier(fn) {
  errorNotifier = typeof fn === 'function' ? fn : () => {};
}

function setSaveChangedNotifier(fn) {
  saveChangedNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifySaveChanged(saveId, context) {
  return saveChangedNotifier(saveId, context);
}

function notifyError(message) {
  try { errorNotifier(message); } catch { /* toast is best-effort */ }
}

function setDuplicateNotifier(fn) {
  duplicateNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifySaved(record, options) {
  savedNotifier(record, options);
}

function notifyDuplicate(existing) {
  duplicateNotifier(existing);
}

// Tray menu shows the latest saves; mutations elsewhere need to ping
// the menu builder to refresh. Wired via setTrayRefresher in index.js.
let trayRefresher = () => {};

function setTrayRefresher(fn) {
  trayRefresher = typeof fn === 'function' ? fn : () => {};
}

function refreshTray() {
  try { trayRefresher(); } catch (err) {
    console.error('[gatheros] refreshTray failed:', err);
  }
}

module.exports = {
  setSaveNotifier,
  setDuplicateNotifier,
  setBookmarkNotifier,
  setBookmarkFailedNotifier,
  setErrorNotifier,
  setSaveChangedNotifier,
  setTrayRefresher,
  notifySaved,
  notifyDuplicate,
  notifyBookmarkSaved,
  notifyBookmarkFailed,
  notifyError,
  notifySaveChanged,
  refreshTray,
};
