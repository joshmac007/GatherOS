'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEncryptedAuthVault } = require('../src/main/gatherlocal/ai/codex-auth-vault');

function storage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(String(value).slice('encrypted:'.length), 'base64').toString(),
  };
}

test('vault encrypts minimum auth fields and durable logout tombstone', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'auth.vault');
  const vault = createEncryptedAuthVault({ safeStorage: storage(), filePath });
  const auth = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1234, accountId: 'acct', extra: 'no' };

  assert.deepEqual(vault.load(), { state: 'signed_out', auth: null });
  assert.deepEqual(vault.save(auth), { ok: true });
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /access|refresh|acct|extra/);
  assert.deepEqual(vault.load(), {
    state: 'authenticated',
    auth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1234, accountId: 'acct' },
  });
  assert.deepEqual(vault.logout(), { ok: true });
  assert.deepEqual(vault.load(), { state: 'signed_out', auth: null });
  assert.equal(fs.existsSync(filePath), false);
});

test('vault reconciles committed rename when directory fsync fails', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-vault-fsync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'auth.vault');
  let directoryFd = null;
  const fileSystem = {
    ...fs,
    openSync(target, flags, mode) {
      const fd = fs.openSync(target, flags, mode);
      if (target === directory) directoryFd = fd;
      return fd;
    },
    fsyncSync(fd) {
      if (fd === directoryFd) throw new Error('directory fsync failed');
      return fs.fsyncSync(fd);
    },
  };
  const vault = createEncryptedAuthVault({ safeStorage: storage(), filePath, fileSystem });
  const result = vault.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 5, accountId: null });
  assert.deepEqual(result, { ok: true, durabilityPending: true });
  assert.equal(vault.load().state, 'authenticated');
});

test('logout leaves restart-safe identity-free tombstone when unlink cleanup fails', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatherlocal-vault-tombstone-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'auth.vault');
  const fileSystem = {
    ...fs,
    unlinkSync(target) {
      if (target === filePath) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.unlinkSync(target);
    },
  };
  const vault = createEncryptedAuthVault({ safeStorage: storage(), filePath, fileSystem });
  vault.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 5, accountId: 'acct' });
  assert.deepEqual(vault.logout(), { ok: true, cleanupPending: true });
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /acct|accessToken|refreshToken/);
  assert.deepEqual(vault.load(), { state: 'signed_out', auth: null, cleanupPending: true });
});

test('vault fails closed without Electron encryption', () => {
  const vault = createEncryptedAuthVault({ safeStorage: storage(false), filePath: '/unused/auth.vault' });
  assert.deepEqual(vault.load(), { state: 'unavailable', auth: null });
  assert.deepEqual(vault.save({}), { ok: false, state: 'corrupt' });
  assert.deepEqual(vault.logout(), { ok: false, state: 'unavailable' });
});
