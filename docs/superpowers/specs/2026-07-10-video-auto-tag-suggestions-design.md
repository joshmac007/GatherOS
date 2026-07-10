# Video auto-tag suggestions v1

**Status:** Design approved; implementation planning awaits review of this spec.

## Problem

Video saves store an MP4 at `file_path` and a JPEG poster at `thumb_path`.
Current auto-tag IPC sends the MP4 to the image-only Codex provider. That
produces an unsupported-image-format error and ignores available temporal
signal and post context.

## Outcome

Every newly imported video is analyzed automatically without blocking import.
GatherLocal proposes a small set of specific, high-confidence tags. Nothing
becomes a real tag until the user accepts it.

## Confirmed product decisions

- Analysis starts automatically after video import.
- Analysis considers both video media and source-post context.
- Visual evidence is primary. Post text can refine meaning only when it fits
  the media; visual and textual conflict suppresses the suggestion.
- Output is tag suggestions only: no video summary.
- Only specific, high-confidence suggestions are shown.
- Suggestions require explicit acceptance. Dismissals are remembered.
- Existing user tags are never removed or overwritten.
- v1 uses the existing Codex subscription vision route. It does not require an
  OpenAI Platform API key or API billing.

## Non-goals

- Speech transcription or audio analysis.
- Multi-call video reasoning.
- Automatic application of any AI tag.
- Re-analysis of the existing library on rollout.
- Video summaries, OCR-specific UI, or a new taxonomy system.

## Architecture

### 1. Video analysis service

Create a main-process video-analysis service with one responsibility: convert
a saved video plus its available context into validated tag suggestions. It
must not make renderer decisions or write ordinary tags.

For a video save, it:

1. Resolves usable video and poster paths.
2. Reads duration and extracts representative frames locally.
3. Builds one derived JPEG contact sheet.
4. Assembles a provider request with visual and source context.
5. Validates provider output, keeping only high-confidence, specific tags.
6. Persists suggestions and analysis state.

The service must not pass an MP4 directly to `autoTagImage` or another
image-only provider method.

### 2. Sampling and derived media

v1 extracts 6--12 frames at duration-aware, spread-out timestamps. Fixed
percentage sampling is the initial strategy; it avoids a scene-detection
dependency while representing more than the poster frame.

Frames compose into one contact-sheet JPEG with timestamp labels. The sheet is
a derived cache artifact, not a user library save. Cache it by analysis input
fingerprint and clean it using the application's existing derived-media/cache
policy.

Input fingerprint contains:

- video content identity (existing content hash when available; otherwise file
  size and modification time);
- canonical source-context text; and
- analysis prompt version.

No re-analysis occurs for an unchanged fingerprint. A changed source, context,
or prompt version produces a new analysis and replaces unresolved suggestions.

If frame extraction fails, use the existing poster JPEG as a one-image fallback
and mark its evidence accordingly. If neither video frames nor poster are
usable, record an unavailable result; create no suggestion.

### 3. Provider contract

Use the current Codex-subscription provider with a supported contact-sheet
image input. The request includes:

- ordered frame timestamps and video duration;
- contact-sheet image;
- post text, page title, source URL/domain, and notes when present;
- existing accepted tags; and
- tag-policy instructions.

The provider returns strict structured data:

```json
{
  "tags": [
    {
      "name": "patio renovation",
      "confidence": "high",
      "evidence": ["visual", "post_context"]
    }
  ],
  "warnings": []
}
```

Prompt policy:

- Prefer concise, normalized, useful tags over generic labels such as `video`,
  `clip`, or `bookmark`.
- Derive literal subjects/actions from frames.
- Use post context for intent, named entities, or relationships only when it
  agrees with frames.
- Do not create a tag solely from source text when visual evidence conflicts
  or is absent.
- Do not repeat an accepted tag or propose removal of an existing tag.
- Return no tag for ambiguous or low-confidence claims.

Reuse existing tag normalization and validation rather than introduce a second
tag vocabulary.

### 4. Persistence and queue

Add a small, explicit persistence contract for analysis state and suggestions.
It separates AI proposals from ordinary tags and survives restart.

Analysis state records save ID, fingerprint, prompt version, status, timestamps,
and safe error detail. Suggestion rows record save ID, normalized tag, evidence,
status (`suggested`, `accepted`, or `dismissed`), and resolution timestamp.

After a successful video import, enqueue analysis at low priority. Import
returns immediately. Process one video analysis at a time so frame extraction
and Codex work do not compete with browsing/import activity. Pending work can
resume after restart only when its fingerprint remains current.

Transient provider failures remain retryable; unavailable media and malformed
provider output become non-destructive failed states. No error path may create,
delete, or modify ordinary tags.

### 5. UI contract

The active detail view receives an AI-suggestions state separate from its tag
list:

- `Analyzing video...` while queued or running.
- A subtle `AI suggestions` section when high-confidence suggestions exist.
- Per-suggestion accept and dismiss controls.
- `Accept all` and `Dismiss all` for the current suggestion set.
- Optional evidence wording such as `visual` or `visual + post context`; no
  numerical confidence display.

Accepting uses the existing ordinary-tag path, then marks its suggestion
accepted. Dismissing records the decision and suppresses future repetition for
the same input fingerprint. The library grid, tags, and search results do not
change until acceptance.

## Data flow

```text
video import completes
  -> low-priority analysis queue
  -> local frame sampling/contact sheet
  -> Codex vision request with post context
  -> validate high-confidence output
  -> persist suggestions
  -> detail-panel review
  -> explicit accept creates ordinary tag
```

## Error handling

| Condition | Result |
| --- | --- |
| Frame extraction fails, poster exists | Analyze poster fallback; identify visual basis as poster. |
| No usable frame or poster | Persist unavailable state; show no tag suggestion. |
| Codex unavailable/auth fails | Persist safe retryable failure; do not touch tags. |
| Invalid provider JSON | Persist failure; do not render guesses. |
| App exits during work | Preserve/requeue valid pending job on next launch. |
| User dismisses suggestion | Persist dismissal; do not resurface for same fingerprint. |

## Verification plan

- Unit-test media-source resolution and MP4 exclusion from image-only calls.
- Unit-test timestamp sampling and contact-sheet request construction using a
  mocked extractor.
- Contract-test contextual prompt payload, structured-output validation,
  generic-tag filtering, duplicate suppression, and conflict suppression.
- Test queue/state transitions: pending, analyzing, suggested, accepted,
  dismissed, unavailable, retryable failure.
- Test accept/dismiss UI behavior and prove normal tags change only after
  acceptance.
- Regression-test ordinary image auto-tag behavior and video poster fallback.
- Run relevant AI tests and renderer build before implementation handoff.

## Implementation boundary

This spec intentionally defines a video-specific analysis path and a narrow
suggestion-review contract. It does not alter existing tag semantics, provider
authentication, smart-category scoring, or API-provider architecture.
