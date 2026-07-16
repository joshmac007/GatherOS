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
  createVideoAnalysisService,
  validateVideoTagSuggestions,
  videoSuggestionPrompt,
} = require('../src/main/video-analysis');

function saveFixture(overrides = {}) {
  return {
    id: 'video-save',
    kind: 'video',
    file_path: '/tmp/video-save.mp4',
    content_hash: 'content-hash-a',
    title: 'Patio build',
    source_url: 'https://example.com/projects/patio',
    notes: 'Wood slat privacy wall',
    tweet_meta: JSON.stringify({ caption: 'Weekend patio renovation' }),
    ...overrides,
  };
}

function fingerprintForSave(save) {
  return buildVideoAnalysisFingerprint({
    contentIdentity: `sha256:${save.content_hash}`,
    context: buildCanonicalVideoContext({ save }),
    promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
  });
}

test('video suggestion prompt is provider-neutral structured output', () => {
  const prompt = videoSuggestionPrompt({ evidenceMode: 'poster', context: { acceptedTags: [] } });
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.input, 'string');
  assert.equal(prompt.maxOutputTokens > 0, true);
  assert.match(prompt.system, /Return JSON only/);
  assert.doesNotMatch(JSON.stringify(prompt), /Codex|Ollama|OpenAI/i);
});

test('validator keeps only safe high-confidence visual tags', () => {
  const suggestions = validateVideoTagSuggestions({
    tags: [
      { name: 'Patio renovation', confidence: 'high', evidence: ['visual'] },
      { name: 'existing tag', confidence: 'high', evidence: ['visual'] },
      { name: 'text only', confidence: 'high', evidence: ['post_context'] },
      { name: 'video', confidence: 'high', evidence: ['visual'] },
      { name: 'cedar wall', confidence: 'medium', evidence: ['visual'] },
    ],
    warnings: [],
  }, { acceptedTags: ['Existing Tag'] });

  assert.deepEqual(suggestions, [
    { name: 'patio renovation', confidence: 'high', evidence: ['visual'] },
  ]);
});

test('poster analysis calls structured provider once and persists validated suggestions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-provider-'));
  try {
    const posterPath = path.join(directory, 'poster.jpg');
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#8a6547' },
    }).jpeg().toFile(posterPath);
    const save = saveFixture({ thumb_path: posterPath });
    const fingerprint = fingerprintForSave(save);
    const completions = [];
    const requests = [];
    const service = createVideoAnalysisService({
      repository: {
        completeVideoAnalysis(payload) { completions.push(payload); },
      },
      frameExtractor: { async extract() { throw new Error('decode unavailable'); } },
      structuredProvider: {
        async completeJson(request) {
          requests.push(request);
          return {
            tags: [{ name: 'Patio renovation', confidence: 'high', evidence: ['visual'] }],
            warnings: [],
          };
        },
      },
      derivedDir: directory,
      now: () => 500,
    });

    const result = await service.run({
      job: { id: 'job-a', fingerprint, prompt_version: VIDEO_ANALYSIS_PROMPT_VERSION },
      save,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].imagePath, posterPath);
    assert.equal(JSON.parse(requests[0].input).evidenceMode, 'poster');
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.suggestions, [{
      name: 'patio renovation', confidence: 'high', evidence: ['visual', 'poster'],
    }]);
    assert.deepEqual(completions, [{
      id: 'job-a',
      fingerprint,
      suggestions: result.suggestions,
      unavailable: false,
      now: 500,
    }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('structured provider failure maps to retryable provider-neutral video error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-video-provider-error-'));
  try {
    const posterPath = path.join(directory, 'poster.jpg');
    fs.writeFileSync(posterPath, Buffer.from('poster'));
    const save = saveFixture({ thumb_path: posterPath });
    const service = createVideoAnalysisService({
      repository: {},
      frameExtractor: { async extract() { throw new Error('decode unavailable'); } },
      structuredProvider: {
        async completeJson() {
          const error = new Error('provider offline');
          error.code = 'AI_PROVIDER_UNAVAILABLE';
          error.retryable = true;
          throw error;
        },
      },
      derivedDir: directory,
    });

    await assert.rejects(
      service.run({
        job: { id: 'job-b', fingerprint: fingerprintForSave(save), prompt_version: 1 },
        save,
      }),
      (error) => {
        assert.equal(error.code, 'video_analysis_unavailable');
        assert.equal(error.providerCode, 'AI_PROVIDER_UNAVAILABLE');
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.name, /Codex|Ollama|OpenAI/i);
        return true;
      },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('non-retryable structured provider failure stays non-retryable', async () => {
  const save = saveFixture({ thumb_path: '/tmp/poster.jpg' });
  const service = createVideoAnalysisService({
    repository: {},
    frameExtractor: { async extract() { throw new Error('decode unavailable'); } },
    structuredProvider: {
      async completeJson() {
        const error = new Error('provider is not configured');
        error.code = 'AI_CAPABILITY_UNCONFIGURED';
        error.retryable = false;
        throw error;
      },
    },
    exists: () => true,
  });

  await assert.rejects(
    service.run({
      job: { id: 'job-auth', fingerprint: fingerprintForSave(save), prompt_version: 1 },
      save,
    }),
    (error) => {
      assert.equal(error.code, 'video_analysis_unavailable');
      assert.equal(error.providerCode, 'AI_CAPABILITY_UNCONFIGURED');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('missing visual evidence completes as unavailable without provider call', async () => {
  const save = saveFixture({ thumb_path: null });
  let calls = 0;
  const completions = [];
  const service = createVideoAnalysisService({
    repository: { completeVideoAnalysis(payload) { completions.push(payload); } },
    frameExtractor: { async extract() { return { frames: [] }; } },
    structuredProvider: { async completeJson() { calls += 1; } },
    exists: () => false,
    now: () => 900,
  });

  const result = await service.run({
    job: { id: 'job-c', fingerprint: fingerprintForSave(save), prompt_version: 1 },
    save,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, 'unavailable');
  assert.equal(completions[0].unavailable, true);
});
