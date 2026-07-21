'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAiUsageLedger,
  normalizeUsage,
} = require('../src/main/gatherlocal/ai/usage-ledger');

function temporaryLedger() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-ai-usage-'));
  return {
    directory,
    filePath: path.join(directory, 'ai-usage.json'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('normalizes provider totals into disjoint token categories', () => {
  assert.deepEqual(normalizeUsage({
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 5 },
    outputTokenDetails: { reasoningTokens: 10 },
  }), {
    measured: true,
    inputTokens: 75,
    outputTokens: 30,
    reasoningTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    totalTokens: 140,
  });

  assert.deepEqual(normalizeUsage({
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 3 },
  }, 'openai'), {
    measured: true,
    inputTokens: 8,
    outputTokens: 5,
    reasoningTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
    totalTokens: 20,
  });

  assert.equal(normalizeUsage({ prompt_eval_count: 17 }, 'ollama').totalTokens, 17);
  assert.equal(normalizeUsage(null).measured, false);
});

test('records global, provider, model, and capability aggregates', () => {
  const target = temporaryLedger();
  try {
    const ledger = createAiUsageLedger({
      filePath: target.filePath,
      now: () => Date.UTC(2026, 6, 21, 12),
      writeDelayMs: 60_000,
    });
    ledger.record({
      provider: 'codex',
      model: 'gpt-5.6-luna',
      capability: 'structured-json',
      outcome: 'succeeded',
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    });
    ledger.record({
      provider: 'ollama',
      model: 'embeddinggemma',
      capability: 'embedding',
      outcome: 'failed',
    });

    const snapshot = ledger.snapshot();
    assert.equal(snapshot.month, '2026-07');
    assert.deepEqual(
      { attempts: snapshot.currentMonth.totals.attempts, succeeded: snapshot.currentMonth.totals.succeeded,
        failed: snapshot.currentMonth.totals.failed, measured: snapshot.currentMonth.totals.measured,
        unmeasured: snapshot.currentMonth.totals.unmeasured, totalTokens: snapshot.currentMonth.totals.totalTokens },
      { attempts: 2, succeeded: 1, failed: 1, measured: 1, unmeasured: 1, totalTokens: 12 },
    );
    assert.equal(
      snapshot.lifetime.providers.codex.models['gpt-5.6-luna']
        .capabilities['structured-json'].inputTokens,
      9,
    );
    assert.equal(
      snapshot.lifetime.providers.ollama.models.embeddinggemma
        .capabilities.embedding.failed,
      1,
    );
    ledger.dispose();
  } finally {
    target.cleanup();
  }
});

test('persists privately, reloads, and bounds monthly history', () => {
  const target = temporaryLedger();
  let timestamp = Date.UTC(2026, 0, 2);
  try {
    const ledger = createAiUsageLedger({
      filePath: target.filePath,
      now: () => timestamp,
      historyMonths: 2,
      writeDelayMs: 60_000,
    });
    for (const month of [0, 1, 2]) {
      timestamp = Date.UTC(2026, month, 2);
      ledger.record({ provider: 'codex', model: 'm', capability: 'structured-json' });
    }
    assert.equal(ledger.flush().ok, true);
    assert.equal(fs.statSync(target.filePath).mode & 0o777, 0o600);

    const reloaded = createAiUsageLedger({ filePath: target.filePath, now: () => timestamp });
    const snapshot = reloaded.snapshot();
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(target.filePath)).months), ['2026-02', '2026-03']);
    assert.equal(snapshot.lifetime.totals.attempts, 3);
    assert.equal(snapshot.currentMonth.totals.attempts, 1);
    reloaded.dispose();
  } finally {
    target.cleanup();
  }
});

test('recovers from one corrupt ledger without exposing its contents', () => {
  const target = temporaryLedger();
  try {
    fs.writeFileSync(target.filePath, 'not-json', { mode: 0o600 });
    const errors = [];
    const ledger = createAiUsageLedger({
      filePath: target.filePath,
      now: () => Date.UTC(2026, 6, 21),
      onError: (error) => errors.push(error),
    });
    assert.equal(ledger.snapshot().storageStatus, 'recovered');
    assert.equal(fs.existsSync(`${target.filePath}.corrupt`), true);
    assert.equal(errors.length, 1);
    ledger.dispose();
  } finally {
    target.cleanup();
  }
});

test('exclusive unique temp file refuses overwrite and cleans up safely', () => {
  const target = temporaryLedger();
  const nonce = 'fixed-nonce';
  const temporary = path.join(target.directory, `.ai-usage.json.${process.pid}.${nonce}.tmp`);
  try {
    fs.writeFileSync(temporary, 'owned-by-someone-else', { mode: 0o600 });
    const ledger = createAiUsageLedger({
      filePath: target.filePath,
      now: () => Date.UTC(2026, 6, 21),
      randomUUID: () => nonce,
      writeDelayMs: 60_000,
    });
    ledger.record({ provider: 'codex', model: 'm', capability: 'structured-json' });
    assert.equal(ledger.flush().ok, false);
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'owned-by-someone-else');
    assert.equal(fs.existsSync(target.filePath), false);
  } finally {
    target.cleanup();
  }
});
