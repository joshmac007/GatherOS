'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexOAuthAuth, CLIENT_ID, REDIRECT_URI } = require('../src/main/gatherlocal/ai/codex-oauth');

function fakeVault(initial = { state: 'signed_out', auth: null }) {
  let stored = initial.auth;
  let logouts = 0;
  return {
    available: () => true,
    load: () => stored ? { state: 'authenticated', auth: stored } : initial,
    save(value) { stored = value; return { ok: true }; },
    logout() { logouts += 1; stored = null; return { ok: true }; },
    get stored() { return stored; },
    get logouts() { return logouts; },
  };
}

function fakeServerFactory(onHandler) {
  return (handler) => {
    onHandler(handler);
    const listeners = {};
    return {
      once(name, fn) { listeners[name] = fn; },
      listen(port, host, callback) {
        assert.equal(port, 1455);
        assert.equal(host, 'localhost');
        callback?.();
      },
      address() { return { address: '127.0.0.1', port: 1455, family: 'IPv4' }; },
      close() {},
      emit(name, value) { listeners[name]?.(value); },
    };
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('authorization URL uses exact PKCE OAuth contract and cancel is bounded', async () => {
  let handler;
  const auth = createCodexOAuthAuth({
    vault: fakeVault(),
    createServer: fakeServerFactory((fn) => { handler = fn; }),
    randomBytes: (size) => Buffer.alloc(size, 7),
    setTimer: () => 1,
    clearTimer() {},
  });
  auth.initialize();
  const pending = await auth.beginAuthorization();
  const url = new URL(pending.url);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('originator'), 'gatherlocal');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');

  const rejected = new Promise((resolve) => handler({
    method: 'POST', url: '/auth/callback', headers: { host: 'localhost:1455' },
    socket: { remoteAddress: '127.0.0.1' },
  }, { writeHead(code) { assert.equal(code, 404); }, end() { resolve(); } }));
  await rejected;
  assert.equal(auth.snapshot().state, 'authorizing');
  auth.cancelAuthorization();
  await assert.rejects(pending.completion, (error) => error.code === 'AI_AUTH_CANCELLED');
  assert.deepEqual(auth.snapshot(), {
    state: 'signed_out', authenticated: false,
    error: { code: 'AI_AUTH_CANCELLED', message: 'Sign in cancelled' },
  });
});

test('refresh is generation-aware and persists before exposing memory', async () => {
  const initial = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, accountId: 'acct' };
  let saves = 0;
  const vault = fakeVault({ state: 'authenticated', auth: initial });
  const originalSave = vault.save;
  vault.save = (value) => { saves += 1; return originalSave(value); };
  const auth = createCodexOAuthAuth({
    vault,
    now: () => 1000,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { access_token: 'new', refresh_token: 'next', expires_in: 60 }; },
    }),
  });
  auth.initialize();
  const before = auth.generation;
  const refreshed = await auth.credentials({ forceRefresh: true, expectedGeneration: before });
  assert.equal(saves, 1);
  assert.equal(refreshed.accessToken, 'new');
  assert.equal(refreshed.generation, before + 1);
  const current = await auth.credentials({ forceRefresh: true, expectedGeneration: before });
  assert.equal(current.accessToken, 'new');
  assert.equal(saves, 1);
});

test('callback authenticates only after guarded exchange and encrypted save', async () => {
  let handler;
  let saved = null;
  const vault = fakeVault();
  vault.save = (value) => { saved = value; return { ok: true }; };
  const requests = [];
  const auth = createCodexOAuthAuth({
    vault,
    now: () => 1000,
    createServer: fakeServerFactory((fn) => { handler = fn; }),
    setTimer: () => 1,
    clearTimer() {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const claims = Buffer.from(JSON.stringify({ chatgpt_account_id: 'account' })).toString('base64url');
      return {
        ok: true,
        async json() {
          return { access_token: 'access', refresh_token: 'refresh', id_token: `x.${claims}.x`, expires_in: 60 };
        },
      };
    },
  });
  auth.initialize();
  const authorization = await auth.beginAuthorization();
  const state = new URL(authorization.url).searchParams.get('state');
  let status;
  await handler({
    method: 'GET',
    url: `/auth/callback?code=code&state=${encodeURIComponent(state)}`,
    headers: { host: 'localhost:1455' },
    socket: { remoteAddress: '::1' },
  }, {
    writeHead(value) { status = value; },
    end() {},
  });
  const result = await authorization.completion;
  assert.equal(status, 200);
  assert.equal(requests[0].url, 'https://auth.openai.com/oauth/token');
  assert.match(requests[0].init.body, new RegExp(`client_id=${CLIENT_ID}`));
  assert.deepEqual(saved, {
    accessToken: 'access', refreshToken: 'refresh', expiresAt: 61000, accountId: 'account',
  });
  assert.equal(result.accessToken, 'access');
  assert.equal(auth.snapshot().state, 'authenticated');
});

