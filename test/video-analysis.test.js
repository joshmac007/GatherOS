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
  resolveDerivedCacheDirectory,
  resolveDerivedCachePath,
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

function fingerprintForSave(save, sourceContext = {}) {
  return buildVideoAnalysisFingerprint({
    contentIdentity: `sha256:${save.content_hash}`,
    context: buildCanonicalVideoContext({ save, sourceContext }),
    promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  });
}

test('canonical context and fingerprint are stable across whitespace and tag order', () => {
  const firstContext = buildCanonicalVideoContext({
    save: saveFixture(),
    acceptedTags: [' Outdoor Living ', { name: 'woodworking' }],
  });
  const secondContext = buildCanonicalVideoContext({
    save: saveFixture({ notes: ' Wood   slat\nprivacy wall ' }),
    acceptedTags: [{ name: 'completely different accepted tag' }],
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
  assert.equal('acceptedTags' in firstContext, false);
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
      { name: 'cedar privacy wall', confidence: 'high', evidence: ['visual'] },
    ],
    warnings: [],
  }, { acceptedTags: ['Existing Tag'] });

  assert.deepEqual(suggestions, [
    { name: 'patio renovation', confidence: 'high', evidence: ['visual'] },
    { name: 'cedar privacy wall', confidence: 'high', evidence: ['visual'] },
  ]);
  assert.equal(suggestions.every((suggestion) => !('tagMutation' in suggestion)), true);
});

test('validator filters generic, conflicting, reserved, punctuation, and control tag names', () => {
  const suggestions = validateVideoTagSuggestions({
    tags: [
      { name: 'video', confidence: 'high', evidence: ['visual'] },
      { name: 'conflicted subject', confidence: 'high', evidence: ['visual'], conflict: true },
      { name: '__proto__', confidence: 'high', evidence: ['visual'] },
      { name: 'constructor', confidence: 'high', evidence: ['visual'] },
      { name: '!!!', confidence: 'high', evidence: ['visual'] },
      { name: 'control\u0000tag', confidence: 'high', evidence: ['visual'] },
    ],
    warnings: [],
  });
  assert.deepEqual(suggestions, []);
});

test('strict validator rejects malformed typed output with retryable inspectable errors', () => {
  const invalid = [
    [null, 'top_level'],
    [[], 'top_level'],
    [{ tags: [], warnings: 'none' }, 'warnings'],
    [{ tags: 'none', warnings: [] }, 'tags'],
    [{ tags: Array(7).fill({ name: 'cedar wall', confidence: 'high', evidence: ['visual'] }), warnings: [] }, 'tags'],
    [{ tags: [{ name: 'cedar wall', confidence: 'high', evidence: ['visual', 'filesystem'] }], warnings: [] }, 'evidence'],
    [{ tags: [{ name: 42, confidence: 'high', evidence: ['visual'] }], warnings: [] }, 'name'],
  ];
  for (const [value, field] of invalid) {
    assert.throws(() => validateVideoTagSuggestions(value), (error) => {
      assert.equal(error.code, 'invalid_video_suggestions');
      assert.equal(error.retryable, true);
      assert.equal(error.details.field, field);
      assert.equal(typeof error.details.reason, 'string');
      return true;
    });
  }
});

test('validator returns at most six valid normalized suggestions', () => {
  const result = validateVideoTagSuggestions({
    tags: [
      'cedar wall', 'patio build', 'outdoor kitchen', 'deck framing', 'privacy screen', 'stone pavers',
    ].map((name) => ({ name, confidence: 'high', evidence: ['visual'] })),
    warnings: [],
  });
  assert.equal(result.length, 6);
});

test('derived cache paths remain below root for traversal and Unicode save ids', () => {
  const root = path.resolve('/tmp/gatherlocal-derived-root');
  const ids = ['.', '..', 'nested/save', 'caf\u00e9', 'cafe\u0301'];
  const directories = ids.map((saveId) => resolveDerivedCacheDirectory(root, saveId));
  for (const directory of directories) {
    assert.equal(path.dirname(directory), root);
    assert.notEqual(path.basename(directory), '.');
    assert.notEqual(path.basename(directory), '..');
  }
  assert.equal(new Set(directories).size, ids.length);
  const artifact = resolveDerivedCachePath(root, '..', 'a'.repeat(64));
  assert.equal(path.dirname(path.dirname(artifact)), root);
  assert.equal(path.basename(artifact), `${'a'.repeat(64)}.jpg`);
  assert.throws(() => resolveDerivedCachePath(root, 'safe', '../escape'), /fingerprint/i);
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
    const expectedFingerprint = fingerprintForSave(saveFixture());
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
          assert.deepEqual(input.context.acceptedTags, ['woodworking']);
          assert.equal(options.imagePath, resolveDerivedCachePath(directory, 'video-save', expectedFingerprint));
          assert.equal(fs.existsSync(options.imagePath), true);
          return { tags: [{ name: 'Patio renovation', confidence: 'high', evidence: ['visual'] }], warnings: [] };
        },
      },
      derivedDir: directory,
      now: () => 500,
    });

    const result = await service.run({
      job: {
        id: 'job-a',
        fingerprint: expectedFingerprint,
        prompt_version: VIDEO_ANALYSIS_PROMPT_VERSION,
      },
      save: saveFixture(),
      acceptedTags: ['woodworking'],
    });

    assert.equal(result.status, 'completed');
    assert.equal(providerCalls, 1);
    assert.equal(result.contactSheetPath, resolveDerivedCachePath(directory, 'video-save', result.fingerprint));
    assert.deepEqual(completions, [{
      id: 'job-a',
      fingerprint: expectedFingerprint,
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
          return { tags: [{ name: 'outdoor living', confidence: 'high', evidence: ['visual'] }], warnings: [] };
        },
      },
      derivedDir: directory,
      now: () => 600,
    });

    const result = await service.run({
      job: {
        id: 'job-poster',
        fingerprint: fingerprintForSave(saveFixture({ thumb_path: posterPath })),
        prompt_version: 1,
      },
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
    job: { id: 'job-unavailable', fingerprint: fingerprintForSave(saveFixture()), prompt_version: 1 },
    save: saveFixture({ thumb_path: '/tmp/missing-poster.jpg' }),
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(providerCalls, 0);
  assert.deepEqual(completion, {
    id: 'job-unavailable',
    fingerprint: fingerprintForSave(saveFixture()),
    suggestions: [],
    unavailable: true,
    now: 700,
  });
});

