'use strict';

const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require('node:child_process');
const { CAPABILITIES } = require('./config');
const { parseJsonObject, runtimeError, timeoutValue } = require('./transport-utils');

const PROVIDER = 'codex';

function preflight(config, dependencies = {}) {
  const spawnSync = dependencies.spawnSync || defaultSpawnSync;
  let result;
  try {
    result = spawnSync(config.bin, ['login', 'status'], {
      cwd: config.cwd,
      env: config.env || process.env,
      encoding: 'utf8',
      timeout: Math.min(timeoutValue(config.timeoutMs, 120000), 5000),
    });
  } catch (cause) {
    throw runtimeError('AI_PROVIDER_UNAVAILABLE', 'Codex login status could not be checked', {
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider: PROVIDER,
      retryable: true,
      cause,
    });
  }
  if (result?.error?.code === 'ENOENT') {
    throw runtimeError('AI_PROVIDER_UNAVAILABLE', 'Codex CLI was not found', {
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider: PROVIDER,
      retryable: false,
      cause: result.error,
    });
  }
  if (result?.error) {
    throw runtimeError('AI_AUTH_REQUIRED', 'Codex login is required', {
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider: PROVIDER,
      retryable: false,
      cause: result.error,
    });
  }
  if (result?.status !== 0) {
    throw runtimeError('AI_AUTH_REQUIRED', 'Codex login is required', {
      capability: CAPABILITIES.STRUCTURED_JSON,
      provider: PROVIDER,
      retryable: false,
    });
  }
  return true;
}

function messageText(message) {
  const item = message?.params?.item;
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.message === 'string') return item.message;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  if (Array.isArray(item.message?.content)) {
    return item.message.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  return '';
}

