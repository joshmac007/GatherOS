function createBackgroundWorkCoordinator({
  lanes,
  isForegroundBusy,
  now = Date.now,
  setTimer = setTimeout,
}) {
  const orderedLanes = [...lanes];
  const idleWaiters = [];
  let started = false;
  let running = false;
  let wakeRequested = false;
  let timerDueAt = null;
  let timerVersion = 0;

  const resolveIdle = () => {
    if (running || wakeRequested) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const invalidateTimer = () => {
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
      invalidateTimer();
      return;
    }
    if (timerDueAt !== null && timerDueAt <= nextTime) return;

    timerDueAt = nextTime;
    timerVersion += 1;
    const version = timerVersion;
    setTimer(() => {
      if (!started || version !== timerVersion) return;
      timerDueAt = null;
      wake();
    }, Math.max(0, nextTime - currentTime));
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

        await claimed.lane.run(claimed.job);
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
    drain().catch(() => {});
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
      invalidateTimer();
      resolveIdle();
    },
    whenIdle() {
      if (!running && !wakeRequested) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

module.exports = { createBackgroundWorkCoordinator };