test('run rejects jobs whose media identity or source context changed before provider work', async () => {
  const original = saveFixture();
  const originalFingerprint = fingerprintForSave(original);
  for (const current of [
    saveFixture({ content_hash: 'content-hash-b' }),
    saveFixture({ notes: 'Context changed after the job was queued' }),
  ]) {
    let extractions = 0;
    let providerCalls = 0;
    let completions = 0;
    const service = createVideoAnalysisService({
      repository: {
        completeVideoAnalysis() { completions += 1; },
      },
      frameExtractor: {
        async extract() { extractions += 1; throw new Error('must not extract stale job'); },
      },
      codex: {
        async generateVideoTagSuggestions() { providerCalls += 1; },
      },
      exists: () => false,
    });

    const result = await service.run({
      job: { id: 'stale-job', fingerprint: originalFingerprint, prompt_version: 1 },
      save: current,
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.reason, 'fingerprint_changed');
    assert.equal(result.jobFingerprint, originalFingerprint);
    assert.equal(result.fingerprint, fingerprintForSave(current));
    assert.equal(extractions, 0);
    assert.equal(providerCalls, 0);
    assert.equal(completions, 0);
  }
});

test('derived cache cleanup removes only one save superseded JPEGs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-cache-'));
  try {
    const targetDirectory = resolveDerivedCacheDirectory(directory, 'save-a');
    const otherDirectory = resolveDerivedCacheDirectory(directory, 'save-b');
    fs.mkdirSync(targetDirectory);
    fs.mkdirSync(otherDirectory);
    const keepFingerprint = 'a'.repeat(64);
    const oldFingerprint = 'b'.repeat(64);
    fs.writeFileSync(path.join(targetDirectory, `${keepFingerprint}.jpg`), 'keep');
    fs.writeFileSync(path.join(targetDirectory, `${oldFingerprint}.jpg`), 'old');
    fs.writeFileSync(path.join(targetDirectory, 'unrelated.txt'), 'unrelated');
    fs.writeFileSync(path.join(otherDirectory, 'other.jpg'), 'other');

    const removed = await cleanupDerivedVideoCache({
      directory,
      saveId: 'save-a',
      keepFingerprints: [keepFingerprint],
    });

    assert.deepEqual(removed, [path.join(targetDirectory, `${oldFingerprint}.jpg`)]);
    assert.equal(fs.existsSync(path.join(targetDirectory, `${keepFingerprint}.jpg`)), true);
    assert.equal(fs.existsSync(path.join(targetDirectory, 'unrelated.txt')), true);
    assert.equal(fs.existsSync(path.join(otherDirectory, 'other.jpg')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('corrupt cached contact sheet is rebuilt atomically before Codex sees it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-corrupt-cache-'));
  try {
    const save = saveFixture();
    const fingerprint = fingerprintForSave(save);
    const cachePath = resolveDerivedCachePath(directory, save.id, fingerprint);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, 'corrupt jpeg');
    const frame = await sharp({
      create: { width: 48, height: 27, channels: 3, background: '#338855' },
    }).jpeg().toBuffer();
    let extractions = 0;
    const service = createVideoAnalysisService({
      repository: { completeVideoAnalysis() { return { ok: true }; } },
      frameExtractor: {
        async extract() {
          extractions += 1;
          return { duration: 6, timestamps: [1, 2, 3, 4, 5, 5.5], frames: Array(6).fill(frame) };
        },
      },
      codex: {
        async generateVideoTagSuggestions(input, { imagePath }) {
          const metadata = await sharp(imagePath).metadata();
          assert.equal(metadata.format, 'jpeg');
          return { tags: [], warnings: [] };
        },
      },
      derivedDir: directory,
    });

    const result = await service.run({
      job: { id: 'corrupt-cache-job', fingerprint, prompt_version: 1 },
      save,
    });

    assert.equal(result.status, 'completed');
    assert.equal(extractions, 1);
    assert.equal((await sharp(cachePath).metadata()).format, 'jpeg');
    assert.deepEqual(fs.readdirSync(path.dirname(cachePath)).filter((name) => name.includes('.tmp-')), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed provider output remains retryable and never persists completion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-invalid-output-'));
  const posterPath = path.join(directory, 'poster.jpg');
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#333333' } }).jpeg().toFile(posterPath);
  try {
    let completions = 0;
    const save = saveFixture({ thumb_path: posterPath });
    const service = createVideoAnalysisService({
      repository: { completeVideoAnalysis() { completions += 1; } },
      frameExtractor: { async extract() { throw new Error('poster fallback'); } },
      codex: { async generateVideoTagSuggestions() { return { tags: 'bad', warnings: [] }; } },
      derivedDir: directory,
    });

    await assert.rejects(service.run({
      job: { id: 'invalid-output-job', fingerprint: fingerprintForSave(save), prompt_version: 1 },
      save,
    }), (error) => {
      assert.equal(error.code, 'invalid_video_suggestions');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { field: 'tags', reason: 'must_be_array' });
      return true;
    });
    assert.equal(completions, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
