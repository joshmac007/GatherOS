export function applyCatchUpStatus(state, status) {
  if (!state || typeof state !== 'object') throw new TypeError('state required');
  if (status === 'new') {
    state.knownStreak = 0;
    return { shouldSave: true, shouldStop: false, knownStreak: 0 };
  }
  if (status === 'known-active' || status === 'known-dismissed') {
    state.knownStreak = (Number(state.knownStreak) || 0) + 1;
    return { shouldSave: false, shouldStop: state.knownStreak >= 2, knownStreak: state.knownStreak };
  }
  throw new Error(`unknown catch-up status: ${status}`);
}

export function classifyCatchUpPage(entries, statuses) {
  if (!Array.isArray(entries) || !Array.isArray(statuses) || entries.length !== statuses.length) {
    throw new TypeError('entries and statuses must have equal lengths');
  }
  return entries.map((entry, index) => ({ entry, status: statuses[index] }));
}
