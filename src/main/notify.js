// Tiny shared module so capture.js and ipc.js don't have to import the
// main BrowserWindow setup just to fire a "save:created" + toast.

let savedNotifier = () => {};
let duplicateNotifier = () => {};

function setSaveNotifier(fn) {
  savedNotifier = typeof fn === 'function' ? fn : () => {};
}

function setDuplicateNotifier(fn) {
  duplicateNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifySaved(record) {
  savedNotifier(record);
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
  setTrayRefresher,
  notifySaved,
  notifyDuplicate,
  refreshTray,
};
