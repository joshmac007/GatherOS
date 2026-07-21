'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_MONTHS = 24;
const DEFAULT_WRITE_DELAY_MS = 1_000;
const KEY_PATTERN = /^[a-zA-Z0-9._:/-]{1,160}$/;

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function emptyMetrics() {
  return {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    measured: 0,
    unmeasured: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    lastUsedAt: null,
  };
}

function emptyScope() {
  return { totals: emptyMetrics(), providers: {} };
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lifetime: emptyScope(),
    months: {},
    lastUsedAt: null,
  };
}

function monthKey(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new TypeError('AI usage timestamp is invalid');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function safeIdentity(value, fallback) {
  const clean = typeof value === 'string' ? value.trim() : '';
  return KEY_PATTERN.test(clean) && clean !== '__proto__' && clean !== 'constructor' && clean !== 'prototype'
    ? clean
    : fallback;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizedTokens({ input, output, reasoning, cacheRead, cacheWrite, total, measured }) {
  const cacheReadTokens = finiteCount(cacheRead);
  const cacheWriteTokens = finiteCount(cacheWrite);
  const reasoningTokens = finiteCount(reasoning);
  const inputTotal = finiteCount(input);
  const outputTotal = finiteCount(output);
  const inputTokens = Math.max(0, inputTotal - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, outputTotal - reasoningTokens);
  const derivedTotal = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
  return {
    measured: Boolean(measured),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: total == null ? derivedTotal : finiteCount(total),
  };
}

function normalizeUsage(usage, format = 'ai-sdk') {
  if (!usage || typeof usage !== 'object') return normalizedTokens({ measured: false });
  if (format === 'openai') {
    const recognized = [
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.total_tokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.completion_tokens_details?.reasoning_tokens,
    ].some((value) => value !== undefined && value !== null);
    return normalizedTokens({
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
      reasoning: usage.completion_tokens_details?.reasoning_tokens,
      cacheRead: usage.prompt_tokens_details?.cached_tokens,
      cacheWrite: 0,
      total: usage.total_tokens,
      measured: recognized,
    });
  }
  if (format === 'ollama') {
    const recognized = usage.prompt_eval_count !== undefined && usage.prompt_eval_count !== null;
    return normalizedTokens({
      input: usage.prompt_eval_count,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.prompt_eval_count,
      measured: recognized,
    });
  }
  const recognized = [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.reasoningTokens,
    usage.cachedInputTokens,
    usage.cacheReadInputTokens,
    usage.cacheWriteInputTokens,
    usage.inputTokenDetails?.cacheReadTokens,
    usage.inputTokenDetails?.cacheWriteTokens,
    usage.outputTokenDetails?.reasoningTokens,
  ].some((value) => value !== undefined && value !== null);
  return normalizedTokens({
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: firstDefined(usage.outputTokenDetails?.reasoningTokens, usage.reasoningTokens),
    cacheRead: firstDefined(usage.inputTokenDetails?.cacheReadTokens, usage.cacheReadInputTokens, usage.cachedInputTokens),
    cacheWrite: firstDefined(usage.inputTokenDetails?.cacheWriteTokens, usage.cacheWriteInputTokens),
    total: usage.totalTokens,
    measured: recognized,
  });
}

function assertMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('AI usage metrics are invalid');
  const next = emptyMetrics();
  for (const key of Object.keys(next)) {
    if (key === 'lastUsedAt') {
      next.lastUsedAt = value.lastUsedAt == null ? null : finiteCount(value.lastUsedAt);
    } else {
      next[key] = finiteCount(value[key]);
    }
  }
  return next;
}

function assertScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('AI usage scope is invalid');
  const scope = { totals: assertMetrics(value.totals), providers: {} };
  for (const [provider, providerValue] of Object.entries(value.providers || {})) {
    if (safeIdentity(provider, null) !== provider || !providerValue || typeof providerValue !== 'object') {
      throw new TypeError('AI usage provider is invalid');
    }
    const models = {};
    for (const [model, modelValue] of Object.entries(providerValue.models || {})) {
      if (safeIdentity(model, null) !== model || !modelValue || typeof modelValue !== 'object') {
        throw new TypeError('AI usage model is invalid');
      }
      const capabilities = {};
      for (const [capability, metrics] of Object.entries(modelValue.capabilities || {})) {
        if (safeIdentity(capability, null) !== capability) throw new TypeError('AI usage capability is invalid');
        capabilities[capability] = assertMetrics(metrics);
      }
      models[model] = { capabilities };
    }
    scope.providers[provider] = { models };
  }
  return scope;
}

function parseState(raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.schemaVersion !== SCHEMA_VERSION || !parsed.months || typeof parsed.months !== 'object') {
    throw new TypeError('AI usage ledger schema is invalid');
  }
  const state = emptyState();
  state.lifetime = assertScope(parsed.lifetime);
  state.lastUsedAt = parsed.lastUsedAt == null ? null : finiteCount(parsed.lastUsedAt);
  for (const [month, scope] of Object.entries(parsed.months)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('AI usage month is invalid');
    state.months[month] = assertScope(scope);
  }
  return state;
}

