const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function getImagesDir() {
  return path.join(app.getPath('userData'), 'images');
}

function getThumbsDir() {
  return path.join(app.getPath('userData'), 'thumbs');
}

function ensureStorageDirs() {
  for (const dir of [getImagesDir(), getThumbsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  ensureStorageDirs,
  getImagesDir,
  getThumbsDir,
};
