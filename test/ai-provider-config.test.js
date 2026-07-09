const test = require('node:test');
const assert = require('node:assert/strict');

const { readAiConfig } = require('../src/main/ai-provider-config');
const { extractJsonObject: extractLocalJson } = require('../src/main/ai-local-provider');
const { extractJsonObject: extractCodexJson } = require('../src/main/ai-codex-provider');

test('defaults to Codex subscription provider and never api.openai.com', () => {
  const config = readAiConfig({});

  assert.equal(config.provider, 'codex');
  assert.equal(config.local.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config.local.chatModel, 'llama3.2-vision');
});

test('supports explicit local provider and model overrides', () => {
  const config = readAiConfig({
    GATHERLOCAL_AI_PROVIDER: 'local',
    GATHERLOCAL_LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1/',
    GATHERLOCAL_LOCAL_CHAT_MODEL: 'local-vision',
    GATHERLOCAL_LOCAL_EMBED_MODEL: 'local-embed',
  });

  assert.equal(config.provider, 'local');
  assert.equal(config.local.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(config.local.chatModel, 'local-vision');
  assert.equal(config.local.embedModel, 'local-embed');
});

test('falls back to Codex for invalid provider names', () => {
  const config = readAiConfig({ GATHERLOCAL_AI_PROVIDER: 'openai-api-key' });

  assert.equal(config.provider, 'codex');
});

test('extracts JSON from fenced provider responses', () => {
  assert.deepEqual(extractLocalJson('```json\n{"tags":["ui"]}\n```'), { tags: ['ui'] });
  assert.deepEqual(extractCodexJson('Answer:\n{"title":"Dashboard"}'), { title: 'Dashboard' });
});

test('Codex provider uses app-server read-only sandbox spelling', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ai-codex-provider'), 'utf8');

  assert.match(source, /sandbox:\s*'read-only'/);
  assert.doesNotMatch(source, /sandbox:\s*'readOnly'/);
});

test('Codex provider includes smart category membership scoring contract', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/ai-codex-provider'), 'utf8');

  assert.match(source, /generateSmartCategoryMemberships/);
  assert.match(source, /Given one save topic profile and candidate smart categories/);
  assert.match(source, /Use 0\.75\+ for strong primary fit/);
  assert.match(source, /Use 0\.45-0\.74 for secondary fit/);
  assert.match(source, /Below 0\.45 omit/);
});
