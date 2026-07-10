const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

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
      return {
        __esModule: true,
        default: new Proxy({}, { get: (_target, key) => String(key) }),
      };
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
  assert.equal(view.modelStatusLabel, 'Installed');
  assert.equal(view.installCommand, null);
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
  assert.equal(view.modelStatusLabel, 'Not installed');
  assert.equal(view.installCommand, 'ollama pull nomic-embed-text');
  assert.equal(view.progressLabel, '0%');
  assert.equal(view.queueActionLabel, 'Resume');
  assert.equal(view.pauseReason, 'Ollama model unavailable');
  assert.equal(view.rebuildActionLabel, 'Rebuild index');
});

test('keeps unknown model installation state distinct from missing', () => {
  const { deriveSemanticIndexView } = loadSemanticIndexSettings();
  const view = deriveSemanticIndexView({
    connected: true,
    model: 'embeddinggemma',
  });

  assert.equal(view.modelInstalled, null);
  assert.equal(view.modelStatusLabel, 'Checking');
  assert.equal(view.installCommand, null);
});

test('reports resolved semantic action failures and exact method availability', () => {
  const {
    deriveSemanticActionAvailability,
    semanticActionFailure,
  } = loadSemanticIndexSettings();
  const actions = deriveSemanticActionAvailability({
    status() {},
    queue() {},
    pause() {},
    retryFailed() {},
  });

  assert.deepEqual(actions, {
    status: true,
    queue: true,
    pause: true,
    resume: false,
    retryFailed: true,
    dismissFailed: false,
    startRebuild: false,
    cancelRebuild: false,
  });
  assert.equal(semanticActionFailure({ ok: true }), null);
  assert.equal(
    semanticActionFailure({ ok: false, reason: 'model_client_mismatch' }),
    'Model client mismatch',
  );
  assert.equal(
    semanticActionFailure({ ok: false, reason: 'rebuild_failed', detail: 'Index generation was rejected' }),
    'Index generation was rejected',
  );
});

test('semantic action claim synchronously blocks rapid duplicate actions', () => {
  const { claimSemanticAction } = loadSemanticIndexSettings();
  const busyRef = { current: false };
  const api = { pause() {} };

  assert.equal(claimSemanticAction(busyRef, api, 'pause'), true);
  assert.equal(busyRef.current, true);
  assert.equal(claimSemanticAction(busyRef, api, 'pause'), false);
  busyRef.current = false;
  assert.equal(claimSemanticAction(busyRef, api, 'resume'), false);
});

test('refresh controller ignores stale and post-dispose responses', async () => {
  const { createSemanticRefreshController } = loadSemanticIndexSettings();
  const pending = [];
  const applied = [];
  const controller = createSemanticRefreshController({
    load() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      pending.push({ promise, resolve });
      return promise;
    },
    apply: (value) => applied.push(value),
  });

  const first = controller.refresh();
  const second = controller.refresh();
  pending[1].resolve('new snapshot');
  await second;
  pending[0].resolve('stale snapshot');
  await first;
  assert.deepEqual(applied, ['new snapshot']);

  const afterUnmount = controller.refresh();
  controller.dispose();
  pending[2].resolve('post-dispose snapshot');
  await afterUnmount;
  assert.deepEqual(applied, ['new snapshot']);
});

test('refresh controller coalesces event bursts into one scheduled load', async () => {
  const { createSemanticRefreshController } = loadSemanticIndexSettings();
  const scheduled = [];
  let loads = 0;
  const controller = createSemanticRefreshController({
    load: async () => { loads += 1; return loads; },
    apply() {},
    schedule: (callback) => scheduled.push(callback),
  });

  assert.equal(controller.scheduleRefresh(), true);
  assert.equal(controller.scheduleRefresh(), false);
  assert.equal(controller.scheduleRefresh(), false);
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.equal(loads, 1);
  assert.equal(controller.scheduleRefresh(), true);
  assert.equal(scheduled.length, 2);
});

test('semantic queue page limits rows and advances in 100-row increments', () => {
  const { deriveSemanticQueuePage } = loadSemanticIndexSettings();
  const queue = Array.from({ length: 250 }, (_value, index) => ({ id: `job-${index}` }));
  const first = deriveSemanticQueuePage(queue, 100, true);
  const second = deriveSemanticQueuePage(queue, first.nextVisibleCount, true);

  assert.equal(first.showToggle, true);
  assert.equal(first.items.length, 100);
  assert.equal(first.remaining, 150);
  assert.equal(first.nextVisibleCount, 200);
  assert.equal(second.items.length, 200);
  assert.equal(second.remaining, 50);
  assert.equal(deriveSemanticQueuePage(queue, 100, false).showToggle, false);
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
      id: 'video-underscore-job',
      domain: 'video_analysis',
      kind: 'video_analysis',
      title: 'Another video clip',
      state: 'failed',
    },
    {
      id: 'unknown-job',
      domain: 'background',
      kind: 'unknown',
      title: 'Unknown work',
      state: 'pending',
    },
    {
      id: 'semantic-dismissed',
      domain: 'semantic-index',
      title: 'Dismissed reference',
      state: 'dismissed',
    },
    {
      id: 'semantic-maintenance',
      domain: 'semantic-index',
      kind: 'maintenance',
      title: 'Semantic maintenance',
      state: 'pending',
    },
  ] });

  assert.deepEqual(rows, [
    {
      id: 'semantic-failed',
      title: 'Reference board',
      state: 'Failed',
      stateValue: 'failed',
      retryCount: 2,
      failureReason: 'Vector dimensions changed',
    },
    {
      id: 'semantic-maintenance',
      title: 'Semantic maintenance',
      state: 'Waiting',
      stateValue: 'pending',
      retryCount: 0,
      failureReason: null,
    },
  ]);
});

test('queue toggle is absent when semantic snapshot API is unavailable', () => {
  const { default: SemanticIndexSettings } = loadSemanticIndexSettings();
  const priorWindow = global.window;
  global.window = { moodmark: {} };
  try {
    const markup = renderToStaticMarkup(React.createElement(SemanticIndexSettings));
    assert.doesNotMatch(markup, /Queue details/);
  } finally {
    global.window = priorWindow;
  }
});

test('failure reason styling wraps full text and exposes an accessible label', () => {
  const componentSource = fs.readFileSync(path.join(
    __dirname, '..', 'src', 'renderer', 'components', 'SemanticIndexSettings.jsx',
  ), 'utf8');
  const cssSource = fs.readFileSync(path.join(
    __dirname, '..', 'src', 'renderer', 'components', 'SemanticIndexSettings.module.css',
  ), 'utf8');

  assert.match(componentSource, /aria-label=\{`Failure: \$\{job\.failureReason\}`\}/);
  assert.match(cssSource, /\.failure\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
});

test('visual search preference is independent from Codex session state', () => {
  const settingsSource = fs.readFileSync(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'SettingsModal.jsx',
  ), 'utf8');

  assert.match(settingsSource, /on=\{!!prefs\.semanticSearch\}/);
  assert.doesNotMatch(settingsSource, /on=\{hasAi\s*&&\s*!!prefs\.semanticSearch\}/);
});
