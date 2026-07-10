const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

function loadSemanticIndexSettings() {
  const filename = path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'SemanticIndexSettings.jsx',
  );
  const source = fs.readFileSync(filename, 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'jsx',
    format: 'cjs',
    target: 'node20',
  });
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request.endsWith('.module.css')) {
      return new Proxy({}, { get: (_target, key) => String(key) });
    }
    return require(request);
  };
  new Function('module', 'exports', 'require', '__filename', '__dirname', code)(
    module,
    module.exports,
    localRequire,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

test('derives semantic health, progress, queue, and rebuild controls', () => {
  const { deriveSemanticIndexView } = loadSemanticIndexSettings();
  const view = deriveSemanticIndexView({
    ollama: { connected: true, modelInstalled: true },
    model: 'embeddinggemma',
    indexed: 648,
    total: 1204,
    waiting: 12,
    running: 1,
    failed: 3,
    currentTitle: 'Aviation design system reference',
    building_generation_id: 'generation-building',
  });

  assert.equal(view.healthLabel, 'Connected');
  assert.equal(view.model, 'embeddinggemma');
  assert.equal(view.installCommand, 'ollama pull embeddinggemma');
  assert.equal(view.indexLabel, '648 / 1,204 saves');
  assert.equal(view.progressLabel, '54%');
  assert.equal(view.queueLabel, '12 waiting · 1 indexing · 3 failed');
  assert.equal(view.currentTitle, 'Aviation design system reference');
  assert.equal(view.queueActionLabel, 'Pause');
  assert.equal(view.rebuildActionLabel, 'Cancel rebuild');
  assert.equal(view.canRetryFailed, true);
});

test('derives paused and missing-model states without NaN progress', () => {
  const { deriveSemanticIndexView } = loadSemanticIndexSettings();
  const view = deriveSemanticIndexView({
    connected: false,
    model: 'nomic-embed-text',
    modelInstalled: false,
    indexedCount: 0,
    totalCount: 0,
    paused: true,
    pause_reason: 'Ollama model unavailable',
  });

  assert.equal(view.healthLabel, 'Not connected');
  assert.equal(view.modelInstalled, false);
  assert.equal(view.progressLabel, '0%');
  assert.equal(view.queueActionLabel, 'Resume');
  assert.equal(view.pauseReason, 'Ollama model unavailable');
  assert.equal(view.rebuildActionLabel, 'Rebuild index');
});

test('normalizes only actionable semantic queue rows', () => {
  const { deriveSemanticQueueView } = loadSemanticIndexSettings();
  const rows = deriveSemanticQueueView({ jobs: [
    {
      id: 'semantic-failed',
      domain: 'semantic-index',
      save_title: 'Reference board',
      state: 'failed',
      retry_count: 2,
      error: 'Vector dimensions changed',
    },
    {
      id: 'video-job',
      domain: 'video-analysis',
      title: 'Video clip',
      state: 'pending',
    },
    {
      id: 'semantic-dismissed',
      domain: 'semantic-index',
      title: 'Dismissed reference',
      state: 'dismissed',
    },
  ] });

  assert.deepEqual(rows, [{
    id: 'semantic-failed',
    title: 'Reference board',
    state: 'Failed',
    stateValue: 'failed',
    retryCount: 2,
    failureReason: 'Vector dimensions changed',
  }]);
});
