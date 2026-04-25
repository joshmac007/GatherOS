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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);

function extFromMime(mime) {
  if (!mime) return null;
  const m = mime.toLowerCase().match(/^image\/([\w+.-]+)/);
  if (!m) return null;
  let ext = m[1];
  if (ext === 'jpeg') ext = 'jpg';
  if (ext.includes('+')) ext = ext.split('+')[0];
  return IMAGE_EXTS.has(ext) ? ext : null;
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot < 0) return null;
    let ext = last.slice(dot + 1).toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    return IMAGE_EXTS.has(ext) ? ext : null;
  } catch {
    return null;
  }
}

async function saveImageFromUrl(url, opts = {}) {
  const sharp = require('sharp');

  if (url.startsWith('data:')) {
    return saveImageFromBase64(url);
  }
  if (url.startsWith('blob:')) {
    throw new Error('Blob URLs only exist inside the browser; drag the image directly instead.');
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  };
  if (opts.referer) headers.Referer = opts.referer;

  console.log('[drop-url] fetching:', url, opts.referer ? `(ref: ${opts.referer})` : '');
  const res = await fetch(url, { redirect: 'follow', headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.startsWith('image/') && !extFromUrl(url)) {
    throw new Error(`Response is not an image: ${contentType || 'unknown'}`);
  }
  const ext = extFromMime(contentType) || extFromUrl(url) || 'png';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('Empty image response');
  }
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
  saveImageFromUrl,
  deleteImageFiles,
};
