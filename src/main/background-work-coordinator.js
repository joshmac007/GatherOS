'use strict';

function createBackgroundWorkCoordinator({
  lanes = [],
  isForegroundBusy = () => false,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError,
  logger = console,
} = {}) {
  const orderedLanes = [...lanes];
  const idleWaiters = [];
  let started = false;
  let running = false;
  let wakeRequested = false;
  let timerDueAt = null;
  let timerHandle;

  function reportError(error, context) {
    try {
      const result = typeof onError === 'function'
        ? onError(error, context)
        : logger?.error?.('Background work failed', error, context);
      result?.catch?.(() => {});
    } catch {}
  }

  function resolveIdle() {
    if (running || wakeRequested) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function cancelTimer() {
    if (timerHandle !== undefined) clearTimer(timerHandle);
    timerHandle = undefined;
    timerDueAt = null;
  }

  function scheduleNextWake(timestamp) {
    let next = null;
    for (const lane of orderedLanes) {
      const candidate = lane.nextReadyAt?.();
      if (!Number.isFinite(candidate) || candidate <= timestamp) continue;
      if (next === null || candidate < next) next = candidate;
    }
    if (next === null) return cancelTimer();
    if (timerDueAt !== null && timerDueAt <= next) return;
    cancelTimer();
    timerDueAt = next;
    timerHandle = setTimer(() => {
      timerHandle = undefined;
      timerDueAt = null;
      wake();
    }, Math.max(0, next - timestamp));
  }

  async function drain() {
    try {
      while (started && wakeRequested) {
        wakeRequested = false;
        if (isForegroundBusy()) break;
        const timestamp = now();
        let claimed = null;
        for (const lane of orderedLanes) {
          const job = lane.claimReady(timestamp);
          if (job != null) { claimed = { lane, job }; break; }
        }
        if (!claimed) { scheduleNextWake(timestamp); break; }
        try { await claimed.lane.run(claimed.job); } catch (error) { reportError(error, claimed); }
        if (started) wakeRequested = true;
      }
    } finally {
      running = false;
      if (started && wakeRequested) run();
      else resolveIdle();
    }
  }

  function run() {
    if (!started || running) return;
    running = true;
    drain().catch((error) => reportError(error, { phase: 'coordinator' }));
  }

  function wake() {
    if (!started) return;
    wakeRequested = true;
    run();
  }

  return {
    start() { if (!started) { started = true; wake(); } },
    wake,
    noteActivity: wake,
    stop() { started = false; wakeRequested = false; cancelTimer(); resolveIdle(); },
    whenIdle() {
      if (!running && !wakeRequested) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

module.exports = { createBackgroundWorkCoordinator };
