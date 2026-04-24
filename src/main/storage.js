const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

async function saveImageFromBase64(dataUrl) {
  const sharp = require('sharp');
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid image data URL');

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return _writeImageFiles(buffer, ext, sharp);
}

async function saveImageFromFile(sourcePath) {
  const sharp = require('sharp');
  const ext = path.extname(sourcePath).slice(1).toLowerCase() || 'png';
  const buffer = fs.readFileSync(sourcePath);
  return _writeImageFiles(buffer, ext, sharp);
}

async function saveImageFromBuffer(buffer, ext = 'png') {
  const sharp = require('sharp');
  return _writeImageFiles(buffer, ext, sharp);
}

async function _writeImageFiles(buffer, ext, sharp) {
  const id = crypto.randomUUID();
  const filePath = path.join(getImagesDir(), `${id}.${ext}`);
  const thumbPath = path.join(getThumbsDir(), `${id}.jpg`);

  fs.writeFileSync(filePath, buffer);

  const meta = await sharp(buffer).metadata();
  await sharp(buffer)
    .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);

  return {
    id,
    filePath,
    thumbPath,
    width: meta.width || null,
    height: meta.height || null,
    fileSize: buffer.length,
  };
}

function deleteImageFiles(filePath, thumbPath) {
  try { fs.unlinkSync(filePath); } catch {}
  try { fs.unlinkSync(thumbPath); } catch {}
}

module.exports = {
  ensureStorageDirs,
  getImagesDir,
  getThumbsDir,
  saveImageFromBase64,
  saveImageFromFile,
  saveImageFromBuffer,
  deleteImageFiles,
};
