const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadPreload() {
  let exposed = null;
  const invocations = [];
  const listeners = [];
  const removals = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name, value) { exposed = value; },
    },
    ipcRenderer: {
      invoke(channel, ...args) { invocations.push([channel, ...args]); return Promise.resolve({ ok: true }); },
      send() {},
      on(channel, listener) { listeners.push([channel, listener]); },
      removeListener(channel, listener) { removals.push([channel, listener]); },
    },
    webUtils: { getPathForFile: () => null },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadPath = path.join(ROOT, 'src', 'main', 'preload.js');
  delete require.cache[require.resolve(preloadPath)];
  try { require(preloadPath); } finally { Module._load = originalLoad; }
  return { exposed, invocations, listeners, removals };
}

test('preload exposes scoped video suggestion commands and update event', async () => {
  const harness = loadPreload();
  const api = harness.exposed.videoAnalysis;
  await api.getForSave('save-a');
  await api.accept('suggestion-a');
  await api.dismiss('suggestion-b');
  await api.acceptAll('save-a');
  await api.dismissAll('save-a');
  assert.deepEqual(harness.invocations, [
    ['video-analysis:get-for-save', 'save-a'],
    ['video-analysis:accept', 'suggestion-a'],
    ['video-analysis:dismiss', 'suggestion-b'],
    ['video-analysis:accept-all', 'save-a'],
    ['video-analysis:dismiss-all', 'save-a'],
  ]);

  const unsubscribe = harness.exposed.on('video-analysis:updated', () => {});
  assert.equal(harness.listeners[0][0], 'video-analysis:updated');
  unsubscribe();
  assert.deepEqual(harness.removals, harness.listeners);
});

test('detail panel mounts video suggestions and hides image-only AI actions', () => {
  const detailPath = path.join(ROOT, 'src', 'renderer', 'components', 'DetailPanel.jsx');
  const source = fs.readFileSync(detailPath, 'utf8');
  assert.match(source, /import VideoTagSuggestions from ['"]\.\/VideoTagSuggestions\.jsx['"]/);
  assert.match(source, /const isVideo\s*=/);
  assert.match(source, /\{isVideo && \([\s\S]*?<VideoTagSuggestions/);
  assert.match(source, /\{!isVideo && <div className=\{styles\.promptSection\}>/);
  assert.match(source, /\{!isVideo && <button[\s\S]*?handleAutoTag/);
  esbuild.transformSync(source, { loader: 'jsx', format: 'esm', target: 'es2022' });
});
