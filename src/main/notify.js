// Tiny shared module so capture.js and ipc.js don't have to import the
// main BrowserWindow setup just to fire a "save:created" + toast.

let savedNotifier = () => {};
let duplicateNotifier = () => {};
let needsUpgradeNotifier = () => {};
let bookmarkNotifier = () => {};

function setSaveNotifier(fn) {
  savedNotifier = typeof fn === 'function' ? fn : () => {};
}

// Quiet, batched save path for X bookmark syncs — no per-item toast,
// sound or grid land-animation; the index.js handler collects them and
// emits a single "Synced N bookmarks" summary.
function setBookmarkNotifier(fn) {
  bookmarkNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifyBookmarkSaved(record) {
  bookmarkNotifier(record);
}

function setDuplicateNotifier(fn) {
  duplicateNotifier = typeof fn === 'function' ? fn : () => {};
}

// Fired when a fire-and-forget save path (global-hotkey screenshots) is
// blocked by the free tier — there's no IPC return value to carry the
// needsUpgrade flag, so we surface the upgrade prompt in the window.
function setNeedsUpgradeNotifier(fn) {
  needsUpgradeNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifySaved(record) {
  savedNotifier(record);
}

function notifyDuplicate(existing) {
  duplicateNotifier(existing);
}

function notifyNeedsUpgrade(context) {
  needsUpgradeNotifier(context);
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
  setNeedsUpgradeNotifier,
  setBookmarkNotifier,
  setTrayRefresher,
  notifySaved,
  notifyDuplicate,
  notifyNeedsUpgrade,
  notifyBookmarkSaved,
  refreshTray,
};
