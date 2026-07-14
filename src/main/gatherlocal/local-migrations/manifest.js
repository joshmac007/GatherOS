const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_SPECS = Object.freeze([
  Object.freeze({ ordinal: 1, id: 'smart-categories-foundation', file: '001-smart-categories-foundation.js' }),
  Object.freeze({ ordinal: 2, id: 'smart-category-run-metadata', file: '002-smart-category-run-metadata.js' }),
  Object.freeze({ ordinal: 3, id: 'semantic-video-domain', file: '003-semantic-video-domain.js' }),
  Object.freeze({ ordinal: 4, id: 'semantic-video-queue-compatibility', file: '004-semantic-video-queue-compatibility.js' }),
  Object.freeze({ ordinal: 5, id: 'save-background-routing', file: '005-save-background-routing.js' }),
  Object.freeze({ ordinal: 6, id: 'x-tweet-created-at-repair', file: '006-x-tweet-created-at-repair.js' }),
  Object.freeze({ ordinal: 7, id: 'social-source-key', file: '007-social-source-key.js' }),
]);

function checksumArtifact(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadManifest() {
  const entries = MIGRATION_SPECS.map(({ ordinal, id, file }) => {
    const filePath = path.join(__dirname, 'migrations', file);
    const checksum = checksumArtifact(filePath);
    delete require.cache[require.resolve(filePath)];
    const artifact = require(filePath);
    if (!artifact || typeof artifact.apply !== 'function' || typeof artifact.verify !== 'function') {
      throw new TypeError(`Invalid local migration artifact: ${file}`);
    }
    return Object.freeze({ ordinal, id, checksum, apply: artifact.apply, verify: artifact.verify });
  });
  return Object.freeze(entries);
}

module.exports = { loadManifest, checksumArtifact };
