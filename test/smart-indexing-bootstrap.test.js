'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function responseHarness() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('main bootstrap owns provider-neutral runtime and generation services', () => {
  const main = source('src/main/index.js');
  assert.match(main, /const aiRuntime = getAiRuntime\(\)/);
  assert.match(main, /model: aiRuntime\.modelFor\(CAPABILITIES\.EMBEDDING\)/);
  assert.match(main, /health: \(\) => aiRuntime\.health\(CAPABILITIES\.EMBEDDING\)/);
  assert.match(main, /embed: \(request\) => aiRuntime\.embed\(request\)/);
  assert.match(main, /structuredProvider = \{[\s\S]*completeJson: \(request\) => aiRuntime\.completeJson\(request\)/);
  assert.match(main, /createVideoSemanticWorkflows\(\{/);
  assert.match(main, /createBackgroundSmartCategoryRefresh\(\{/);
  assert.match(main, /semanticIndex: backgroundRuntime\.getSemanticIndex\(\)/);
  assert.doesNotMatch(main, /updates\.embedding|vectorToBuffer|embedText/);
});

test('library and quit lifecycle drain or rebind background ownership', () => {
  const main = source('src/main/index.js');
  assert.match(main, /backgroundRuntime\.rebind\(remove\)/);
  assert.match(main, /backgroundRuntime\.rebind\(activate\)/);
  assert.match(main, /beforeTransition: async \(\) => \{[\s\S]*saveBackgroundRouter\.pause\(\);[\s\S]*smartCategoryRefresh\?\.pause\(\);[\s\S]*smartCategoryRefresh\?\.drain\(\)/);
  assert.match(main, /afterTransition: async \(\) => \{[\s\S]*saveBackgroundRouter\.resume\(\);[\s\S]*smartCategoryRefresh\?\.resume\(\)/);
  assert.match(main, /backgroundRuntime\.stopAndDrain\(\)/);
  assert.match(main, /smartCategoryRefresh\?\.pause\(\);[\s\S]*smartCategoryRefresh\?\.drain\(\)/);
});

test('extension acknowledges saves after durable routing attempt', async () => {
  const { completeSavedResponse } = require('../src/main/extension-server');
  const res = responseHarness();
  const calls = [];
  const body = await completeSavedResponse({
    res,
    record: { id: 'save-a' },
    routeSave: async (record, options) => {
      calls.push(['route', record.id, options]);
      return { ok: true };
    },
    notify: (record, options) => calls.push(['notify', record.id, options]),
  });
  assert.deepEqual(calls, [
    ['route', 'save-a', { duplicate: false }],
    ['notify', 'save-a', { backgroundRouted: true }],
  ]);
  assert.deepEqual(body, { ok: true, id: 'save-a' });
  assert.deepEqual(res.body, body);
});

test('save mutation notifier is an injected lifecycle seam', async () => {
  const notify = require('../src/main/notify');
  let received = null;
  notify.setSaveChangedNotifier((saveId, context) => {
    received = { saveId, context };
    return { ok: true };
  });
  assert.deepEqual(
    await notify.notifySaveChanged('save-a', { kind: 'tag' }),
    { ok: true },
  );
  assert.deepEqual(received, { saveId: 'save-a', context: { kind: 'tag' } });
});
