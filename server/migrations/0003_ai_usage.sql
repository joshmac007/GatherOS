-- AI proxy usage tracking. One row per (user, month) — every /ai/*
-- call upserts into the corresponding row, summing tokens and bumping
-- the request counter. We keep prompt + completion (chat) and embed
-- tokens broken out so a future dashboard can show a useful split,
-- but enforce the soft cap against total_tokens.

CREATE TABLE IF NOT EXISTS ai_usage_monthly (
  user_id TEXT NOT NULL,
  yyyymm TEXT NOT NULL,                    -- "2026-05"
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  embedding_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0, -- prompt + completion + embedding
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, yyyymm)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_monthly (user_id);