async function runLateExchangeInvalidation(action) {
  let handler;
  const exchange = deferred();
  const timers = [];
  const vault = fakeVault();
  let saves = 0;
  vault.save = (value) => { saves += 1; return { ok: true, value }; };
  const auth = createCodexOAuthAuth({
    vault,
    createServer: fakeServerFactory((fn) => { handler = fn; }),
    fetchImpl: async () => exchange.promise,
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {},
  });
  auth.initialize();
  const authorization = await auth.beginAuthorization();
  const state = new URL(authorization.url).searchParams.get('state');
  const responses = [];
  const exchangeHandler = handler({
    method: 'GET', url: `/auth/callback?code=code&state=${state}`,
    headers: { host: 'localhost:1455' }, socket: { remoteAddress: '127.0.0.1' },
  }, {
    writeHead(status) { responses.push(status); }, end() {},
  });
  assert.equal(auth.snapshot().state, 'exchanging');
  let duplicateStatus;
  await handler({
    method: 'GET', url: `/auth/callback?code=second&state=${state}`,
    headers: { host: 'localhost:1455' }, socket: { remoteAddress: '127.0.0.1' },
  }, { writeHead(status) { duplicateStatus = status; }, end() {} });
  assert.equal(duplicateStatus, 400);
  await action({ auth, timers });
  await assert.rejects(authorization.completion);
  exchange.resolve({
    ok: true,
    async json() { return { access_token: 'late', refresh_token: 'late-refresh', expires_in: 60 }; },
  });
  await exchangeHandler;
  assert.equal(saves, 0);
  assert.equal(vault.stored, null);
  assert.equal(auth.snapshot().authenticated, false);
  assert.deepEqual(responses, [409]);
}

test('cancel aborts claimed exchange and prevents late persistence', async () => {
  await runLateExchangeInvalidation(({ auth }) => { auth.cancelAuthorization(); });
});

test('timeout aborts claimed exchange and prevents late persistence', async () => {
  await runLateExchangeInvalidation(({ timers }) => { timers[0](); });
});

test('logout aborts claimed exchange and prevents late persistence', async () => {
  await runLateExchangeInvalidation(({ auth }) => { auth.logout(); });
});

test('dispose aborts claimed exchange and prevents late persistence', async () => {
  await runLateExchangeInvalidation(({ auth }) => { auth.dispose(); });
});

test('beginAuthorization waits for loopback listener and reports EADDRINUSE cleanly', async () => {
  let finishListen;
  const delayed = createCodexOAuthAuth({
    vault: fakeVault(),
    createServer: (handler) => {
      void handler;
      return {
        once() {},
        listen(port, host, callback) { assert.equal(host, 'localhost'); finishListen = callback; },
        address() { return { address: '::1', port: 1455, family: 'IPv6' }; },
        close() {},
      };
    },
  });
  delayed.initialize();
  let resolved = false;
  const starting = delayed.beginAuthorization().then((value) => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false);
  finishListen();
  const started = await starting;
  delayed.cancelAuthorization();
  await assert.rejects(started.completion);

  const occupied = createCodexOAuthAuth({
    vault: fakeVault(),
    createServer: () => {
      const listeners = {};
      return {
        once(name, fn) { listeners[name] = fn; },
        listen() { queueMicrotask(() => listeners.error(Object.assign(new Error('used'), { code: 'EADDRINUSE' }))); },
        address() { return null; },
        close() {},
      };
    },
  });
  occupied.initialize();
  await assert.rejects(occupied.beginAuthorization(), (error) => error.code === 'AI_AUTH_UNAVAILABLE');
  assert.equal(occupied.snapshot().state, 'unavailable');
});

