'use strict';

function productionDependencies() {
  return {
    bootstrapLibraries: () => require('./library-registry').bootstrap(),
    ensureStorageDirs: () => require('./storage').ensureStorageDirs(),
    initDatabase: () => require('./db').initDatabase(),
  };
}

function createPersistentStateInitializer(dependencies) {
  if (!dependencies
    || typeof dependencies.bootstrapLibraries !== 'function'
    || typeof dependencies.ensureStorageDirs !== 'function'
    || typeof dependencies.initDatabase !== 'function') {
    throw new TypeError('persistent-state dependencies are invalid');
  }

  return function initializePersistentState() {
    const registry = dependencies.bootstrapLibraries();
    dependencies.ensureStorageDirs();
    const database = dependencies.initDatabase();
    return { registry, database };
  };
}

const initializePersistentState = createPersistentStateInitializer(
  productionDependencies(),
);

module.exports = {
  createPersistentStateInitializer,
  initializePersistentState,
};
