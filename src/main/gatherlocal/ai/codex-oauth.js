'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { runtimeError } = require('./transport-utils');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CALLBACK_PORT = 1455;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_STATES = Object.freeze([
  'loading', 'signed_out', 'authorizing', 'exchanging',
  'authenticated', 'corrupt', 'unavailable',
]);

function base64url(value) { return Buffer.from(value).toString('base64url'); }

function createPkce(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function parseJwtClaims(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch { return null; }
}

function extractAccountId(tokens) {
  for (const token of [tokens?.id_token, tokens?.access_token]) {
    const claims = parseJwtClaims(token);
    const accountId = claims?.chatgpt_account_id
      || claims?.['https://api.openai.com/auth']?.chatgpt_account_id
      || claims?.organizations?.[0]?.id;
    if (typeof accountId === 'string' && accountId) return accountId;
  }
  return null;
}

function authError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function sanitizeTransient(error, fallback = 'Authentication failed') {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'AI_AUTH_FAILED';
  const messages = new Map([
    ['AI_AUTH_CANCELLED', 'Sign in cancelled'],
    ['AI_AUTH_TIMEOUT', 'Sign in timed out'],
    ['AI_AUTH_BUSY', 'Sign in already in progress'],
    ['AI_AUTH_CALLBACK_INVALID', 'Sign in callback was rejected'],
    ['AI_AUTH_PERSIST_FAILED', 'Could not securely save sign in'],
    ['AI_AUTH_UNAVAILABLE', 'Secure sign in is unavailable'],
  ]);
  return { code, message: messages.get(code) || fallback };
}

function loopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function callbackRequest(req) {
  if (req.method !== 'GET' || !loopback(req.socket?.remoteAddress)) return false;
  if (String(req.headers?.host || '').toLowerCase() !== `localhost:${CALLBACK_PORT}`) return false;
  try { return new URL(req.url || '/', REDIRECT_URI).pathname === '/auth/callback'; } catch { return false; }
}

function createCodexOAuthAuth({
  vault,
  fetchImpl = globalThis.fetch,
  createServer = http.createServer,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  issuer = ISSUER,
  tracer = () => {},
} = {}) {
  if (!vault) throw new TypeError('Codex OAuth requires encrypted vault');
  let state = 'loading';
  let transientError = null;
  let auth = null;
  let generation = 0;
  let transaction = null;
  let refreshFlight = null;
  let disposed = false;
  const requestControllers = new Set();

  function emit(event, detail = {}) { try { tracer({ event, ...detail }); } catch {} }
  function setState(next, error = null) {
    if (!AUTH_STATES.includes(next)) throw new TypeError(`Unknown auth state: ${next}`);
    state = next;
    transientError = error ? sanitizeTransient(error) : null;
    emit('auth-state', { state: next, error: transientError });
  }
  function snapshot() { return { state, error: transientError, authenticated: state === 'authenticated' }; }

  function initialize() {
    const loaded = vault.load();
    auth = loaded.auth || null;
    generation += 1;
    setState(loaded.state);
    return { ...snapshot(), cleanupPending: loaded.cleanupPending === true };
  }

  function composeOperationSignal(signal, deadline) {
    const controller = new AbortController();
    let timer = null;
    const onAbort = () => controller.abort(signal.reason || authError('AI_ABORTED', 'Operation aborted'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    if (Number.isFinite(deadline)) {
      const remaining = deadline - now();
      if (remaining <= 0) controller.abort(authError('AI_TIMEOUT', 'Operation timed out'));
      else timer = setTimer(() => controller.abort(authError('AI_TIMEOUT', 'Operation timed out')), remaining);
    }
    return {
      signal: controller.signal,
      cleanup() {
        if (timer !== null) clearTimer(timer);
        signal?.removeEventListener?.('abort', onAbort);
      },
    };
  }

  async function tokenRequest(body, { signal, deadline } = {}) {
    if (typeof fetchImpl !== 'function') throw authError('AI_AUTH_UNAVAILABLE', 'fetch unavailable');
    const operation = composeOperationSignal(signal, deadline);
    try {
      const response = await fetchImpl(`${issuer}/oauth/token`, {
        method: 'POST', redirect: 'error', signal: operation.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      if (!response?.ok) {
        let payload = null;
        try { payload = await response.json(); } catch {}
        if (response.status === 400 && payload?.error === 'invalid_grant') {
          throw authError('AI_AUTH_INVALID_GRANT', 'OAuth grant is invalid', { status: 400 });
        }
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        throw authError(
          transient ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_AUTH_EXCHANGE_FAILED',
          'OAuth token request failed',
          { status: response.status, retryable: transient },
        );
      }
      const tokens = await response.json();
      if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
        throw authError('AI_AUTH_EXCHANGE_FAILED', 'OAuth token response invalid');
      }
      return tokens;
    } catch (error) {
      if (operation.signal.aborted) {
        const reason = operation.signal.reason;
        if (reason?.code === 'AI_TIMEOUT') throw reason;
        throw authError('AI_ABORTED', 'Operation aborted');
      }
      throw error;
    } finally { operation.cleanup(); }
  }

  function recordFromTokens(tokens, previous = null) {
    const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
      ? tokens.refresh_token : previous?.refreshToken;
    const seconds = Number(tokens.expires_in ?? 3600);
    if (!refreshToken || !Number.isFinite(seconds) || seconds <= 0) {
      throw authError('AI_AUTH_EXCHANGE_FAILED', 'OAuth token response invalid');
    }
    return {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: now() + seconds * 1000,
      accountId: extractAccountId(tokens) || previous?.accountId || null,
    };
  }

  function persistAuthenticated(record) {
    const saved = vault.save(record);
    if (!saved.ok) throw authError('AI_AUTH_PERSIST_FAILED', 'Secure token persistence failed');
    auth = record;
    generation += 1;
    setState('authenticated');
    return { ...record, generation };
  }

  function clearAuthDurably() {
    const saved = vault.logout();
    if (!saved.ok) throw authError('AI_AUTH_PERSIST_FAILED', 'Secure logout persistence failed');
    auth = null;
    generation += 1;
    setState('signed_out');
  }

  function waitForRefresh(promise, { signal, deadline } = {}) {
    if (signal?.aborted) {
      return Promise.reject(runtimeError('AI_ABORTED', 'Codex refresh was aborted', {
        provider: 'codex', retryable: false,
      }));
    }
    if (Number.isFinite(deadline) && deadline <= now()) {
      return Promise.reject(runtimeError('AI_TIMEOUT', 'Codex refresh timed out', {
        provider: 'codex', retryable: true,
      }));
    }
    if (!signal && !Number.isFinite(deadline)) return promise;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimer(timer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onAbort = () => settle(reject, runtimeError('AI_ABORTED', 'Codex refresh was aborted', {
        provider: 'codex', retryable: false,
      }));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (Number.isFinite(deadline)) {
        timer = setTimer(() => settle(reject, runtimeError('AI_TIMEOUT', 'Codex refresh timed out', {
          provider: 'codex', retryable: true,
        })), deadline - now());
      }
      promise.then((value) => settle(resolve, value), (error) => settle(reject, error));
    });
  }

  async function refresh(expectedGeneration = generation, options = {}) {
    if (!auth?.refreshToken) {
      throw runtimeError('AI_AUTH_REQUIRED', 'Codex sign in required', { provider: 'codex' });
    }
    if (expectedGeneration !== generation) return { ...auth, generation };
    if (refreshFlight && refreshFlight.generation !== generation) {
      refreshFlight.controller.abort(authError('AI_ABORTED', 'Refresh superseded'));
      refreshFlight = null;
    }
    if (!refreshFlight) {
      const current = auth;
      const currentGeneration = generation;
      const flight = {
        controller: new AbortController(), generation: currentGeneration, promise: null,
      };
      refreshFlight = flight;
      flight.promise = tokenRequest({
        grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: CLIENT_ID,
      }, { signal: flight.controller.signal }).then((tokens) => {
        if (generation !== currentGeneration || flight.controller.signal.aborted) return { ...auth, generation };
        return persistAuthenticated(recordFromTokens(tokens, current));
      }).catch((error) => {
        if (generation !== currentGeneration || auth !== current) {
          if (auth && state === 'authenticated') return { ...auth, generation };
          throw runtimeError('AI_AUTH_REQUIRED', 'Codex sign in required', {
            provider: 'codex', retryable: false, setupAction: 'sign-in', cause: error,
          });
        }
        if (error?.code === 'AI_AUTH_INVALID_GRANT') {
          clearAuthDurably();
          throw runtimeError('AI_AUTH_REQUIRED', 'Codex sign in required', {
            provider: 'codex', retryable: false, setupAction: 'sign-in', cause: error,
          });
        }
        transientError = sanitizeTransient(error, 'Session refresh failed');
        const code = error?.code === 'AI_TIMEOUT' ? 'AI_TIMEOUT'
          : error?.code === 'AI_ABORTED' ? 'AI_ABORTED' : 'AI_PROVIDER_UNAVAILABLE';
        throw runtimeError(code, code === 'AI_TIMEOUT' ? 'Codex refresh timed out'
          : code === 'AI_ABORTED' ? 'Codex refresh was aborted' : 'Codex refresh failed', {
          provider: 'codex', retryable: code === 'AI_TIMEOUT' || code === 'AI_PROVIDER_UNAVAILABLE', cause: error,
        });
      }).finally(() => {
        if (refreshFlight === flight) refreshFlight = null;
      });
    }
    return waitForRefresh(refreshFlight.promise, options);
  }

  async function credentials({ forceRefresh = false, expectedGeneration, signal, deadline } = {}) {
    if (state === 'loading') initialize();
    if (state !== 'authenticated' || !auth) {
      throw runtimeError('AI_AUTH_REQUIRED', 'Codex sign in required', {
        provider: 'codex', retryable: false, setupAction: 'sign-in',
      });
    }
    if (signal?.aborted) throw runtimeError('AI_ABORTED', 'Codex request was aborted', { provider: 'codex' });
    if (Number.isFinite(deadline) && deadline <= now()) {
      throw runtimeError('AI_TIMEOUT', 'Codex request timed out', { provider: 'codex', retryable: true });
    }
    const observed = expectedGeneration ?? generation;
    if (forceRefresh || auth.expiresAt <= now() + 30000) {
      return refresh(observed, { signal, deadline });
    }
    return { ...auth, generation };
  }

  function settle(tx, method, value) {
    if (tx.settled) return false;
    tx.settled = true;
    tx[method](value);
    return true;
  }
  function closeServer(tx) { try { tx.server?.close(); } catch {} }
  function respond(tx, status, message) {
    if (!tx.response || tx.responded) return;
    tx.responded = true;
    try {
      tx.response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      tx.response.end(message);
    } catch {}
  }
  function invalidateTransaction(
    tx,
    error,
    nextState = auth ? 'authenticated' : 'signed_out',
    responseStatus = 409,
    responseMessage = 'Sign in cancelled',
  ) {
    if (!tx || tx.status === 'invalid') return false;
    tx.status = 'invalid';
    if (tx.timer !== null) clearTimer(tx.timer);
    tx.controller.abort(error);
    closeServer(tx);
    respond(tx, responseStatus, responseMessage);
    if (transaction === tx) transaction = null;
    setState(nextState, error);
    settle(tx, 'reject', error);
    return true;
  }

  function cancelAuthorization() {
    return invalidateTransaction(transaction, authError('AI_AUTH_CANCELLED', 'Sign in cancelled'));
  }

  function listen(server) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      server.once('error', (error) => done(reject, error));
      server.once('listening', () => done(resolve));
      server.listen(CALLBACK_PORT, 'localhost', () => done(resolve));
    });
  }

  async function beginAuthorization() {
    if (disposed) throw authError('AI_AUTH_UNAVAILABLE', 'Auth manager disposed');
    if (transaction) throw authError('AI_AUTH_BUSY', 'Sign in already in progress');
    if (!vault.available()) {
      const error = authError('AI_AUTH_UNAVAILABLE', 'Secure storage unavailable');
      setState('unavailable', error);
      throw error;
    }
    const pkce = createPkce(randomBytes);
    const oauthState = base64url(randomBytes(32));
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    completion.catch(() => {});
    const tx = {
      id: randomUUID(), status: 'pending', oauthState, pkce,
      controller: new AbortController(), server: null, timer: null,
      response: null, responded: false, settled: false,
      resolve: resolveCompletion, reject: rejectCompletion,
    };
    const server = createServer(async (req, res) => {
      if (!callbackRequest(req)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      if (transaction !== tx || tx.status !== 'pending' || url.searchParams.get('state') !== tx.oauthState) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid callback');
        return;
      }
      if (url.searchParams.get('error') || !url.searchParams.get('code')) {
        const error = authError('AI_AUTH_CALLBACK_INVALID', 'Authorization callback rejected');
        tx.response = res;
        respond(tx, 400, 'Sign in failed');
        invalidateTransaction(tx, error);
        return;
      }
      tx.status = 'claimed';
      tx.response = res;
      closeServer(tx);
      setState('exchanging');
      try {
        const tokens = await tokenRequest({
          grant_type: 'authorization_code', code: url.searchParams.get('code'),
          redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: tx.pkce.verifier,
        }, { signal: tx.controller.signal, deadline: tx.deadline });
        if (transaction !== tx || tx.status !== 'claimed' || tx.controller.signal.aborted) return;
        const credentialsValue = persistAuthenticated(recordFromTokens(tokens));
        tx.status = 'complete';
        if (tx.timer !== null) clearTimer(tx.timer);
        transaction = null;
        respond(tx, 200, 'Sign in complete. Return to GatherLocal.');
        settle(tx, 'resolve', credentialsValue);
      } catch (error) {
        if (tx.status === 'invalid') return;
        invalidateTransaction(tx, error, auth ? 'authenticated' : 'signed_out', 500, 'Sign in failed');
      }
    });
    tx.server = server;
    transaction = tx;
    setState('authorizing');
    try {
      await listen(server);
      const address = server.address?.();
      if (!address || typeof address === 'string' || !loopback(address.address)) {
        throw authError('AI_AUTH_UNAVAILABLE', 'OAuth callback did not bind loopback');
      }
    } catch (cause) {
      const error = authError('AI_AUTH_UNAVAILABLE', 'OAuth callback unavailable', { cause });
      invalidateTransaction(tx, error, auth ? 'authenticated' : 'unavailable');
      throw error;
    }
    tx.deadline = now() + OAUTH_TIMEOUT_MS;
    tx.timer = setTimer(() => {
      invalidateTransaction(tx, authError('AI_AUTH_TIMEOUT', 'Sign in timed out'));
    }, OAUTH_TIMEOUT_MS);
    const params = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: 'openid profile email offline_access', code_challenge: pkce.challenge,
      code_challenge_method: 'S256', id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true', state: oauthState, originator: 'gatherlocal',
    });
    return { url: `${issuer}/oauth/authorize?${params}`, completion };
  }

  async function rejectCredentials(expectedGeneration = generation) {
    if (!auth || expectedGeneration !== generation) return false;
    clearAuthDurably();
    return true;
  }

  function registerRequestController(controller) {
    if (!controller || typeof controller.abort !== 'function') throw new TypeError('Request controller required');
    if (disposed) controller.abort(authError('AI_ABORTED', 'Auth manager disposed'));
    requestControllers.add(controller);
    return () => requestControllers.delete(controller);
  }

  function abortRequests(reason = authError('AI_ABORTED', 'Signed out')) {
    for (const controller of requestControllers) controller.abort(reason);
    requestControllers.clear();
  }

  function logout() {
    invalidateTransaction(transaction, authError('AI_AUTH_CANCELLED', 'Sign in cancelled'));
    refreshFlight?.controller.abort(authError('AI_ABORTED', 'Signed out'));
    abortRequests();
    clearAuthDurably();
    return snapshot();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    invalidateTransaction(transaction, authError('AI_AUTH_CANCELLED', 'Sign in cancelled'));
    refreshFlight?.controller.abort(authError('AI_ABORTED', 'Auth manager disposed'));
    abortRequests(authError('AI_ABORTED', 'Auth manager disposed'));
  }

  return {
    initialize, snapshot, beginAuthorization, cancelAuthorization, logout, dispose,
    credentials, refresh, rejectCredentials, registerRequestController, abortRequests,
    get generation() { return generation; },
  };
}

module.exports = {
  AUTH_STATES, CALLBACK_PORT, CLIENT_ID, ISSUER, OAUTH_TIMEOUT_MS, REDIRECT_URI,
  createCodexOAuthAuth, createPkce, extractAccountId, parseJwtClaims,
};
