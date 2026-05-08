// AI proxy. The desktop app used to require BYOK (bring-your-own-key)
// for OpenAI features. With this proxy the Worker holds the master
// key and forwards requests on behalf of any session whose license is
// entitled. Usage is metered per-user-per-month into ai_usage_monthly,
// with a soft cap that warns but does not block (fail-open).
//
// Routes:
//   POST /ai/chat   { model, messages, response_format?, max_tokens? }
//   POST /ai/embed  { input, model? }
//   GET  /ai/usage   → { yyyymm, total_tokens, request_count, soft_cap, over_cap }

import { Hono, type Context } from 'hono';
import type { Env } from './types';
import { bearer, userFromSession } from './auth';

type AiContext = Context<{ Bindings: Env }>;

export const aiRoutes = new Hono<{ Bindings: Env }>();

// Soft monthly cap (combined chat + embedding tokens). Over the cap we
// keep serving requests but flag the response so the renderer can warn
// the user. Tuned for an "average" power user: ~2000 saves analyzed +
// many semantic searches stays comfortably under this.
const MONTHLY_TOKEN_CAP = 4_000_000;

// Allowlists keep the proxy from being abused as a generic OpenAI
// gateway. Anything not on these lists is rejected with 400.
const ALLOWED_CHAT_MODELS = new Set(['gpt-4o-mini', 'gpt-4o']);
const ALLOWED_EMBED_MODELS = new Set(['text-embedding-3-small']);

const OPENAI_BASE = 'https://api.openai.com/v1';

type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'canceled';

const ENTITLED_SUB_STATUSES = new Set<SubscriptionStatus>([
  'active',
  'past_due',
  'trialing',
]);

function yyyymm(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
}

