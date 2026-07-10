const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VIDEO_ANALYSIS_PROMPT_VERSION = 1;
const GENERIC_TAGS = new Set([
  'art',
  'bookmark',
  'clip',
  'content',
  'design',
  'image',
  'inspiration',
  'media',
  'post',
  'social media',
  'video',
]);
const RESERVED_TAGS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'tostring',
  'valueof',
]);
const VIDEO_EVIDENCE = new Set(['visual', 'post_context']);

class VideoSuggestionValidationError extends Error {
  constructor(field, reason) {
    super(`Invalid video suggestion output: ${field} ${reason}`);
    this.name = 'VideoSuggestionValidationError';
    this.code = 'invalid_video_suggestions';
    this.retryable = true;
    this.details = { field, reason };
  }
}

function invalidSuggestions(field, reason) {
  throw new VideoSuggestionValidationError(field, reason);
}

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

function normalizeTagName(value) {
  const name = value && typeof value === 'object' ? value.name : value;
  return normalizeText(name).replace(/^#+/, '').toLowerCase();
}

function normalizeTagList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeTagName).filter(Boolean))].sort();
}

function sourceDomain(sourceUrl) {
  if (!sourceUrl) return '';
  try { return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function buildCanonicalVideoContext({ save = {}, sourceContext = {} } = {}) {
  const tweetMeta = parseObject(save.tweet_meta ?? save.tweetMeta);
  const quoted = parseObject(tweetMeta.quoted);
  const sourceUrl = normalizeText(
    sourceContext.sourceUrl ?? sourceContext.source_url ?? save.source_url ?? save.sourceUrl,
  );
  return {
    title: normalizeText(sourceContext.pageTitle ?? sourceContext.title ?? save.title),
    postText: normalizeText(
      sourceContext.postText ?? sourceContext.post_text ?? tweetMeta.caption ?? tweetMeta.text,
    ),
    quotedText: normalizeText(
      sourceContext.quotedText ?? sourceContext.quoted_text ?? quoted.caption ?? quoted.text,
    ),
    sourceUrl,
    sourceDomain: normalizeText(sourceContext.sourceDomain ?? sourceContext.source_domain)
      .toLowerCase() || sourceDomain(sourceUrl),
    notes: normalizeText(sourceContext.notes ?? save.notes),
  };
}

function buildVideoRequestContext({ save = {}, sourceContext = {}, acceptedTags = [] } = {}) {
  return {
    ...buildCanonicalVideoContext({ save, sourceContext }),
    acceptedTags: normalizeTagList(acceptedTags),
  };
}

function buildVideoAnalysisFingerprint({ contentIdentity, context, promptVersion } = {}) {
  if (!normalizeText(contentIdentity)) throw new Error('Video content identity is required');
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    throw new Error('Video prompt version must be a positive integer');
  }
  const payload = JSON.stringify({
    contentIdentity: normalizeText(contentIdentity),
    context: context || {},
    promptVersion,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function cacheKeyForSaveId(saveId) {
  if (saveId === undefined || saveId === null || String(saveId).length === 0) {
    throw new Error('Video cache save id is required');
  }
  return crypto.createHash('sha256').update(`save-id:${String(saveId)}`).digest('hex');
}

function resolveDerivedCacheDirectory(directory, saveId) {
  if (!directory) throw new Error('Video cache root is required');
  const root = path.resolve(directory);
  const target = path.resolve(root, cacheKeyForSaveId(saveId));
  if (path.dirname(target) !== root) throw new Error('Video cache path escaped its root');
  return target;
}

function resolveDerivedCachePath(directory, saveId, fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Video cache fingerprint must be a SHA-256 hex string');
  }
  return path.join(
    resolveDerivedCacheDirectory(directory, saveId),
    `${fingerprint.toLowerCase()}.jpg`,
  );
}

async function resolveVideoContentIdentity(save = {}, { stat = fs.promises.stat } = {}) {
  const contentHash = normalizeText(save.content_hash ?? save.contentHash);
  if (contentHash) return `sha256:${contentHash}`;
  const videoPath = save.file_path ?? save.filePath;
  if (!videoPath) throw new Error('Video path is required when content hash is unavailable');
  const metadata = await stat(videoPath);
  if (!Number.isFinite(metadata.size) || !Number.isFinite(metadata.mtimeMs)) {
    throw new Error('Video file identity is unavailable');
  }
  return `stat:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeText(item).toLowerCase()).filter(Boolean))];
}

function validateVideoTagSuggestions(result, { acceptedTags = [], evidenceMode = 'frames' } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    invalidSuggestions('top_level', 'must_be_object');
  }
  if (!Array.isArray(result.tags)) invalidSuggestions('tags', 'must_be_array');
  if (!Array.isArray(result.warnings)) invalidSuggestions('warnings', 'must_be_array');
  if (result.tags.length > 6) invalidSuggestions('tags', 'max_6');
  if (!result.warnings.every((warning) => typeof warning === 'string')) {
    invalidSuggestions('warnings', 'items_must_be_strings');
  }
  const accepted = new Set(normalizeTagList(acceptedTags));
  const seen = new Set();
  const output = [];
  for (const candidate of result.tags) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      invalidSuggestions('tags', 'items_must_be_objects');
    }
    if (typeof candidate.name !== 'string') invalidSuggestions('name', 'must_be_string');
    if (!['high', 'medium', 'low'].includes(candidate.confidence)) {
      invalidSuggestions('confidence', 'must_be_high_medium_or_low');
    }
    if (!Array.isArray(candidate.evidence)) invalidSuggestions('evidence', 'must_be_array');
    if (candidate.conflict !== undefined && typeof candidate.conflict !== 'boolean') {
      invalidSuggestions('conflict', 'must_be_boolean');
    }
    const evidence = normalizeEvidence(candidate.evidence);
    if (evidence.length !== candidate.evidence.length
      || evidence.some((item) => !VIDEO_EVIDENCE.has(item))) {
      invalidSuggestions('evidence', 'contains_unsupported_value');
    }
    const rawName = normalizeText(candidate.name).replace(/^#+/, '');
    const name = rawName.toLowerCase();
    const conflict = candidate.conflict === true;
    if (!name || name.length > 64 || name.split(' ').length > 6) continue;
    if (/[\p{Cc}\p{Cf}]/u.test(candidate.name)) continue;
    if (!/^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u.test(rawName)) continue;
    if (candidate?.confidence !== 'high') continue;
    if (!evidence.includes('visual') || conflict) continue;
    if (GENERIC_TAGS.has(name) || RESERVED_TAGS.has(name) || accepted.has(name) || seen.has(name)) continue;
    seen.add(name);
    if (evidenceMode === 'poster' && !evidence.includes('poster')) evidence.push('poster');
    output.push({ name, confidence: 'high', evidence });
  }
  return output;
}

function timestampLabel(timestamp) {
  const seconds = Math.max(0, Math.floor(Number(timestamp) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

async function composeContactSheet({
  frames,
  timestamps,
  outputPath,
  sharpFactory = require('sharp'),
} = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('Contact sheet requires frames');
  if (!Array.isArray(timestamps) || timestamps.length !== frames.length) {
    throw new Error('Contact sheet timestamps must match frames');
  }
  const columns = frames.length <= 8 ? 2 : 3;
  const cellWidth = 320;
  const imageHeight = 180;
  const labelHeight = 28;
  const cellHeight = imageHeight + labelHeight;
  const rows = Math.ceil(frames.length / columns);
  const composites = [];
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );

  for (let index = 0; index < frames.length; index += 1) {
    const left = (index % columns) * cellWidth;
    const top = Math.floor(index / columns) * cellHeight;
    const frame = await sharpFactory(frames[index])
      .rotate()
      .resize(cellWidth, imageHeight, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 84 })
      .toBuffer();
    const label = timestampLabel(timestamps[index]);
    const svg = Buffer.from(
      `<svg width="${cellWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">`
      + '<rect width="100%" height="100%" fill="#111827"/>'
      + `<text x="12" y="19" fill="#ffffff" font-family="sans-serif" font-size="14">${label}</text>`
      + '</svg>',
    );
    composites.push({ input: frame, left, top });
    composites.push({ input: svg, left, top: top + imageHeight });
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await sharpFactory({
      create: {
        width: columns * cellWidth,
        height: rows * cellHeight,
        channels: 3,
        background: '#111827',
      },
    }).composite(composites).jpeg({ quality: 86, mozjpeg: true }).toFile(temporaryPath);
    const metadata = await sharpFactory(temporaryPath).metadata();
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) {
      throw new Error('Derived contact sheet failed JPEG validation');
    }
    await fs.promises.rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function isValidContactSheet(filePath, sharpFactory = require('sharp')) {
  try {
    const metadata = await sharpFactory(filePath).metadata();
    return metadata.format === 'jpeg' && metadata.width > 0 && metadata.height > 0;
  } catch {
    return false;
  }
}

async function cleanupDerivedVideoCache({
  directory,
  saveId,
  keepFingerprints = [],
  fileSystem = fs.promises,
} = {}) {
  if (!directory || !saveId) return [];
  const targetDirectory = resolveDerivedCacheDirectory(directory, saveId);
  const keep = new Set(keepFingerprints
    .filter((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
    .map((value) => `${value.toLowerCase()}.jpg`));
  let entries;
  try { entries = await fileSystem.readdir(targetDirectory, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.jpg$/i.test(entry.name) || keep.has(entry.name)) continue;
    const artifactPath = path.join(targetDirectory, entry.name);
    await fileSystem.unlink(artifactPath);
    removed.push(artifactPath);
  }
  return removed.sort();
}

function activeDerivedDirectory() {
  const { getActiveLibraryRoot } = require('./library-registry');
  return path.join(getActiveLibraryRoot(), 'derived', 'video-analysis');
}

function createVideoAnalysisService({
  repository = null,
  frameExtractor = null,
  codex = null,
  derivedDir = null,
  promptVersion = VIDEO_ANALYSIS_PROMPT_VERSION,
  stat = fs.promises.stat,
  exists = fs.existsSync,
  sharpFactory = require('sharp'),
  cleanupDerived = null,
  now = Date.now,
} = {}) {
  const cacheRoot = () => derivedDir || activeDerivedDirectory();
  const cleanup = cleanupDerived || (({ saveId, keepFingerprints }) => cleanupDerivedVideoCache({
    directory: cacheRoot(),
    saveId,
    keepFingerprints,
  }));

  async function fingerprintFor({ save, sourceContext = {} }) {
    const context = buildCanonicalVideoContext({ save, sourceContext });
    const contentIdentity = await resolveVideoContentIdentity(save, { stat });
    return {
      context,
      contentIdentity,
      fingerprint: buildVideoAnalysisFingerprint({ contentIdentity, context, promptVersion }),
    };
  }

  async function prepare({ save, sourceContext = {}, jobId, now: at } = {}) {
    if (!save?.id) throw new Error('Video save id is required');
    const identity = await fingerprintFor({ save, sourceContext });
    const current = repository?.getVideoAnalysis?.(save.id);
    if (current?.fingerprint === identity.fingerprint) {
      return { status: 'unchanged', ...identity, job: current };
    }
    if (!repository?.enqueueVideoAnalysis) return { status: 'ready', ...identity, job: null };
    const timestamp = Number.isFinite(at) ? at : now();
    const job = repository.enqueueVideoAnalysis({
      id: jobId || crypto.randomUUID(),
      saveId: save.id,
      fingerprint: identity.fingerprint,
      promptVersion,
      now: timestamp,
    });
    await cleanup({ saveId: save.id, keepFingerprints: [identity.fingerprint] });
    return { status: 'queued', ...identity, job };
  }

  async function run({ job, save, sourceContext = {}, acceptedTags = [], posterPath = null } = {}) {
    if (!job?.id || !job?.fingerprint) throw new Error('Video analysis job is required');
    if (!save?.id) throw new Error('Video save is required');
    const current = await fingerprintFor({ save, sourceContext });
    if (current.fingerprint !== job.fingerprint) {
      return {
        status: 'stale',
        reason: 'fingerprint_changed',
        jobFingerprint: job.fingerprint,
        fingerprint: current.fingerprint,
      };
    }
    const context = buildVideoRequestContext({ save, sourceContext, acceptedTags });
    const videoPath = save.file_path ?? save.filePath;
    const fallbackPosterPath = posterPath || save.thumb_path || save.thumbPath || null;
    let imagePath = null;
    let evidenceMode = null;
    let duration = null;
    let timestamps = [];

    if (videoPath && frameExtractor?.extract) {
      try {
        const extracted = await frameExtractor.extract(videoPath);
        if (Array.isArray(extracted?.frames) && extracted.frames.length > 0) {
          duration = extracted.duration;
          timestamps = extracted.timestamps;
          imagePath = resolveDerivedCachePath(cacheRoot(), save.id, job.fingerprint);
          if (!(await isValidContactSheet(imagePath, sharpFactory))) {
            await fs.promises.unlink(imagePath).catch(() => {});
            await composeContactSheet({
              frames: extracted.frames,
              timestamps,
              outputPath: imagePath,
              sharpFactory,
            });
          }
          evidenceMode = 'frames';
        }
      } catch {
        // Poster fallback below. Worker owns safe failure state if provider fails.
      }
    }

    if (!imagePath && fallbackPosterPath && exists(fallbackPosterPath)) {
      imagePath = fallbackPosterPath;
      evidenceMode = 'poster';
    }

    const timestamp = now();
    if (!imagePath) {
      repository?.completeVideoAnalysis?.({
        id: job.id,
        fingerprint: job.fingerprint,
        suggestions: [],
        unavailable: true,
        now: timestamp,
      });
      return { status: 'unavailable', fingerprint: job.fingerprint, suggestions: [] };
    }
    if (!codex?.generateVideoTagSuggestions) {
      throw new Error('Dedicated Codex video suggestion provider is unavailable');
    }

    const raw = await codex.generateVideoTagSuggestions({
      duration,
      timestamps,
      evidenceMode,
      context,
      promptVersion: job.prompt_version ?? promptVersion,
    }, { imagePath });
    const suggestions = validateVideoTagSuggestions(raw, { acceptedTags, evidenceMode });
    repository?.completeVideoAnalysis?.({
      id: job.id,
      fingerprint: job.fingerprint,
      suggestions,
      unavailable: false,
      now: timestamp,
    });
    return {
      status: 'completed',
      fingerprint: job.fingerprint,
      evidenceMode,
      contactSheetPath: evidenceMode === 'frames' ? imagePath : null,
      suggestions,
    };
  }

  return { fingerprintFor, prepare, run };
}

module.exports = {
  VIDEO_ANALYSIS_PROMPT_VERSION,
  VideoSuggestionValidationError,
  buildCanonicalVideoContext,
  buildVideoRequestContext,
  buildVideoAnalysisFingerprint,
  cleanupDerivedVideoCache,
  composeContactSheet,
  createVideoAnalysis: createVideoAnalysisService,
  createVideoAnalysisService,
  isValidContactSheet,
  resolveDerivedCacheDirectory,
  resolveDerivedCachePath,
  resolveVideoContentIdentity,
  validateVideoTagSuggestions,
};
