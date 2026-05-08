-- Image generation lives on a separate cost axis from chat / embed
-- (per-image, not per-token), so it gets its own counter on the
-- monthly usage row instead of being lumped into total_tokens.
-- A separate soft cap can then be enforced + surfaced in the UI
-- without misleading users about either dimension.

ALTER TABLE ai_usage_monthly
  ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;
