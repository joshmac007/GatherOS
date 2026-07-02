// Pre-dev cleanup: free the single-instance lock before `npm run dev`.
//
// Both the dev Electron instance AND the packaged GatherLocal.app call
// app.requestSingleInstanceLock(), so if either is already running the
// dev build sees the lock, quits immediately, and exits 0 — which then
// makes `concurrently -k` tear Vite down too. (That's the "electron
// exited with code 0" + a wall of "service was stopped" Vite errors.)
//
// So kill the dev Electron and quit/kill the packaged app before
// starting. All best-effort: pkill/osascript exit non-zero when nothing
// matches, which is fine.
const { execSync } = require('node:child_process');

function quiet(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* nothing matched — fine */ }
}

// Graceful first, then force.
quiet('osascript -e \'quit app "GatherLocal"\'');
quiet('pkill -f "GatherLocal.app/Contents/MacOS/GatherLocal"');
quiet('pkill -f "Electron.app/Contents/MacOS/Electron"');
