const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

function loadVideoSuggestions() {
  const filename = path.join(
    __dirname, '..', 'src', 'renderer', 'components', 'VideoTagSuggestions.jsx',
  );
  const source = fs.readFileSync(filename, 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'jsx', format: 'cjs', target: 'node20',
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
    module, module.exports, localRequire, filename, path.dirname(filename),
  );
  return module.exports;
}

test('derives analyzing states for queued and running video jobs', () => {
  const { deriveVideoSuggestionView } = loadVideoSuggestions();
  for (const state of ['pending', 'queued', 'running']) {
    const view = deriveVideoSuggestionView({ analysis: { state }, suggestions: [] });
    assert.equal(view.mode, 'analyzing');
    assert.equal(view.statusText, 'Analyzing video…');
  }
});

test('derives unresolved suggestions with evidence wording and no confidence', () => {
  const { deriveVideoSuggestionView } = loadVideoSuggestions();
  const view = deriveVideoSuggestionView({
    analysis: { state: 'completed' },
    suggestions: [
      {
        id: 'suggestion-a',
        name: 'patio renovation',
        confidence: 'high',
        evidence: '["visual","post_context"]',
        state: 'suggested',
      },
      {
        id: 'suggestion-b',
        name: 'outdoor kitchen',
        confidence: 'high',
        evidence: ['poster'],
        state: 'suggested',
      },
      { id: 'accepted', name: 'accepted tag', state: 'accepted' },
      { id: 'dismissed', name: 'dismissed tag', state: 'dismissed' },
    ],
  });

  assert.equal(view.mode, 'suggestions');
  assert.deepEqual(view.suggestions, [
    { id: 'suggestion-a', name: 'patio renovation', evidenceLabel: 'Visual + post context' },
    { id: 'suggestion-b', name: 'outdoor kitchen', evidenceLabel: 'Poster frame' },
  ]);
  assert.equal(JSON.stringify(view).includes('confidence'), false);
});

test('derives quiet empty, unavailable, and failure states', () => {
  const { deriveVideoSuggestionView } = loadVideoSuggestions();
  assert.equal(
    deriveVideoSuggestionView({ analysis: { state: 'completed' }, suggestions: [] }).mode,
    'empty',
  );
  assert.equal(
    deriveVideoSuggestionView({ analysis: { state: 'unavailable' }, suggestions: [] }).mode,
    'empty',
  );
  assert.deepEqual(
    deriveVideoSuggestionView({
      analysis: { state: 'failed', error: 'Video frames could not be decoded' },
      suggestions: [],
    }),
    {
      mode: 'failed',
      statusText: 'Video frames could not be decoded',
      suggestions: [],
    },
  );
});

test('detail panel mounts video suggestions and hides image-only actions for video', () => {
  const detail = fs.readFileSync(path.join(
    __dirname, '..', 'src', 'renderer', 'components', 'DetailPanel.jsx',
  ), 'utf8');
  assert.match(detail, /<VideoTagSuggestions/);
  assert.match(detail, /record\.kind\s*===\s*['"]video['"]/);
  assert.match(detail, /!isVideo\s*&&[\s\S]*Generate prompt/);
  assert.match(detail, /!isVideo\s*&&[\s\S]*Auto-tag/);
});