function createCodexStructuredAdapter(config = {}, dependencies = {}) {
  const bin = typeof config.bin === 'string' && config.bin.trim() ? config.bin.trim() : 'codex';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const cwd = typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd : process.cwd();
  const timeoutMs = timeoutValue(config.timeoutMs, 120000);
  const spawn = dependencies.spawn || defaultSpawn;

  function configured() {
    return Boolean(bin);
  }

  async function runTurn({ system = '', input = '', imagePath, signal } = {}) {
    if (signal?.aborted) {
      throw runtimeError('AI_ABORTED', 'Codex request was aborted', {
        capability: CAPABILITIES.STRUCTURED_JSON,
        provider: PROVIDER,
        retryable: false,
      });
    }
    preflight({ bin, cwd, model, timeoutMs, env: config.env }, dependencies);
    if (signal?.aborted) {
      throw runtimeError('AI_ABORTED', 'Codex request was aborted', {
        capability: CAPABILITIES.STRUCTURED_JSON,
        provider: PROVIDER,
        retryable: false,
      });
    }

    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(bin, ['app-server'], {
          cwd,
          env: config.env || process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (cause) {
        reject(runtimeError('AI_PROVIDER_UNAVAILABLE', 'Codex app-server could not start', {
          capability: CAPABILITIES.STRUCTURED_JSON,
          provider: PROVIDER,
          retryable: true,
          cause,
        }));
        return;
      }

      let nextId = 1;
      let threadId = null;
      let output = '';
      let sawDelta = false;
      let stderr = '';
      let lineBuffer = '';
      let settled = false;
      const pending = new Map();
      const timer = setTimeout(() => finish(runtimeError('AI_TIMEOUT', 'Codex request timed out', {
        capability: CAPABILITIES.STRUCTURED_JSON,
        provider: PROVIDER,
        retryable: true,
      })), timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      }

      function terminate() {
        try { proc.kill('SIGTERM'); } catch {}
      }

      function finish(error, value) {
        if (settled) return;
        settled = true;
        cleanup();
        for (const waiter of pending.values()) waiter.reject(error || new Error('Codex request finished'));
        pending.clear();
        terminate();
        if (error) reject(error);
        else resolve(value);
      }

      function onAbort() {
        finish(runtimeError('AI_ABORTED', 'Codex request was aborted', {
          capability: CAPABILITIES.STRUCTURED_JSON,
          provider: PROVIDER,
          retryable: false,
        }));
      }

      function send(message) {
        try {
          proc.stdin.write(`${JSON.stringify(message)}\n`);
        } catch (cause) {
          finish(runtimeError('AI_PROVIDER_UNAVAILABLE', 'Codex app-server write failed', {
            capability: CAPABILITIES.STRUCTURED_JSON,
            provider: PROVIDER,
            retryable: true,
            cause,
          }));
        }
      }

      function request(method, params = {}) {
        const id = nextId++;
        const promise = new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        });
        send({ method, id, params });
        return promise;
      }

      function notify(method, params = {}) {
        send({ method, params });
      }

      function handle(message) {
        if (typeof message.id === 'number') {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(runtimeError('AI_PROVIDER_UNAVAILABLE', message.error.message || 'Codex RPC error', {
            capability: CAPABILITIES.STRUCTURED_JSON,
            provider: PROVIDER,
            retryable: true,
          }));
          else waiter.resolve(message.result || {});
          return;
        }
        if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
          sawDelta = true;
          output += message.params.delta;
          return;
        }
        if (message.method === 'item/completed' && !sawDelta) output += messageText(message);
        if (message.method === 'turn/completed') {
          const turn = message.params?.turn || message.params || {};
          if (turn.threadId && threadId && turn.threadId !== threadId) return;
          if (turn.status === 'failed' || turn.status === 'error') {
            finish(runtimeError('AI_PROVIDER_UNAVAILABLE', turn.error?.message || 'Codex turn failed', {
              capability: CAPABILITIES.STRUCTURED_JSON,
              provider: PROVIDER,
              retryable: true,
            }));
          } else {
            const turnOutput = typeof turn.output === 'string' ? turn.output : '';
            finish(null, output || turnOutput);
          }
        }
      }

      function onData(chunk) {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { handle(JSON.parse(line)); } catch {}
        }
      }

      signal?.addEventListener?.('abort', onAbort, { once: true });
      proc.stdout?.on?.('data', onData);
      proc.stderr?.on?.('data', (chunk) => { stderr += chunk.toString(); });
      proc.on?.('error', (cause) => finish(runtimeError('AI_PROVIDER_UNAVAILABLE', 'Codex app-server failed', {
        capability: CAPABILITIES.STRUCTURED_JSON,
        provider: PROVIDER,
        retryable: true,
        cause,
      })));
      proc.on?.('exit', (code) => {
        if (settled) return;
        if (code !== 0) finish(runtimeError('AI_PROVIDER_UNAVAILABLE', stderr.trim() || `Codex exited with code ${code}`, {
          capability: CAPABILITIES.STRUCTURED_JSON,
          provider: PROVIDER,
          retryable: true,
        }));
        else finish(runtimeError('AI_INVALID_RESPONSE', 'Codex app-server ended before completing turn', {
          capability: CAPABILITIES.STRUCTURED_JSON,
          provider: PROVIDER,
          retryable: false,
        }));
      });

      (async () => {
        try {
          await request('initialize', {
            clientInfo: { name: 'gatherlocal', title: 'GatherLocal', version: '0.1.0' },
          });
          notify('initialized');
          const threadParams = {
            cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            serviceName: 'gatherlocal',
            ephemeral: true,
          };
          if (model) threadParams.model = model;
          const thread = await request('thread/start', threadParams);
          threadId = thread.thread?.id;
          if (!threadId) throw runtimeError('AI_INVALID_RESPONSE', 'Codex did not return a thread id', {
            capability: CAPABILITIES.STRUCTURED_JSON,
            provider: PROVIDER,
            retryable: false,
          });
          const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
          const instruction = typeof system === 'string' && system ? `${system}\n\n${text}` : text;
          await request('turn/start', {
            threadId,
            input: [
              { type: 'text', text: instruction },
              ...(imagePath ? [{ type: 'localImage', path: imagePath }] : []),
            ],
          });
        } catch (cause) {
          if (cause?.name === 'AiRuntimeError' || typeof cause?.code === 'string' && cause.code.startsWith('AI_')) finish(cause);
          else finish(runtimeError('AI_PROVIDER_UNAVAILABLE', 'Codex turn could not start', {
            capability: CAPABILITIES.STRUCTURED_JSON,
            provider: PROVIDER,
            retryable: true,
            cause,
          }));
        }
      })();
    });
  }

  return {
    id: PROVIDER,
    model,
    isConfigured: configured,
    async health() {
      preflight({ bin, cwd, model, timeoutMs, env: config.env }, dependencies);
      return { ok: true, provider: PROVIDER, model: model || null };
    },
    async completeJson(args = {}) {
      const text = await runTurn(args);
      return parseJsonObject(text, PROVIDER, CAPABILITIES.STRUCTURED_JSON);
    },
  };
}

module.exports = {
  createCodexStructuredAdapter,
  preflightCodexLogin: preflight,
};
