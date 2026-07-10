const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  VIDEO_ANALYSIS_PROMPT_VERSION,
  buildCanonicalVideoContext,
  buildVideoAnalysisFingerprint,
  cleanupDerivedVideoCache,
  createVideoAnalysisService,
  validateVideoTagSuggestions,
} = require('../src/main/video-analysis');

function saveFixture(overrides = {}) {
  return {
    id: 'video-save',
    kind: 'video',
    file_path: '/tmp/video-save.mp4',
    thumb_path: '/tmp/video-save-poster.jpg',
    content_hash: 'content-hash-a',
    title: 'Patio build',
    source_url: 'https://example.com/projects/patio',
    notes: 'Wood slat privacy wall',
    tweet_meta: JSON.stringify({ caption: 'Weekend patio renovation', quoted: { caption: '' } }),
    ...overrides,
  };
}

test('canonical context and fingerprint are stable across whitespace and tag order', () => {
  const firstContext = buildCanonicalVideoContext({
    save: saveFixture(),
    acceptedTags: [' Outdoor Living ', { name: 'woodworking' }],
  });
  const secondContext = buildCanonicalVideoContext({
    save: saveFixture({ notes: ' Wood   slat\nprivacy wall ' }),
    acceptedTags: [{ name: 'WOODWORKING' }, 'outdoor living'],
  });
  const first = buildVideoAnalysisFingerprint({
    contentIdentity: 'sha256:content-hash-a',
    context: firstContext,
    promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  });
  const second = buildVideoAnalysisFingerprint({
    contentIdentity: 'sha256:content-hash-a',
    context: secondContext,
    promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  });

  assert.deepEqual(firstContext, secondContext);
  assert.equal(first, second);
  assert.notEqual(first, buildVideoAnalysisFingerprint({
    contentIdentity: 'sha256:changed', context: firstContext, promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  }));
  assert.notEqual(first, buildVideoAnalysisFingerprint({
    contentIdentity: 'sha256:content-hash-a', context: { ...firstContext, notes: 'Changed' }, promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  }));
  assert.notEqual(first, buildVideoAnalysisFingerprint({
    contentIdentity: 'sha256:content-hash-a', context: firstContext, promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION + 1,
  }));
});

test('validator keeps unique high-confidence visual tags and filters unsafe suggestions', () => {
  const suggestions = validateVideoTagSuggestions({
    tags: [
      { name: ' Patio   Renovation ', confidence: 'high', evidence: ['visual'] },
      { name: '#patio renovation', confidence: 'high', evidence: ['visual', 'post_context'] },
      { name: 'woodworking', confidence: 'medium', evidence: ['visual'] },
      { name: 'existing tag', confidence: 'high', evidence: ['visual'] },
      { name: 'text only', confidence: 'high', evidence: ['post_context'] },
      { name: 'video', confidence: 'high', evidence: ['visual'] },
      { name: 'conflicted subject', confidence: 'high', evidence: ['visual', 'post_context'], conflict: true },
      { name: 'warning conflict', confidence: 'high', evidence: ['visual', 'conflict'] },
      { name: 'cedar privacy wall', confidence: 'high', evidence: ['visual'] },
    ],
  }, { acceptedTags: ['Existing Tag'] });

  assert.deepEqual(suggestions, [
    { name: 'patio renovation', confidence: 'high', evidence: ['visual'] },
    { name: 'cedar privacy wall', confidence: 'high', evidence: ['visual'] },
  ]);
  assert.equal(suggestions.every((suggestion) => !('tagMutation' in suggestion)), true);
});

test('prepare skips unchanged completed fingerprint without provider work', async () => {
  let enqueues = 0;
  let providerCalls = 0;
  const save = saveFixture();
  const context = buildCanonicalVideoContext({ save, acceptedTags: [] });
  const fingerprint = buildVideoAnalysisFingerprint({
    contentIdentity: 'sha256:content-hash-a',
    context,
    promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  });
  const service = createVideoAnalysisService({
    repository: {
      getVideoAnalysis: () => ({ id: 'existing', fingerprint, state: 'completed' }),
      enqueueVideoAnalysis: () => { enqueues += 1; },
    },
    frameExtractor: { async extract() { throw new Error('must not extract'); } },
    codex: { async generateVideoTagSuggestions() { providerCalls += 1; } },
  });

  const result = await service.prepare({ save });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.fingerprint, fingerprint);
  assert.equal(enqueues, 0);
  assert.equal(providerCalls, 0);
});

test('prepare enqueues changed fingerprint and invokes derived-cache cleanup seam', async () => {
  const calls = [];
  const service = createVideoAnalysisService({
    repository: {
      getVideoAnalysis: () => ({ id: 'old', fingerprint: 'old-fingerprint', state: 'completed' }),
      enqueueVideoAnalysis(payload) {
        calls.push(['enqueue', payload]);
        return { id: 'new-job', fingerprint: payload.fingerprint, prompt_version: payload.promptVersion, state: 'pending' };
      },
    },
    cleanupDerived: async (payload) => calls.push(['cleanup', payload]),
  });

  const result = await service.prepare({ save: saveFixture(), now: 123 });

  assert.equal(result.status, 'queued');
  assert.equal(result.job.id, 'new-job');
  assert.equal(calls[0][0], 'enqueue');
  assert.deepEqual(calls[1], ['cleanup', {
    saveId: 'video-save',
    keepFingerprints: [result.fingerprint],
  }]);
});

