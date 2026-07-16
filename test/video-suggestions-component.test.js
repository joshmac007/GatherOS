const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

function loadComponent() {
  const filename = path.join(
    __dirname, '..', 'src', 'renderer', 'components', 'VideoTagSuggestions.jsx',
  );
  const source = fs.readFileSync(filename, 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'jsx', format: 'cjs', target: 'node20',
  });
  const module = { exports: {} };
  const localRequire = (request) => request.endsWith('.module.css')
    ? { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) }
    : require(request);
  new Function('module', 'exports', 'require', '__filename', '__dirname', code)(
    module, module.exports, localRequire, filename, path.dirname(filename),
  );
  return module.exports;
}

test('snapshot guard rejects response from previously selected save', () => {
  const { createVideoSnapshotRequestGuard } = loadComponent();
  const guard = createVideoSnapshotRequestGuard();
  guard.activate('save-a');
  const requestA = guard.begin('save-a');
  guard.activate('save-b');
  const requestB = guard.begin('save-b');
  assert.equal(guard.isCurrent('save-a', requestA), false);
  assert.equal(guard.isCurrent('save-b', requestB), true);
});

test('action guard prevents duplicate mutation requests', () => {
  const { createVideoActionRequestGuard } = loadComponent();
  const guard = createVideoActionRequestGuard();
  const claim = guard.claim();
  assert.ok(claim);
  assert.equal(guard.claim(), null);
  assert.equal(guard.release(claim), true);
  assert.ok(guard.claim());
});

test('view exposes pending, failure, and unresolved suggestion states', () => {
  const { deriveVideoSuggestionView } = loadComponent();
  assert.equal(deriveVideoSuggestionView({ analysis: { state: 'running' } }).mode, 'analyzing');
  assert.equal(deriveVideoSuggestionView({
    analysis: { state: 'failed', error: 'Decode failed' },
  }).statusText, 'Decode failed');
  assert.deepEqual(deriveVideoSuggestionView({
    analysis: { state: 'completed' },
    suggestions: [{
      id: 'tag-a', name: 'patio renovation', evidence: ['visual', 'post_context'], state: 'suggested',
    }],
  }).suggestions, [{
    id: 'tag-a', name: 'patio renovation', evidenceLabel: 'Visual + post context',
  }]);
});
