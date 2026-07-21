const STAGES = new Set(['starting', 'scanning', 'saving', 'stopping', 'complete', 'stopped', 'failed']);
const TERMINAL_STAGES = new Set(['complete', 'stopped', 'failed']);
export const SOCIAL_IMPORT_STALE_AFTER_MS = 30_000;
export const SOCIAL_IMPORT_HEARTBEAT_INTERVAL_MS = Math.floor(SOCIAL_IMPORT_STALE_AFTER_MS / 3);

function acceptedOutcome(response) {
  if (!response || response.ok === false) {
    return { ok: false, outcome: 'controller-rejected', cancelRequested: true };
  }
  return { ok: true, outcome: 'accepted', cancelRequested: !!response.cancelRequested };
}

export function createSocialImportProgress({
  sendNativeMessage,
  hostName,
  randomUUID = () => globalThis.crypto.randomUUID(),
  log = () => {},
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
} = {}) {
  if (typeof sendNativeMessage !== 'function') throw new TypeError('sendNativeMessage required');
  if (typeof hostName !== 'string' || !hostName.trim()) throw new TypeError('hostName required');
  if (typeof randomUUID !== 'function') throw new TypeError('randomUUID required');
  let snapshot = null;
  let cancelRequested = false;
  let warned = false;
  let reportingDisabled = false;
  let inFlight = null;
  let pending = null;
  let version = 0;
  const waiters = [];
  let heartbeatTimer = null;

  function stopHeartbeat() {
    if (heartbeatTimer === null) return;
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    if (heartbeatTimer !== null || !snapshot || TERMINAL_STAGES.has(snapshot.stage) || reportingDisabled) return;
    heartbeatTimer = setIntervalFn(() => { void report({ wait: false }); }, SOCIAL_IMPORT_HEARTBEAT_INTERVAL_MS);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  async function send(snapshotToSend) {
    try {
      return acceptedOutcome(await sendNativeMessage(hostName, {
        type: 'social-import-status', ...snapshotToSend,
      }));
    } catch (error) {
      if (!warned) {
        warned = true;
        try { log('[gatheros] social import progress unavailable:', error?.message || error); } catch { /* ignore */ }
      }
      return { ok: false, outcome: 'transport-unavailable', cancelRequested };
    }
  }

  async function drainReports() {
    while (pending) {
      const current = pending;
      pending = null;
      const outcome = reportingDisabled
        ? { ok: false, outcome: 'controller-rejected', cancelRequested: true }
        : await send(current.snapshot);
      cancelRequested = cancelRequested || outcome.cancelRequested;
      if (outcome.outcome === 'controller-rejected') {
        reportingDisabled = true;
        stopHeartbeat();
      }
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].version <= current.version) {
          const [{ resolve }] = waiters.splice(index, 1);
          resolve(outcome);
        }
      }
    }
    inFlight = null;
  }

  function report({ wait = true } = {}) {
    if (!snapshot) return Promise.resolve({ ok: false, outcome: 'transport-unavailable', cancelRequested });
    if (reportingDisabled) {
      stopHeartbeat();
      return Promise.resolve({ ok: false, outcome: 'controller-rejected', cancelRequested: true });
    }
    version += 1;
    const reportVersion = version;
    pending = { snapshot: { ...snapshot }, version: reportVersion };
    const result = wait
      ? new Promise((resolve) => waiters.push({ version: reportVersion, resolve }))
      : Promise.resolve({ ok: true, outcome: 'queued', cancelRequested });
    if (!inFlight) inFlight = drainReports();
    return result;
  }

  async function start({ platform, mode, target = null, startedAt = Date.now(), message = null } = {}) {
    snapshot = {
      runId: randomUUID(), platform, mode, stage: 'starting',
      scanned: 0, saved: 0, known: 0, failed: 0,
      target: target === undefined ? null : target, startedAt, message,
    };
    cancelRequested = false;
    warned = false;
    reportingDisabled = false;
    const outcome = await report();
    if (outcome.outcome === 'accepted') startHeartbeat();
    return { ...getSnapshot(), ...outcome };
  }

  async function update(patch = {}) {
    if (!snapshot) throw new Error('progress run not started');
    if (TERMINAL_STAGES.has(snapshot.stage)) throw new Error('progress run already finished');
    const next = { ...snapshot, ...patch };
    if (!STAGES.has(next.stage)) throw new Error('invalid stage');
    if (cancelRequested && ['starting', 'scanning', 'saving'].includes(next.stage)) next.stage = 'stopping';
    for (const key of ['scanned', 'saved', 'known', 'failed']) {
      if (!Number.isInteger(next[key]) || next[key] < snapshot[key]) throw new Error(`${key} must be monotonic`);
    }
    snapshot = next;
    const response = await report();
    return { ...getSnapshot(), ...response };
  }

  async function finish(stage = 'complete', message = null) {
    if (!['complete', 'stopped', 'failed'].includes(stage)) throw new Error('invalid terminal stage');
    stopHeartbeat();
    return update({ stage, message });
  }

  function getSnapshot() {
    return snapshot ? { ...snapshot, cancelRequested } : null;
  }

  return {
    start,
    update,
    finish,
    report,
    getSnapshot,
    isCancellationRequested: () => cancelRequested,
    beforeNext: () => !cancelRequested,
    stopHeartbeat,
  };
}