// Authenticated + entitled user, or a Response to return immediately.
async function requireEntitled(
  c: AiContext,
): Promise<{ userId: string } | Response> {
  const token = bearer(c.req.header('Authorization'));
  if (!token) return c.json({ ok: false, error: 'unauthenticated' }, 401);
  const user = await userFromSession(c.env, token);
  if (!user) return c.json({ ok: false, error: 'unauthenticated' }, 401);

  const now = Date.now();
  const sub = await c.env.DB.prepare(
    `SELECT status FROM subscriptions
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
  )
    .bind(user.id)
    .first<{ status: SubscriptionStatus }>();
  const inTrial = user.trial_ends_at > now;
  const entitled = (sub && ENTITLED_SUB_STATUSES.has(sub.status)) || inTrial;
  if (!entitled) return c.json({ ok: false, error: 'not_entitled' }, 402);

  return { userId: user.id };
}

interface UsageRow {
  prompt_tokens: number;
  completion_tokens: number;
  embedding_tokens: number;
  total_tokens: number;
  request_count: number;
}

async function readUsage(
  env: Env,
  userId: string,
  bucket: string,
): Promise<UsageRow> {
  const row = await env.DB.prepare(
    `SELECT prompt_tokens, completion_tokens, embedding_tokens,
            total_tokens, request_count
       FROM ai_usage_monthly
      WHERE user_id = ? AND yyyymm = ?`,
  )
    .bind(userId, bucket)
    .first<UsageRow>();
  return (
    row || {
      prompt_tokens: 0,
      completion_tokens: 0,
      embedding_tokens: 0,
      total_tokens: 0,
      request_count: 0,
    }
  );
}

async function recordUsage(
  env: Env,
  userId: string,
  bucket: string,
  delta: { prompt: number; completion: number; embedding: number },
): Promise<void> {
  const total = delta.prompt + delta.completion + delta.embedding;
  const now = Date.now();
  // Upsert: insert a fresh row at zero, then add the delta. SQLite
  // (D1) supports ON CONFLICT … DO UPDATE for primary-key collisions.
  await env.DB.prepare(
    `INSERT INTO ai_usage_monthly
       (user_id, yyyymm,
        prompt_tokens, completion_tokens, embedding_tokens,
        total_tokens, request_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, yyyymm) DO UPDATE SET
       prompt_tokens     = prompt_tokens     + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens,
       embedding_tokens  = embedding_tokens  + excluded.embedding_tokens,
       total_tokens      = total_tokens      + excluded.total_tokens,
       request_count     = request_count     + 1,
       updated_at        = excluded.updated_at`,
  )
    .bind(
      userId,
      bucket,
      delta.prompt,
      delta.completion,
      delta.embedding,
      total,
      now,
    )
    .run()
    .catch((err) => {
      // Telemetry shouldn't break the request — log and move on.
      console.error('[ai] recordUsage failed:', err);
    });
}

aiRoutes.post('/chat', async (c) => {
  const auth = await requireEntitled(c);
  if (auth instanceof Response) return auth;

  type ChatBody = {
    model?: string;
    messages?: unknown;
    response_format?: unknown;
    max_tokens?: number;
  };
  const body: ChatBody = await c.req.json<ChatBody>().catch(() => ({}));

  const model = body.model || 'gpt-4o-mini';
  if (!ALLOWED_CHAT_MODELS.has(model)) {
    return c.json({ ok: false, error: 'model_not_allowed' }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ ok: false, error: 'missing_messages' }, 400);
  }

  // Forward to OpenAI verbatim so the caller controls every field
  // (response_format, image_url detail, max_tokens, etc.) without the
  // proxy needing to know about each variant.
  const upstream = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: body.messages,
      response_format: body.response_format,
      max_tokens: body.max_tokens,
    }),
  }).catch((err) => {
    console.error('[ai] chat upstream network error:', err);
    return null;
  });
  if (!upstream) return c.json({ ok: false, error: 'upstream_network' }, 502);

  const data = (await upstream.json().catch(() => ({}))) as {
    choices?: unknown;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    error?: { message?: string };
  };

  if (!upstream.ok) {
    return c.json(
      {
        ok: false,
        error: 'upstream_error',
        status: upstream.status,
        detail: data.error?.message,
      },
      502,
    );
  }

  const usage = data.usage || {};
  const bucket = yyyymm(Date.now());
  await recordUsage(c.env, auth.userId, bucket, {
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    embedding: 0,
  });
  const after = await readUsage(c.env, auth.userId, bucket);

  return c.json({
    ok: true,
    choices: data.choices,
    usage: data.usage,
    quota: {
      total_tokens: after.total_tokens,
      soft_cap: MONTHLY_TOKEN_CAP,
      over_cap: after.total_tokens > MONTHLY_TOKEN_CAP,
    },
  });
});

aiRoutes.post('/embed', async (c) => {
  const auth = await requireEntitled(c);
  if (auth instanceof Response) return auth;

  type EmbedBody = { input?: string | string[]; model?: string };
  const body: EmbedBody = await c.req.json<EmbedBody>().catch(() => ({}));

  const model = body.model || 'text-embedding-3-small';
  if (!ALLOWED_EMBED_MODELS.has(model)) {
    return c.json({ ok: false, error: 'model_not_allowed' }, 400);
  }
  if (
    body.input == null ||
    (typeof body.input !== 'string' && !Array.isArray(body.input))
  ) {
    return c.json({ ok: false, error: 'missing_input' }, 400);
  }

  const upstream = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: body.input }),
  }).catch((err) => {
    console.error('[ai] embed upstream network error:', err);
    return null;
  });
  if (!upstream) return c.json({ ok: false, error: 'upstream_network' }, 502);

  const data = (await upstream.json().catch(() => ({}))) as {
    data?: unknown;
    usage?: { total_tokens?: number; prompt_tokens?: number };
    error?: { message?: string };
  };

  if (!upstream.ok) {
    return c.json(
      {
        ok: false,
        error: 'upstream_error',
        status: upstream.status,
        detail: data.error?.message,
      },
      502,
    );
  }

  // Embedding API reports usage as prompt_tokens (no completion).
  const tokens = data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0;
  const bucket = yyyymm(Date.now());
  await recordUsage(c.env, auth.userId, bucket, {
    prompt: 0,
    completion: 0,
    embedding: tokens,
  });
  const after = await readUsage(c.env, auth.userId, bucket);

  return c.json({
    ok: true,
    data: data.data,
    usage: data.usage,
    quota: {
      total_tokens: after.total_tokens,
      soft_cap: MONTHLY_TOKEN_CAP,
      over_cap: after.total_tokens > MONTHLY_TOKEN_CAP,
    },
  });
});

aiRoutes.get('/usage', async (c) => {
  const auth = await requireEntitled(c);
  if (auth instanceof Response) return auth;

  const bucket = yyyymm(Date.now());
  const row = await readUsage(c.env, auth.userId, bucket);
  return c.json({
    ok: true,
    yyyymm: bucket,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    embedding_tokens: row.embedding_tokens,
    total_tokens: row.total_tokens,
    request_count: row.request_count,
    soft_cap: MONTHLY_TOKEN_CAP,
    over_cap: row.total_tokens > MONTHLY_TOKEN_CAP,
  });
});
