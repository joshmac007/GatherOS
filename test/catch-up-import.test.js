const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function helper() { return import('../extension/catch-up-import.mjs'); }

function run(policy, apply) {
  const state = { knownStreak: 0, imported: 0 };
  let stopped = false;
  for (const status of policy) {
    const result = apply(state, status);
    if (result.shouldSave) state.saves = (state.saves || 0) + 1;
    if (result.shouldStop) { stopped = true; break; }
  }
  return { saves: state.saves || 0, stopped, knownStreak: state.knownStreak };
}

test('catch-up stops after two known bookmarks and saves new bookmark', async () => {
  const { applyCatchUpStatus } = await helper();
  assert.deepEqual(run(['new', 'known-active', 'known-active'], applyCatchUpStatus), {
    saves: 1, stopped: true, knownStreak: 2,
  });
});

test('catch-up repairs isolated missed bookmark between known entries', async () => {
  const { applyCatchUpStatus } = await helper();
  assert.deepEqual(run(['known-active', 'new', 'known-dismissed', 'known-active'], applyCatchUpStatus), {
    saves: 1, stopped: true, knownStreak: 2,
  });
});

test('dismissed and active known entries stop without save', async () => {
  const { applyCatchUpStatus } = await helper();
  assert.deepEqual(run(['known-dismissed', 'known-active'], applyCatchUpStatus), {
    saves: 0, stopped: true, knownStreak: 2,
  });
});

test('new resets known streak', async () => {
  const { applyCatchUpStatus } = await helper();
  assert.deepEqual(run(['known-active', 'new', 'known-active', 'known-active'], applyCatchUpStatus), {
    saves: 1, stopped: true, knownStreak: 2,
  });
});

test('ordered page statuses stop at boundary', async () => {
  const { classifyCatchUpPage } = await helper();
  assert.deepEqual(classifyCatchUpPage([{ tweetId: 'a' }, { tweetId: 'b' }], ['new', 'known-active']), [
    { entry: { tweetId: 'a' }, status: 'new' },
    { entry: { tweetId: 'b' }, status: 'known-active' },
  ]);
});

test('API fallback preserves catch-up mode for scroll import', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
  const fallbackCalls = source.match(/runXScrollImport\(limit(?:, mode)?\)/g) || [];
  assert.equal(fallbackCalls.length, 4);
  assert.deepEqual(new Set(fallbackCalls), new Set(['runXScrollImport(limit, mode)']));
});

test('catch-up does not mark entries beyond its boundary as seen', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
  assert.match(source, /if \(mode !== 'catch-up'\) rememberImportEntries\(state, entries\);/);
});
