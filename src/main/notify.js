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

module.exports = {
  setSaveNotifier,
  setDuplicateNotifier,
  notifySaved,
  notifyDuplicate,
};