function addMetrics(metrics, { outcome, tokens, timestamp }) {
  metrics.attempts += 1;
  if (outcome === 'succeeded') metrics.succeeded += 1;
  else metrics.failed += 1;
  if (tokens.measured) metrics.measured += 1;
  else metrics.unmeasured += 1;
  for (const key of [
    'inputTokens', 'outputTokens', 'reasoningTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'totalTokens',
  ]) metrics[key] += tokens[key];
  metrics.lastUsedAt = timestamp;
}

function leafFor(scope, provider, model, capability) {
  scope.providers[provider] ||= { models: {} };
  scope.providers[provider].models[model] ||= { capabilities: {} };
  scope.providers[provider].models[model].capabilities[capability] ||= emptyMetrics();
  return scope.providers[provider].models[model].capabilities[capability];
}

function createAiUsageLedger({
  filePath,
  fileSystem = fs,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  writeDelayMs = DEFAULT_WRITE_DELAY_MS,
  historyMonths = DEFAULT_HISTORY_MONTHS,
  randomUUID = crypto.randomUUID,
  onError = () => {},
} = {}) {
  if (!filePath) throw new TypeError('AI usage ledger requires a file path');
  let state = emptyState();
  let storageStatus = 'available';
  let timer = null;
  let dirty = false;
  let disposed = false;

  function report(error) {
    try { onError(error); } catch {}
  }

  function load() {
    try {
      if (!fileSystem.existsSync(filePath)) return;
      state = parseState(fileSystem.readFileSync(filePath, 'utf8'));
    } catch (error) {
      storageStatus = 'recovered';
      report(error);
      try {
        const corruptPath = `${filePath}.corrupt`;
        if (fileSystem.existsSync(corruptPath)) fileSystem.unlinkSync(corruptPath);
        fileSystem.renameSync(filePath, corruptPath);
      } catch (recoveryError) {
        storageStatus = 'unavailable';
        report(recoveryError);
      }
      state = emptyState();
    }
  }

  function atomicWrite() {
    const directory = path.dirname(filePath);
    const tempPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let descriptor;
    let temporaryCreated = false;
    try {
      descriptor = fileSystem.openSync(tempPath, 'wx', 0o600);
      temporaryCreated = true;
      fileSystem.writeFileSync(descriptor, JSON.stringify(state));
      fileSystem.fsyncSync?.(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      fileSystem.renameSync(tempPath, filePath);
      fileSystem.chmodSync?.(filePath, 0o600);
      try {
        const directoryDescriptor = fileSystem.openSync(directory, 'r');
        try { fileSystem.fsyncSync?.(directoryDescriptor); } finally { fileSystem.closeSync(directoryDescriptor); }
      } catch {}
    } catch (error) {
      if (descriptor !== undefined) {
        try { fileSystem.closeSync(descriptor); } catch {}
      }
      if (temporaryCreated) {
        try { fileSystem.unlinkSync(tempPath); } catch {}
      }
      throw error;
    }
  }

  function flush() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (!dirty || disposed || storageStatus === 'unavailable') return { ok: storageStatus !== 'unavailable' };
    try {
      atomicWrite();
      dirty = false;
      return { ok: true };
    } catch (error) {
      storageStatus = 'unavailable';
      report(error);
      return { ok: false, reason: 'usage-storage-unavailable' };
    }
  }

  function scheduleFlush() {
    if (timer || disposed || storageStatus === 'unavailable') return;
    timer = setTimer(() => {
      timer = null;
      flush();
    }, Math.max(0, finiteCount(writeDelayMs)));
    timer?.unref?.();
  }

  function pruneMonths() {
    const months = Object.keys(state.months).sort();
    const keep = Math.max(1, finiteCount(historyMonths) || DEFAULT_HISTORY_MONTHS);
    for (const month of months.slice(0, Math.max(0, months.length - keep))) delete state.months[month];
  }

  function record({ provider, model, capability, outcome = 'succeeded', usage, usageFormat = 'ai-sdk' } = {}) {
    if (disposed) return { ok: false, reason: 'usage-ledger-disposed' };
    const timestamp = finiteCount(now());
    const providerId = safeIdentity(provider, 'unknown');
    const modelId = safeIdentity(model, 'unknown');
    const capabilityId = safeIdentity(capability, 'unknown');
    const result = outcome === 'succeeded' ? 'succeeded' : 'failed';
    const tokens = normalizeUsage(usage, usageFormat);
    const month = monthKey(timestamp);
    state.months[month] ||= emptyScope();
    for (const scope of [state.lifetime, state.months[month]]) {
      addMetrics(scope.totals, { outcome: result, tokens, timestamp });
      addMetrics(leafFor(scope, providerId, modelId, capabilityId), { outcome: result, tokens, timestamp });
    }
    state.lastUsedAt = timestamp;
    pruneMonths();
    dirty = true;
    scheduleFlush();
    return { ok: true, measured: tokens.measured };
  }

  function snapshot() {
    const month = monthKey(now());
    return JSON.parse(JSON.stringify({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      storageStatus,
      month,
      currentMonth: state.months[month] || emptyScope(),
      lifetime: state.lifetime,
      lastUsedAt: state.lastUsedAt,
    }));
  }

  function dispose() {
    const result = flush();
    disposed = true;
    return result;
  }

  load();
  return { record, snapshot, flush, dispose };
}

module.exports = {
  SCHEMA_VERSION,
  createAiUsageLedger,
  emptyMetrics,
  normalizeUsage,
};
