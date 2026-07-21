'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VAULT_VERSION = 1;
const AUTH_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'accountId'];

function minimalRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const record = {
    accessToken: typeof value.accessToken === 'string' ? value.accessToken : '',
    refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : '',
    expiresAt: Number(value.expiresAt),
    accountId: typeof value.accountId === 'string' && value.accountId ? value.accountId : null,
  };
  if (!record.accessToken || !record.refreshToken || !Number.isFinite(record.expiresAt)) return null;
  return record;
}

function createEncryptedAuthVault({ safeStorage, filePath, fileSystem = fs } = {}) {
  if (!filePath || typeof filePath !== 'string') throw new TypeError('Auth vault requires filePath');
  const directory = path.dirname(filePath);

  function available() {
    return Boolean(
      safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable()
      && typeof safeStorage.encryptString === 'function'
      && typeof safeStorage.decryptString === 'function'
    );
  }

  function atomicWrite(buffer) {
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    let renamed = false;
    try {
      descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, buffer);
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = null;
      fileSystem.renameSync(temporary, filePath);
      renamed = true;
      const dirDescriptor = fileSystem.openSync(directory, 'r');
      try { fileSystem.fsyncSync(dirDescriptor); } finally { fileSystem.closeSync(dirDescriptor); }
      return { committed: true, durabilityPending: false };
    } catch (error) {
      if (descriptor !== null && descriptor !== undefined) {
        try { fileSystem.closeSync(descriptor); } catch {}
      }
      try { fileSystem.unlinkSync(temporary); } catch {}
      if (renamed) {
        try {
          const current = fileSystem.readFileSync(filePath);
          if (Buffer.from(current).equals(Buffer.from(buffer))) {
            return { committed: true, durabilityPending: true };
          }
        } catch {}
      }
      return { committed: false, durabilityPending: false, error };
    }
  }

  function persistPayload(payload) {
    if (!available()) return { ok: false, state: 'unavailable' };
    try {
      const result = atomicWrite(safeStorage.encryptString(JSON.stringify(payload)));
      if (result.committed) return result.durabilityPending ? { ok: true, durabilityPending: true } : { ok: true };
      return { ok: false, state: 'unavailable' };
    } catch {
      return { ok: false, state: 'unavailable' };
    }
  }

  return {
    filePath,
    available,
    load() {
      if (!available()) return { state: 'unavailable', auth: null };
      let encrypted;
      try { encrypted = fileSystem.readFileSync(filePath); } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'signed_out', auth: null };
        return { state: 'unavailable', auth: null };
      }
      try {
        const payload = JSON.parse(safeStorage.decryptString(encrypted));
        if (payload?.version !== VAULT_VERSION) return { state: 'corrupt', auth: null };
        if (payload.loggedOut === true) {
          let cleanupPending = false;
          try { fileSystem.unlinkSync(filePath); } catch (error) { cleanupPending = error?.code !== 'ENOENT'; }
          return cleanupPending
            ? { state: 'signed_out', auth: null, cleanupPending: true }
            : { state: 'signed_out', auth: null };
        }
        const auth = minimalRecord(payload.auth);
        return auth ? { state: 'authenticated', auth } : { state: 'corrupt', auth: null };
      } catch {
        return { state: 'corrupt', auth: null };
      }
    },
    save(auth) {
      const record = minimalRecord(auth);
      if (!record) return { ok: false, state: 'corrupt' };
      return persistPayload({ version: VAULT_VERSION, auth: record });
    },
    logout() {
      const result = persistPayload({ version: VAULT_VERSION, loggedOut: true });
      if (!result.ok) return result;
      let cleanupPending = false;
      try { fileSystem.unlinkSync(filePath); } catch (error) { cleanupPending = error?.code !== 'ENOENT'; }
      return cleanupPending ? { ...result, cleanupPending: true } : result;
    },
  };
}

module.exports = { AUTH_FIELDS, VAULT_VERSION, createEncryptedAuthVault, minimalRecord };
