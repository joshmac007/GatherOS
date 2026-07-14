// Pre-dev cleanup: free the single-instance lock before `npm run dev`.
//
// A packaged GatherLocal.app can own the same single-instance lock as
// the dev app. Stop only GatherLocal-owned processes; never kill generic
// Electron processes because a separate GatherOS checkout may be running.
const { execSync } = require('node:child_process');

function quiet(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* nothing matched — fine */ }
}

// Graceful first, then force.
quiet('osascript -e \'quit app "GatherLocal"\'');
quiet('pkill -f "GatherLocal.app/Contents/MacOS/GatherLocal"');
