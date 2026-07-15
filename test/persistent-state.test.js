'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createPersistentStateInitializer,
} = require('../src/main/persistent-state');

test('persistent state uses the production startup order once', () => {
  const calls = [];
  const registry = { active: 'library_default' };
  const database = { name: 'moodmark.db' };
  const initialize = createPersistentStateInitializer({
    bootstrapLibraries() {
      calls.push('libraries');
      return registry;
    },
    ensureStorageDirs() {
      calls.push('storage');
    },
    initDatabase() {
      calls.push('database');
      return database;
    },
  });

  assert.deepEqual(initialize(), { registry, database });
  assert.deepEqual(calls, ['libraries', 'storage', 'database']);
});

test('persistent state stops immediately when a startup stage fails', () => {
  const calls = [];
  const initialize = createPersistentStateInitializer({
    bootstrapLibraries() {
      calls.push('libraries');
      return {};
    },
    ensureStorageDirs() {
      calls.push('storage');
      throw new Error('storage failed');
    },
    initDatabase() {
      calls.push('database');
    },
  });

  assert.throws(initialize, /storage failed/);
  assert.deepEqual(calls, ['libraries', 'storage']);
});

test('persistent state rejects incomplete dependencies', () => {
  assert.throws(
    () => createPersistentStateInitializer({}),
    /dependencies are invalid/,
  );
});
