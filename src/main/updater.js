'use strict';

// GatherLocal updates by replaying its personal overlay onto a reviewed
// upstream source release. Binary auto-update remains disabled until a
// GatherLocal-owned signing and release target exists.

const DISABLED = Object.freeze({
  unsupported: true,
  reason: 'source_sync_only',
});

function initUpdater() {
  console.log('[updater] disabled: GatherLocal uses source-sync updates');
}

function applyPrefs() {
  return DISABLED;
}

async function checkNow() {
  return DISABLED;
}

function quitAndInstall() {
  return DISABLED;
}

module.exports = { initUpdater, quitAndInstall, applyPrefs, checkNow };
