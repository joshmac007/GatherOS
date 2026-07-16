const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadJsx(relativePath, requireOverride = null) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: filename.endsWith('.jsx') ? 'jsx' : 'js',
    format: 'cjs',
    target: 'node20',
  });
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request.endsWith('.module.css')) {
      return { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) };
    }
    if (requireOverride) {
      const replacement = requireOverride(request);
      if (replacement !== undefined) return replacement;
    }
    return require(request);
  };
  new Function('module', 'exports', 'require', '__filename', '__dirname', code)(
    module, module.exports, localRequire, filename, path.dirname(filename),
  );
  return module.exports;
}

test('semantic settings derives provider-neutral health and queue state', () => {
  const {
    deriveSemanticIndexView,
    deriveSemanticQueueView,
  } = loadJsx('src/renderer/components/SemanticIndexSettings.jsx');
  const view = deriveSemanticIndexView({
    connected: true,
    provider: 'local',
    model: 'embed-model',
    modelInstalled: true,
    indexed: 24,
    total: 30,
    waiting: 4,
    running: 1,
    failed: 1,
    setupAction: 'install embed-model',
  });
  assert.equal(view.provider, 'local');
  assert.equal(view.healthLabel, 'Connected');
  assert.equal(view.progressLabel, '80%');
  assert.equal(view.setupAction, 'install embed-model');
  assert.doesNotMatch(JSON.stringify(view), /Codex|Ollama|OpenAI/i);

  const jobs = deriveSemanticQueueView({ jobs: [
    { id: 'semantic', domain: 'semantic-index', state: 'pending', title: 'Save' },
    { id: 'video', domain: 'video-analysis', state: 'pending', title: 'Clip' },
  ] });
  assert.deepEqual(jobs.map((job) => job.id), ['semantic']);
});

test('semantic health reads merged top-level IPC status without nested health shape', () => {
  const { deriveSemanticIndexView } = loadJsx(
    'src/renderer/components/SemanticIndexSettings.jsx',
  );
  const connected = deriveSemanticIndexView({
    ok: true,
    status: 'connected',
    provider: 'local',
    model: 'embed-model',
    indexed: 10,
    total: 10,
  });
  assert.equal(connected.connected, true);
  assert.equal(connected.modelInstalled, true);
  assert.equal(connected.healthLabel, 'Connected');

  const missingModel = deriveSemanticIndexView({
    ok: false,
    status: 'model-missing',
    provider: 'local',
    model: 'embed-model',
    setupAction: 'install embed-model',
  });
  assert.equal(missingModel.connected, true);
  assert.equal(missingModel.modelInstalled, false);
  assert.equal(missingModel.modelStatusLabel, 'Not installed');
  assert.equal(missingModel.setupAction, 'install embed-model');

  const nestedOnly = deriveSemanticIndexView({
    health: { ok: true, model: 'wrong-contract' },
  });
  assert.equal(nestedOnly.connected, false);
  assert.equal(nestedOnly.model, 'Not configured');
});

test('semantic notice subscription forwards only useful lifecycle messages', () => {
  const { subscribeSemanticNotices } = loadJsx(
    'src/renderer/components/SemanticIndexSettings.jsx',
  );
  let handler;
  let removed = false;
  const messages = [];
  const unsubscribe = subscribeSemanticNotices({
    on(event, nextHandler) {
      assert.equal(event, 'semantic-index:notice');
      handler = nextHandler;
      return () => { removed = true; };
    },
  }, (message) => messages.push(message));
  handler({ type: 'paused' });
  handler({ type: 'rebuild-complete' });
  handler({ type: 'unknown' });
  assert.deepEqual(messages, [
    'Semantic indexing paused. Check Settings for details.',
    'Semantic index rebuild complete.',
  ]);
  unsubscribe();
  assert.equal(removed, true);
});

test('library routing sends smart-category views through exact category query', async () => {
  const calls = [];
  const soundsStub = { playPop() {}, playTrashSound() {} };
  const { fetchLibraryView } = loadJsx(
    'src/renderer/hooks/useLibrary.js',
    (request) => request === '../lib/sounds.js' ? soundsStub : undefined,
  );
  const moodmark = {
    saves: {
      getAll: async (input) => { calls.push(['all', input]); return []; },
      findSimilar: async (id, limit) => { calls.push(['similar', id, limit]); return []; },
    },
    smartCategories: {
      getSaves: async (input) => { calls.push(['smart', input]); return ['smart-save']; },
    },
  };
  const result = await fetchLibraryView({
    moodmark,
    view: { type: 'smartCategory', id: 'category-a' },
    search: 'aviation',
    colorHex: '#123456',
  });
  assert.deepEqual(result, ['smart-save']);
  assert.deepEqual(calls, [['smart', {
    categoryId: 'category-a', search: 'aviation', colorHex: '#123456',
  }]]);
});

test('renderer integration preserves smart navigation, actions, activity, and settings seam', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/App.jsx'), 'utf8');
  const rail = fs.readFileSync(path.join(
    ROOT, 'src/renderer/components/SmartChipRail.jsx',
  ), 'utf8');
  const settings = fs.readFileSync(path.join(
    ROOT, 'src/renderer/components/SettingsModal.jsx',
  ), 'utf8');
  assert.match(app, /smartCategories\?\.listNav/);
  assert.match(app, /onSmartCategoryContextMenu=\{handleSmartCategoryContextMenu\}/);
  assert.match(app, /subscribeSemanticNotices/);
  assert.match(app, /noteActivity\?\.\(\{ kind: 'modal'/);
  assert.match(app, /semanticStatus\?\.searchReady/);
  assert.match(rail, /type: 'smartCategory'/);
  assert.match(rail, /recent_change_note/);
  assert.match(settings, /<SemanticIndexSettings \/>/);
  assert.match(settings, /on=\{!!prefs\.semanticSearch\}/);
  assert.doesNotMatch(settings, /ai:reindex-progress|unindexedCount\(\)/);

  esbuild.transformSync(app, { loader: 'jsx', format: 'esm', target: 'es2022' });
  esbuild.transformSync(rail, { loader: 'jsx', format: 'esm', target: 'es2022' });
  esbuild.transformSync(settings, { loader: 'jsx', format: 'esm', target: 'es2022' });
});
