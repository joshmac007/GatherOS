'use strict';

const fs = require('node:fs');
const { CAPABILITIES } = require('./config');
const { runtimeError, timeoutValue } = require('./transport-utils');

function loadSharp(dependencies, provider) {
  if (typeof dependencies.sharp === 'function') return dependencies.sharp;
  try { return require('sharp'); } catch (cause) {
    throw runtimeError('AI_PROVIDER_UNAVAILABLE', 'Image transport requires JPEG encoding', {
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider,
      retryable: false,
      cause,
    });
  }
}

async function boundedJpegDataUrl(filePath, {
  maxBytes = 2 * 1024 * 1024,
  provider = 'structured-json',
} = {}, dependencies = {}) {
  if (typeof dependencies.imageToDataUrl === 'function') {
    return dependencies.imageToDataUrl(filePath, { maxBytes });
  }
  if (typeof dependencies.imageToJpeg === 'function') {
    const encoded = await dependencies.imageToJpeg(filePath, { maxBytes });
    const buffer = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
    if (buffer.length <= maxBytes) return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } else if (filePath && fs.existsSync(filePath)) {
    const sharp = loadSharp(dependencies, provider);
    const limit = timeoutValue(maxBytes, 2 * 1024 * 1024);
    let best;
    for (const quality of [85, 75, 65, 55, 45, 35]) {
      best = await sharp(filePath)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (best.length <= limit) return `data:image/jpeg;base64,${best.toString('base64')}`;
    }
  } else {
    throw runtimeError('AI_INVALID_RESPONSE', 'Image file not found', {
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider,
      retryable: false,
    });
  }
  throw runtimeError('AI_INVALID_RESPONSE', 'Image exceeds transport size limit', {
    capability: CAPABILITIES.STRUCTURED_JSON,
    provider,
    retryable: false,
  });
}

module.exports = { boundedJpegDataUrl };