test('refresh obeys absolute request deadline and dispose aborts active requests', async () => {
  const timers = [];
  const initial = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, accountId: null };
  const auth = createCodexOAuthAuth({
    vault: fakeVault({ state: 'authenticated', auth: initial }),
    now: () => 100,
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {},
    fetchImpl: async (url, init) => {
      void url;
      return new Promise((resolve, reject) => {
        void resolve;
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })));
      });
    },
  });
  auth.initialize();
  const refreshing = auth.credentials({ forceRefresh: true, deadline: 150 });
  timers[0]();
  await assert.rejects(refreshing, (error) => error.code === 'AI_TIMEOUT');

  const controller = new AbortController();
  auth.registerRequestController(controller);
  auth.dispose();
  assert.equal(controller.signal.aborted, true);
});

test('invalid_grant clears auth durably while transient refresh preserves it', async () => {
  const initial = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 999999, accountId: 'acct' };
  const transientVault = fakeVault({ state: 'authenticated', auth: initial });
  const transient = createCodexOAuthAuth({
    vault: transientVault,
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return { error: 'server_error' }; } }),
  });
  transient.initialize();
  await assert.rejects(
    transient.credentials({ forceRefresh: true }),
    (error) => error.code === 'AI_PROVIDER_UNAVAILABLE',
  );
  assert.equal(transient.snapshot().state, 'authenticated');
  assert.equal(transientVault.logouts, 0);

  const invalidVault = fakeVault({ state: 'authenticated', auth: initial });
  const invalid = createCodexOAuthAuth({
    vault: invalidVault,
    fetchImpl: async () => ({ ok: false, status: 400, async json() { return { error: 'invalid_grant' }; } }),
  });
  invalid.initialize();
  await assert.rejects(
    invalid.credentials({ forceRefresh: true }),
    (error) => error.code === 'AI_AUTH_REQUIRED',
  );
  assert.equal(invalid.snapshot().state, 'signed_out');
  assert.equal(invalidVault.logouts, 1);
});

test('one caller abort does not cancel shared refresh for another caller', async () => {
  const exchange = deferred();
  let networkCalls = 0;
  let networkSignal;
  const initial = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, accountId: null };
  const auth = createCodexOAuthAuth({
    vault: fakeVault({ state: 'authenticated', auth: initial }),
    fetchImpl: async (url, init) => {
      void url;
      networkCalls += 1;
      networkSignal = init.signal;
      return exchange.promise;
    },
  });
  auth.initialize();
  const firstController = new AbortController();
  const first = auth.credentials({ forceRefresh: true, signal: firstController.signal });
  const second = auth.credentials({ forceRefresh: true });
  firstController.abort();
  await assert.rejects(first, (error) => error.code === 'AI_ABORTED');
  assert.equal(networkSignal.aborted, false);
  exchange.resolve({
    ok: true,
    async json() { return { access_token: 'new', refresh_token: 'next', expires_in: 60 }; },
  });
  assert.equal((await second).accessToken, 'new');
  assert.equal(networkCalls, 1);
});

test('stale invalid_grant cannot clear credentials from newer auth generation', async () => {
  const exchange = deferred();
  const initial = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, accountId: null };
  const vault = fakeVault({ state: 'authenticated', auth: initial });
  const auth = createCodexOAuthAuth({
    vault,
    fetchImpl: async () => exchange.promise,
  });
  auth.initialize();
  const refreshing = auth.credentials({ forceRefresh: true });
  const newer = { accessToken: 'new-login', refreshToken: 'new-refresh', expiresAt: 9999999999999, accountId: 'new' };
  vault.save(newer);
  auth.initialize();
  exchange.resolve({
    ok: false,
    status: 400,
    async json() { return { error: 'invalid_grant' }; },
  });
  assert.equal((await refreshing).accessToken, 'new-login');
  assert.equal(vault.logouts, 0);
  assert.equal(auth.snapshot().state, 'authenticated');
});
