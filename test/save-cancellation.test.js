const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SaveCancelledError,
  createSaveCancellation,
  throwIfCancelled,
  isSaveCancelled,
} = require('../src/main/save-cancellation');

test('one save cancellation signal carries caller cancellation through pre-commit work', () => {
  const caller = new AbortController();
  const request = createSaveCancellation({ signal: caller.signal, timeoutMs: 60_000 });
  caller.abort(new SaveCancelledError('caller stopped save'));
  assert.equal(request.signal.aborted, true);
  assert.throws(() => throwIfCancelled(request.signal), /caller stopped save/);
  request.dispose();
});

test('save cancellation classifies deadline and fetch abort errors', () => {
  assert.equal(isSaveCancelled(new SaveCancelledError('save deadline exceeded')), true);
  assert.equal(isSaveCancelled(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isSaveCancelled(new Error('disk full')), false);
});
