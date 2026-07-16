'use strict';

function createForegroundActivityTracker({
  quietMs = 750,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onIdle = null,
} = {}) {
  const quietWindow = Math.max(0, Number(quietMs) || 0);
  let busyUntil = 0;
  let timer = null;

  function isBusy() { return now() < busyUntil; }

  function scheduleIdleWake() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (isBusy()) return scheduleIdleWake();
      if (typeof onIdle === 'function') onIdle();
    }, Math.max(0, busyUntil - now()));
    timer?.unref?.();
  }

  function noteActivity() {
    busyUntil = Math.max(busyUntil, now() + quietWindow);
    scheduleIdleWake();
    return busyUntil;
  }

  function dispose() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    busyUntil = 0;
  }

  return { isBusy, noteActivity, dispose };
}

module.exports = { createForegroundActivityTracker };
