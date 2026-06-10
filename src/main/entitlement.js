// Entitlement = "what is this user allowed to do right now", combining
// the local no-account trial with the server licensing state.
//
//   'paid'  — active paid subscription → everything unlocked, forever.
//   'trial' — the local 14-day trial is still running, OR the server says
//             the account is in an (entitled) trial → full app.
//   'free'  — trial is over and there's no paid subscription → soft free
//             tier: existing saves stay fully usable, but creating NEW
//             saves and the pro features (AI, X sync, boards, multiple
//             libraries) prompt to upgrade. No hard wall, no data taken.
//
// This module is additive on its own — it computes the mode and exposes
// gating flags; the actual enforcement is wired in by the callers.

const { getPref, setPref } = require('./settings');

const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// Lazy require to avoid a require cycle (licensing → ipc → entitlement).
let _licensing = null;
function licensing() {
  if (!_licensing) _licensing = require('./licensing');
  return _licensing;
}

// Stamp the trial start on first launch. Idempotent — only writes once.
function ensureTrialStarted() {
  if (!getPref('trialStartedAt', null)) {
    setPref('trialStartedAt', Date.now());
  }
}

function localTrial() {
  const startedAt = getPref('trialStartedAt', null);
  if (!startedAt) return { startedAt: null, endsAt: null, active: false, daysLeft: 0 };
  const endsAt = startedAt + TRIAL_DAYS * DAY_MS;
  const daysLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / DAY_MS));
  return { startedAt, endsAt, active: Date.now() < endsAt, daysLeft };
}

// Synchronous read of the cached server license state (no network).
function serverState() {
  try {
    const lic = licensing();
    return typeof lic.getCachedState === 'function' ? lic.getCachedState() : null;
  } catch {
    return null;
  }
}

function getEntitlement() {
  const server = serverState();
  const sub = server && server.subscription;
  const paid = !!(server && server.state === 'entitled' && sub && sub.status !== 'trialing');
  const serverTrialing = !!(server && server.state === 'entitled'
    && (server.reason === 'trial' || (sub && sub.status === 'trialing')));
  const trial = localTrial();

  let mode;
  if (paid) mode = 'paid';
  else if (serverTrialing || trial.active) mode = 'trial';
  else mode = 'free';

  return {
    mode,
    paid,
    serverTrialing,
    trial,
    // Gating flags the callers enforce.
    canCreateSave: mode !== 'free',
    proUnlocked: mode !== 'free',
  };
}

module.exports = { TRIAL_DAYS, ensureTrialStarted, localTrial, getEntitlement };
