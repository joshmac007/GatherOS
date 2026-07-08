const test = require('node:test');
const assert = require('node:assert/strict');

test('claimImportItem caps unique bookmark claims at the selected limit', async () => {
  const { claimImportItem, importLimitReached, importProcessedCount } =
    await import('../extension/import-limit.mjs');
  const state = { active: true, limit: 3, processed: new Set() };

  assert.equal(claimImportItem(state, '1'), true);
  assert.equal(claimImportItem(state, '2'), true);
  assert.equal(claimImportItem(state, '3'), true);
  assert.equal(claimImportItem(state, '4'), false);
  assert.equal(importProcessedCount(state), 3);
  assert.equal(importLimitReached(state), true);
});

test('claimImportItem ignores duplicates and inactive imports', async () => {
  const { claimImportItem, importProcessedCount } = await import('../extension/import-limit.mjs');
  const state = { active: true, limit: 25, processed: new Set() };

  assert.equal(claimImportItem(state, 'tweet-1'), true);
  assert.equal(claimImportItem(state, 'tweet-1'), false);
  state.active = false;
  assert.equal(claimImportItem(state, 'tweet-2'), false);
  assert.equal(importProcessedCount(state), 1);
});

test('rememberImportEntries records fetched bookmarks beyond processed limit', async () => {
  const { claimImportItem, rememberImportEntries } = await import('../extension/import-limit.mjs');
  const state = { active: true, limit: 2, processed: new Set(), seenIds: new Set() };
  const entries = [{ tweetId: '1' }, { tweetId: '2' }, { tweetId: '3' }];

  assert.equal(claimImportItem(state, '1'), true);
  assert.equal(claimImportItem(state, '2'), true);
  assert.equal(claimImportItem(state, '3'), false);
  assert.equal(rememberImportEntries(state, entries), 3);
  assert.deepEqual(Array.from(state.seenIds), ['1', '2', '3']);
});
