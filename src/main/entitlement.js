// GatherLocal is the free/local edition: no trial clock, paywall, or
// license downgrade path. Keep the same public API so upstream call sites
// continue to work without carrying billing state through the app.

const TRIAL_DAYS = 36500;

function ensureTrialDecided() {}

function localTrial() {
  return { startedAt: null, endsAt: null, active: true, daysLeft: 36500 };
}

function getEntitlement() {
  const trial = localTrial();
  return {
    mode: 'paid',
    paid: true,
    trial,
    serverTrialing: false,
    canCreateSave: true,
    proUnlocked: true,
  };
}

function canCreateSave() {
  return true;
}

module.exports = { TRIAL_DAYS, ensureTrialDecided, localTrial, getEntitlement, canCreateSave };
