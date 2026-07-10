const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildSemanticSource } = require('../src/main/semantic-source');

function fixture(overrides = {}) {
  return {
    save: {
      title: '  Dark   aviation dashboard  ',
      ai_description: ' High-contrast\nflight operations UI. ',
      notes: '  Revisit   dense table layout. ',
      tweet_meta: JSON.stringify({
        caption: '  Strong   dispatch workflow ',
        quoted: { caption: ' Keep critical alerts visible. ' },
      }),
      ocr_text: '  ETA   14:35\nGate C12 ',
    },
    tags: [{ name: 'Operations' }, { name: ' aviation ' }, { name: 'operations' }],
    topicProfile: {
      concepts: [' flight planning ', 'Aviation UI', 'flight planning'],
      summary: '  Reference for   airline disruption control. ',
    },
    ...overrides,
  };
}

test('builds deterministic normalized labeled semantic text and SHA-256 hash', () => {
  const first = buildSemanticSource(fixture());
  const second = buildSemanticSource(fixture({
    tags: [{ name: 'operations' }, { name: 'aviation' }],
    topicProfile: {
      concepts: ['Aviation UI', 'flight planning'],
      summary: 'Reference for airline disruption control.',
    },
  }));

  assert.equal(first.text, [
    'Title: Dark aviation dashboard',
    'Description: High-contrast flight operations UI.',
    'Notes: Revisit dense table layout.',
    'Tweet: Strong dispatch workflow',
    'Quoted tweet: Keep critical alerts visible.',
    'Tags: aviation, operations',
    'OCR: ETA 14:35 Gate C12',
    'Concepts: Aviation UI, flight planning',
    'Topic summary: Reference for airline disruption control.',
  ].join('\n'));
  assert.equal(first.sourceHash, crypto.createHash('sha256').update(first.text).digest('hex'));
  assert.deepEqual(first, second);
});

test('supports object tweet metadata and description field', () => {
  const result = buildSemanticSource({
    save: {
      description: 'A product research article.',
      tweet_meta: { text: 'Source post text', quoted: { text: 'Quoted source text' } },
    },
  });

  assert.equal(result.text, [
    'Description: A product research article.',
    'Tweet: Source post text',
    'Quoted tweet: Quoted source text',
  ].join('\n'));
});

test('ignores video suggestions, contact sheets, confidence, and evidence fields', () => {
  const baseline = buildSemanticSource(fixture());
  const withExcludedEvidence = buildSemanticSource({
    ...fixture(),
    videoSuggestion: { tag: 'cockpit', confidence: 0.99, evidence: 'frame 3' },
    contactSheet: '/tmp/contact-sheet.jpg',
    evidence: ['raw frame evidence'],
    save: {
      ...fixture().save,
      video_suggestion: { tag: 'cockpit' },
      contact_sheet_path: '/tmp/contact-sheet.jpg',
      suggestion_evidence: 'frame 3',
      suggestion_confidence: 0.99,
    },
  });

  assert.deepEqual(withExcludedEvidence, baseline);
  assert.doesNotMatch(withExcludedEvidence.text, /cockpit|contact|frame 3|0\.99/);
});

test('accepted ordinary tag changes source hash', () => {
  const before = buildSemanticSource(fixture());
  const after = buildSemanticSource({
    ...fixture(),
    tags: [...fixture().tags, { name: 'cockpit' }],
  });

  assert.notEqual(after.sourceHash, before.sourceHash);
  assert.match(after.text, /Tags: aviation, cockpit, operations/);
});

test('case-variant concepts produce same canonical text regardless of input order', () => {
  const first = buildSemanticSource({
    topicProfile: { concepts: ['Aviation UI', 'aviation ui'] },
  });
  const reversed = buildSemanticSource({
    topicProfile: { concepts: ['aviation ui', 'Aviation UI'] },
  });

  assert.deepEqual(first, reversed);
});

test('Unicode composed and decomposed source strings produce the same hash', () => {
  const composed = buildSemanticSource({ save: { title: 'Caf\u00e9 inspiration' } });
  const decomposed = buildSemanticSource({ save: { title: 'Cafe\u0301 inspiration' } });

  assert.deepEqual(composed, decomposed);
});
