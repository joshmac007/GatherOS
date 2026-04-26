// Encrypted key storage backed by Electron's safeStorage. The key never
// leaves the main process — IPC only exposes hasKey / set / clear / test
// so the renderer can never read it directly.

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const FILE_NAME = 'openai-key.bin';

function keyFilePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function hasOpenAIKey() {
  return fs.existsSync(keyFilePath());
}

function getOpenAIKey() {
  const file = keyFilePath();
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = fs.readFileSync(file);
    return safeStorage.decryptString(buf);
  } catch (err) {
    console.error('Failed to decrypt OpenAI key:', err.message);
    return null;
  }
}

function setOpenAIKey(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.trim()) {
    return { ok: false, reason: 'empty' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: 'no-encryption' };
  }
  try {
    const encrypted = safeStorage.encryptString(plaintext.trim());
    fs.writeFileSync(keyFilePath(), encrypted, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    console.error('Failed to encrypt OpenAI key:', err.message);
    return { ok: false, reason: 'write-failed' };
  }
}

function clearOpenAIKey() {
  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  hasOpenAIKey,
  getOpenAIKey,
  setOpenAIKey,
  clearOpenAIKey,
};
