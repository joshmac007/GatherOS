function createBackgroundWorkCoordinator({
  lanes,
  isForegroundBusy,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError,
  logger = console,
}) {
  const orderedLanes = [...lanes];
  const idleWaiters = [];
  let started = false;
  let running = false;
  let wakeRequested = false;
  let timerDueAt = null;
  let timerHandle;
  let hasTimer = false;
  let timerVersion = 0;

  const logError = (...args) => {
    try {
      const result = logger?.error?.(...args);
      result?.catch?.(() => {});
    } catch {}
  };

  const reportError = (error, context) => {
    if (typeof onError !== 'function') {
      logError('Background work failed', error, context);
      return;
    }
    try {
      const result = onError(error, context);
      result?.catch?.((reporterError) => {
        logError('Background work error reporter failed', reporterError, {
          originalError: error,
          context,
        });
      });
    } catch (reporterError) {
      logError('Background work error reporter failed', reporterError, {
        originalError: error,
        context,
      });
    }
  };

  const resolveIdle = () => {
    if (running || wakeRequested) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const cancelTimer = () => {
    if (hasTimer) clearTimer(timerHandle);
    hasTimer = false;
    timerHandle = undefined;
    timerDueAt = null;
    timerVersion += 1;
  };

  const scheduleNextWake = (currentTime) => {
    let nextTime = null;
    for (const lane of orderedLanes) {
      const candidate = lane.nextReadyAt();
      if (!Number.isFinite(candidate) || candidate <= currentTime) continue;
      if (nextTime === null || candidate < nextTime) nextTime = candidate;
    }

    if (nextTime === null) {
      cancelTimer();
      return;
    }
    if (timerDueAt !== null && timerDueAt <= nextTime) return;

    cancelTimer();
    timerDueAt = nextTime;
    const version = timerVersion;
    timerHandle = setTimer(() => {
      if (!started || version !== timerVersion) return;
      cancelTimer();
      wake();
    }, Math.max(0, nextTime - currentTime));
    hasTimer = true;
  };

  const drain = async () => {
    try {
      while (started && wakeRequested) {
        wakeRequested = false;
        if (isForegroundBusy()) break;

        const currentTime = now();
        let claimed = null;
        for (const lane of orderedLanes) {
          const job = lane.claimReady(currentTime);
          if (job !== null && job !== undefined) {
            claimed = { lane, job };
            break;
          }
        }

        if (!claimed) {
          scheduleNextWake(currentTime);
          break;
        }

        try {
          await claimed.lane.run(claimed.job);
        } catch (error) {
          reportError(error, claimed);
        }
        if (started) wakeRequested = true;
      }
    } finally {
      running = false;
      if (started && wakeRequested) run();
      else resolveIdle();
    }
  };

  const run = () => {
    if (!started || running) return;
    running = true;
    drain().catch((error) => reportError(error, { phase: 'coordinator' }));
  };

  function wake() {
    if (!started) return;
    wakeRequested = true;
    run();
  }

  return {
    start() {
      if (started) return;
      started = true;
      wake();
    },
    wake,
    noteActivity: wake,
    stop() {
      started = false;
      wakeRequested = false;
      cancelTimer();
      resolveIdle();
    },
    whenIdle() {
      if (!running && !wakeRequested) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

module.exports = { createBackgroundWorkCoordinator };