test('frames compose one cached contact sheet and make exactly one Codex call', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-analysis-'));
  try {
    const frame = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#9b6a45' },
    }).jpeg().toBuffer();
    let providerCalls = 0;
    const completions = [];
    const service = createVideoAnalysisService({
      repository: {
        completeVideoAnalysis(payload) { completions.push(payload); return { ok: true }; },
      },
      frameExtractor: {
        async extract() {
          return { duration: 30, timestamps: [5, 10, 15, 20, 25, 27], frames: Array(6).fill(frame) };
        },
      },
      codex: {
        async generateVideoTagSuggestions(input, options) {
          providerCalls += 1;
          assert.equal(input.duration, 30);
          assert.deepEqual(input.timestamps, [5, 10, 15, 20, 25, 27]);
          assert.equal(input.evidenceMode, 'frames');
          assert.equal(options.imagePath, path.join(directory, 'video-save', 'fingerprint-a.jpg'));
          assert.equal(fs.existsSync(options.imagePath), true);
          return { tags: [{ name: 'Patio renovation', confidence: 'high', evidence: ['visual'] }] };
        },
      },
      derivedDir: directory,
      now: () => 500,
    });

    const result = await service.run({
      job: { id: 'job-a', fingerprint: 'fingerprint-a', prompt_version: VIDEO_ANALYSIS_PROMPT_VERSION },
      save: saveFixture(),
    });

    assert.equal(result.status, 'completed');
    assert.equal(providerCalls, 1);
    assert.equal(result.contactSheetPath, path.join(directory, 'video-save', 'fingerprint-a.jpg'));
    assert.deepEqual(completions, [{
      id: 'job-a',
      fingerprint: 'fingerprint-a',
      suggestions: [{ name: 'patio renovation', confidence: 'high', evidence: ['visual'] }],
      unavailable: false,
      now: 500,
    }]);
    const metadata = await sharp(result.contactSheetPath).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width > 40, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('frame failure uses poster once and marks poster evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-poster-'));
  const posterPath = path.join(directory, 'poster.jpg');
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#456789' } }).jpeg().toFile(posterPath);
  try {
    let providerCalls = 0;
    let completion = null;
    const service = createVideoAnalysisService({
      repository: { completeVideoAnalysis(payload) { completion = payload; return { ok: true }; } },
      frameExtractor: { async extract() { throw new Error('unsupported codec'); } },
      codex: {
        async generateVideoTagSuggestions(input, options) {
          providerCalls += 1;
          assert.equal(input.evidenceMode, 'poster');
          assert.equal(options.imagePath, posterPath);
          return { tags: [{ name: 'outdoor living', confidence: 'high', evidence: ['visual'] }] };
        },
      },
      derivedDir: directory,
      now: () => 600,
    });

    const result = await service.run({
      job: { id: 'job-poster', fingerprint: 'fingerprint-poster', prompt_version: 1 },
      save: saveFixture({ thumb_path: posterPath }),
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.evidenceMode, 'poster');
    assert.equal(providerCalls, 1);
    assert.deepEqual(completion.suggestions, [{
      name: 'outdoor living', confidence: 'high', evidence: ['visual', 'poster'],
    }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('no usable frame or poster persists unavailable with zero provider calls', async () => {
  let providerCalls = 0;
  let completion = null;
  const service = createVideoAnalysisService({
    repository: { completeVideoAnalysis(payload) { completion = payload; return { ok: true }; } },
    frameExtractor: { async extract() { throw new Error('decode failed'); } },
    codex: { async generateVideoTagSuggestions() { providerCalls += 1; } },
    exists: () => false,
    now: () => 700,
  });

  const result = await service.run({
    job: { id: 'job-unavailable', fingerprint: 'fingerprint-unavailable', prompt_version: 1 },
    save: saveFixture({ thumb_path: '/tmp/missing-poster.jpg' }),
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(providerCalls, 0);
  assert.deepEqual(completion, {
    id: 'job-unavailable',
    fingerprint: 'fingerprint-unavailable',
    suggestions: [],
    unavailable: true,
    now: 700,
  });
});

test('derived cache cleanup removes only one save superseded JPEGs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-cache-'));
  try {
    const targetDirectory = path.join(directory, 'save-a');
    const otherDirectory = path.join(directory, 'save-b');
    fs.mkdirSync(targetDirectory);
    fs.mkdirSync(otherDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'keep.jpg'), 'keep');
    fs.writeFileSync(path.join(targetDirectory, 'old.jpg'), 'old');
    fs.writeFileSync(path.join(targetDirectory, 'unrelated.txt'), 'unrelated');
    fs.writeFileSync(path.join(otherDirectory, 'other.jpg'), 'other');

    const removed = await cleanupDerivedVideoCache({
      directory,
      saveId: 'save-a',
      keepFingerprints: ['keep'],
    });

    assert.deepEqual(removed, [path.join(targetDirectory, 'old.jpg')]);
    assert.equal(fs.existsSync(path.join(targetDirectory, 'keep.jpg')), true);
    assert.equal(fs.existsSync(path.join(targetDirectory, 'unrelated.txt')), true);
    assert.equal(fs.existsSync(path.join(otherDirectory, 'other.jpg')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
