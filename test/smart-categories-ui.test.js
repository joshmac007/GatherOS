const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('smart category chips keep recent-change indicator and controls subtle', () => {
  const rail = read('src/renderer/components/SmartChipRail.jsx');
  const app = read('src/renderer/App.jsx');
  const ipc = read('src/main/ipc.js');
  const preload = read('src/main/preload.js');

  assert.match(rail, /category\.recent_change/);
  assert.match(rail, /recent_change_note/);
  assert.match(rail, /History/);
  assert.match(rail, /onSmartCategoryContextMenu/);

  assert.match(app, /handleSmartCategoryContextMenu/);
  assert.match(app, /smartCategories\?\.hide/);
  assert.match(app, /smartCategories\?\.pin/);
  assert.match(app, /Pin category name/);
  assert.match(app, /Hide category/);

  assert.match(preload, /smart-categories:hide/);
  assert.match(preload, /smart-categories:pin/);
  assert.match(ipc, /smart-categories:hide/);
  assert.match(ipc, /smart-categories:pin/);
});
