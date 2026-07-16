'use strict';

const crypto = require('node:crypto');

function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedList(values, { lowercase = false } = {}) {
  if (!Array.isArray(values)) return [];
  const byKey = new Map();
  for (const value of values) {
    const raw = value && typeof value === 'object' ? value.name : value;
    const normalized = normalizeText(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    const candidate = lowercase ? key : normalized;
    if (!byKey.has(key) || candidate < byKey.get(key)) byKey.set(key, candidate);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function buildSemanticSource({ save = {}, tags = [], topicProfile = {} } = {}) {
  const tweetMeta = parseObject(save.tweet_meta ?? save.tweetMeta);
  const quoted = parseObject(tweetMeta.quoted);
  const fields = [
    ['Title', normalizeText(save.title)],
    ['Description', normalizeText(save.ai_description) || normalizeText(save.description)],
    ['Notes', normalizeText(save.notes)],
    ['Tweet', normalizeText(tweetMeta.caption) || normalizeText(tweetMeta.text)],
    ['Quoted tweet', normalizeText(quoted.caption) || normalizeText(quoted.text)],
    ['Tags', normalizedList(tags, { lowercase: true }).join(', ')],
    ['OCR', normalizeText(save.ocr_text ?? save.ocrText)],
    ['Concepts', normalizedList(topicProfile.concepts).join(', ')],
    ['Topic summary', normalizeText(topicProfile.summary)],
  ];
  const text = fields.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
  return { text, sourceHash: crypto.createHash('sha256').update(text).digest('hex') };
}

module.exports = { buildSemanticSource, normalizeText };
