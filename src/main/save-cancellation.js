'use strict';

class SaveCancelledError extends Error {
  constructor(message = 'save cancelled') {
    super(message);
    this.name = 'SaveCancelledError';
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new SaveCancelledError(signal.reason?.message || 'save cancelled');
  }
}

function isSaveCancelled(error) {
  return error instanceof SaveCancelledError || error?.name === 'AbortError';
}

function createSaveCancellation({ signal, timeoutMs = 5 * 60 * 1000 } = {}) {
  const controller = new AbortController();
  const cancel = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason instanceof Error ? reason : new SaveCancelledError(reason));
  };
  const timer = setTimeout(() => cancel(new SaveCancelledError('save deadline exceeded')), timeoutMs);
  timer.unref?.();
  if (signal) {
    if (signal.aborted) cancel(signal.reason);
    else signal.addEventListener('abort', () => cancel(signal.reason), { once: true });
  }
  return { signal: controller.signal, cancel, dispose: () => clearTimeout(timer) };
}

module.exports = { SaveCancelledError, throwIfCancelled, isSaveCancelled, createSaveCancellation };
