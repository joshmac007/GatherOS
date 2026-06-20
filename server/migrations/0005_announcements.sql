-- In-app announcements — a single broadcast banner/popup the app fetches
-- and renders. Lets us push a notice (an incident, a heads-up, a longform
-- update) to every running copy of GatherOS without shipping a release.
--
-- Each publish inserts a NEW row with a fresh id. The app remembers the
-- last id the user dismissed, so a brand-new announcement re-surfaces even
-- if they dismissed the previous one. GET returns the single most recent
-- row; if that row is inactive or expired, the app shows nothing — so
-- "taking it down" is just publishing a row with active = 0.

CREATE TABLE announcements (
  id          TEXT PRIMARY KEY,
  -- Heading (optional). Body copy (required) — newlines are preserved by
  -- the client so it handles a one-liner or longform text.
  title       TEXT,
  body        TEXT NOT NULL,
  -- 'info' | 'warning' | 'incident' — drives the client's styling.
  level       TEXT NOT NULL DEFAULT 'info',
  -- Optional call-to-action link rendered under the body.
  cta_label   TEXT,
  cta_url     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  -- Optional epoch-ms expiry; once past, the client hides it.
  expires_at  INTEGER
);

CREATE INDEX idx_announcements_created ON announcements (created_at DESC);
