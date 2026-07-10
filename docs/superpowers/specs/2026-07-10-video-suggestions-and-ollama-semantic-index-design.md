# Video tag suggestions and Ollama semantic index

## Status

Approved combined design. This document is the single source of truth for the
video tag-suggestion and Ollama semantic-index implementations. It supersedes
the separate video auto-tag suggestion and Ollama-only semantic-index designs.

## Goal

Add two compatible background AI workflows to GatherLocal:

1. Analyze newly imported videos through the existing Codex subscription
   provider and propose specific tags for explicit user approval.
2. Build and maintain a fully local semantic index through Ollama's native
   embedding API, without OpenAI Platform embedding calls or an
   OpenAI-compatible embedding protocol.

GatherLocal is currently a personal desktop app and may be distributed as open
source later. The base app must remain usable when either AI runtime is
unavailable.

## Product decisions

### Provider boundary

```text
Codex subscription provider
  -> video/image analysis, OCR, tags, topic profiles, category judgment

Ollama native embedding runtime
  -> semantic search, find similar, vector scoring, category centroids
```

- Video analysis uses the current Codex subscription route. It does not require
  an OpenAI Platform API key or API billing.
- Ollama is the sole embedding runtime.
- Embedding work calls native `POST /api/embed` at
  `http://127.0.0.1:11434`.
- Default embedding model is `embeddinggemma`.
- Embedding work never falls back to cloud services, OpenAI Platform APIs,
  OpenAI-compatible endpoints, or another local runtime.
- Codex is not an embedding provider. Ollama is not required for video tag
  suggestions or other Codex-backed judgment.

### User control

- Video analysis starts automatically after a new video import.
- Suggestions require explicit acceptance before becoming ordinary tags.
- Existing tags are never removed or overwritten.
- Dismissals are remembered for the same video-analysis fingerprint.
- Semantic indexing runs in the background and never blocks saving, importing,
  or ordinary library use.
- Model downloads and full index rebuilds require explicit user action.

## Shared background-work coordinator

Both domains retain separate durable queues and separate persistence. A small
main-process coordinator decides which ready job may run; it does not own
domain state or merge the two data models.

Global background concurrency is one job. This protects the personal Mac's
limited available memory and prevents frame extraction, Codex work, and Ollama
indexing from competing with each other.

Runnable jobs use this priority:

1. New video analysis.
2. Incremental semantic indexing for a new or changed save.
3. Full semantic-index rebuild/backfill work.

Foreground saves, imports, and interactive UI work always take precedence.
Long rebuilds yield between saves, allowing newly queued video or incremental
jobs to run without cancelling an in-flight embedding request.

A blocked domain never blocks the other domain. If Ollama is unavailable, the
coordinator skips paused semantic jobs and may run Codex video jobs. If Codex
is unavailable, retryable video jobs do not prevent Ollama work.

Status and IPC event names are domain-specific:

- `video-analysis:*`
- `semantic-index:*`

The new workers must not share ambiguous generic `save:indexing-*` progress
state. Existing events may be bridged during migration, but renderer state for
these workflows must remain distinct.

## Video tag suggestions

### Analysis service

Create a main-process video-analysis service with one responsibility: convert
a saved video plus available source context into validated tag suggestions. It
must not make renderer decisions, write ordinary tags, or create semantic
vectors.

For one video save, it:

1. Resolves usable video and poster paths.
2. Reads duration and extracts representative frames locally.
3. Builds one derived JPEG contact sheet.
4. Assembles one Codex provider request with visual and source context.
5. Validates output, retaining only specific, high-confidence tags.
6. Persists suggestions and analysis state.

An MP4 must never be passed to `autoTagImage`, `analyzeImage`, a topic-profile
image input, or another image-only provider method.

The existing generic save-enrichment entrypoint must branch on media kind
before any provider call. A video save bypasses its image-only vision and
topic-profile image stages, then enters the video-analysis and semantic queues
defined here. v1 does not add a second Codex call for video summaries or topic
profiles. Existing non-video enrichment behavior remains unchanged.

### Sampling and derived media

Extract 6--12 duration-aware frames at spread-out percentage timestamps. This
initial strategy avoids a scene-detection dependency while representing more
than the poster frame.

Compose frames into one JPEG contact sheet with timestamp labels. The sheet is
a derived cache artifact, not a library save. Cache it by the analysis input
fingerprint and clean it through the existing derived-media/cache policy.

The fingerprint contains:

- video content identity, using the existing content hash when available or
  file size plus modification time otherwise;
- canonical source-context text; and
- analysis prompt version.

An unchanged fingerprint is not analyzed again. Changed media, source context,
or prompt version replaces only unresolved suggestions. Accepted ordinary tags
remain untouched.

If frame extraction fails, use the existing poster JPEG as a one-image fallback
and mark that evidence as poster-based. If neither frames nor poster are usable,
persist an unavailable result and create no suggestion.

### Codex request and validation

The request includes:

- ordered frame timestamps and video duration;
- contact-sheet image;
- post text, page title, source URL/domain, and notes when present;
- existing accepted tags; and
- tag-policy instructions.

Expected structured output:

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

Validation rules:

- Prefer concise, normalized, useful tags over generic labels such as `video`,
  `clip`, or `bookmark`.
- Derive literal subjects and actions from frames.
- Use post context for intent, named entities, or relationships only when it
  agrees with frames.
- Suppress a suggestion when visual and textual evidence conflict.
- Never create a tag solely from source text when visual evidence is absent.
- Do not repeat an accepted tag or propose removing an existing tag.
- Return no suggestion for ambiguous or low-confidence claims.
- Reuse existing tag normalization and validation.

### Suggestion persistence

Video analysis owns separate durable state for:

- save ID;
- input fingerprint;
- prompt version;
- analysis status and timestamps;
- safe error detail; and
- normalized suggestion, evidence, resolution status, and resolution time.

Suggestion status is `suggested`, `accepted`, or `dismissed`. Pending work may
resume after restart only while its fingerprint remains current.

No video-analysis error path may create, delete, or modify an ordinary tag.

### Detail-view experience

The detail view receives video-suggestion state separately from its ordinary
tag list:

- `Analyzing video...` while queued or running.
- A subtle `AI suggestions` section when valid suggestions exist.
- Accept and dismiss controls per suggestion.
- `Accept all` and `Dismiss all` for the current suggestion set.
- Optional evidence wording such as `visual` or `visual + post context`, with
  no numerical confidence display.

Accepting uses the existing ordinary-tag path, then marks the suggestion
accepted. Dismissing records the decision. The grid, ordinary tags, and search
results do not change merely because an unresolved suggestion exists.

## Ollama semantic index

### Native Ollama contract

Request:

```http
POST http://127.0.0.1:11434/api/embed
Content-Type: application/json

{"model":"embeddinggemma","input":"searchable save text"}
```

Use the first vector in Ollama's native `embeddings` array for a single input.
Empty, malformed, non-numeric, or dimension-mismatched vectors are rejected and
must not be stored.

Before work starts, verify that Ollama is reachable and that the configured
model is installed. A missing model shows the exact setup action:

```sh
ollama pull embeddinggemma
```

GatherLocal does not download the model automatically.

### Canonical searchable text

One deterministic builder owns semantic input for every save type. It may use
existing persisted metadata:

- title and description;
- notes or canonical source-post text;
- accepted ordinary tags;
- extracted visible text; and
- topic-profile concepts and summary.

Unresolved or dismissed video suggestions are never semantic input. Accepting
a suggestion first creates an ordinary tag; that tag then participates in the
same canonical source as any manually added tag.

The video contact sheet, raw MP4 bytes, suggestion evidence, and suggestion
confidence are not embedded.

### Incremental indexing

Each candidate save has a semantic source hash. A save is re-embedded only when
its canonical text changes or it has no current vector for the active index.

New and changed saves enter the durable semantic queue. The worker embeds one
save per coordinator job.

Accepting a video suggestion changes the ordinary-tag set, invalidates the
source hash, and enqueues one coalesced incremental embedding job. Dismissing a
suggestion does not change the source hash or enqueue embedding work. Multiple
tag changes before processing coalesce into one job using the latest source.

### Index identity and rebuilds

Every stored vector records:

- embedding model identifier;
- vector dimension;
- source hash; and
- index generation or equivalent model-specific identity.

Vectors from different models or dimensions are never compared or merged.

Changing the model creates a separate index generation and pauses semantic
search until an explicit rebuild completes. Old vectors remain intact until
the new generation is complete. A partial generation is never used for
results.

Rebuilds support start, pause, resume, and cancel. Pause retains resumable
progress. Cancel discards the partial new generation and keeps the prior
completed index available when one exists.

### Settings experience

Settings contains a **Semantic index** section:

```text
Ollama: Connected
Model: embeddinggemma
Index: 648 / 1,204 saves
Queue: 12 waiting · 1 indexing · 3 failed
Progress: 54%
Current: “Aviation design system reference”
```

Actions:

- pause or resume semantic queue processing;
- retry failed semantic items;
- cancel an active rebuild; and
- start an explicit rebuild.

An expandable semantic queue lists each save title, state, retry count, and
failure reason. It does not mix video-analysis jobs into semantic progress.
Failed items remain visible until retried or dismissed.

The library stays quiet. A small non-blocking notice appears only when semantic
indexing pauses unexpectedly or a rebuild completes.

## Combined data flow

```text
video import completes
  -> persist save
  -> enqueue video analysis (priority 1)
  -> enqueue/coalesce semantic indexing (priority 2)
  -> coordinator runs video frame/contact-sheet job
  -> Codex returns validated tag suggestions
  -> persist unresolved suggestions outside ordinary tags
  -> coordinator runs Ollama embedding from canonical persisted text

user accepts suggestion
  -> existing ordinary-tag path
  -> mark suggestion accepted
  -> semantic source hash changes
  -> enqueue/coalesce one incremental Ollama embedding job
```

The initial video embedding may use persisted source context and other existing
metadata. It does not wait for a suggestion decision. Later acceptance enriches
the vector through normal incremental indexing.

## Failure behavior

| Condition | Result |
| --- | --- |
| Frame extraction fails, poster exists | Analyze poster fallback; mark poster evidence. |
| No usable frame or poster | Persist video unavailable state; show no suggestion. |
| Codex unavailable/auth fails | Persist retryable video failure; allow semantic work to continue. |
| Invalid Codex JSON | Persist video failure; render no guesses. |
| Ollama unavailable | Pause semantic jobs; allow video work and ordinary library use. |
| Embedding model missing | Show install action; do not auto-download or cloud-fallback. |
| Malformed/incompatible vector | Reject vector and retain safe failure evidence. |
| App exits during work | Restore valid domain jobs; coordinator resumes by priority. |
| Suggestion dismissed | Persist dismissal; do not change semantic source. |
| Suggestion accepted | Create ordinary tag and coalesce incremental re-indexing. |

Transient failures retry with capped backoff. Permanent failures remain
inspectable in their owning domain. A failed or paused job in one domain must
not stall runnable work in the other.

## Verification plan

### Video analysis

- Unit-test media resolution and prove MP4 exclusion from image-only calls.
- Unit-test timestamps and contact-sheet request construction with a mocked
  extractor.
- Contract-test contextual prompt input, structured-output validation,
  generic-tag filtering, duplicate suppression, and conflict suppression.
- Test video states: pending, analyzing, suggested, accepted, dismissed,
  unavailable, and retryable failure.
- Test accept/dismiss UI and prove ordinary tags change only after acceptance.
- Regression-test ordinary image auto-tag behavior and poster fallback.

### Semantic index

- Test native Ollama `/api/embed` request and response parsing.
- Assert no OpenAI Platform or OpenAI-compatible embedding call path exists.
- Test queue persistence, pause, resume, cancel, retry, and rebuild.
- Test source-hash incremental updates and same-save job coalescing.
- Test model/dimension isolation and rebuild gating.
- Test Settings health, progress, current item, failures, and queue entries.
- Prove saving and importing remain usable while indexing runs.

### Cross-workflow compatibility

- Prove global background concurrency never exceeds one.
- Prove priority ordering and rebuild yielding between saves.
- Prove Ollama downtime does not block video analysis.
- Prove Codex downtime does not block semantic indexing.
- Prove unresolved/dismissed suggestions never affect semantic input.
- Prove accepted suggestions enqueue one coalesced semantic update.
- Prove video and semantic status events cannot overwrite each other.
- Test restart with pending jobs in both domains.
- Run relevant AI tests and renderer build before handoff.

## Explicitly out of scope

- Speech transcription or audio analysis.
- Multi-call video reasoning.
- Automatic application of AI tags.
- Video summaries or OCR-specific video UI.
- Automatic re-analysis of the existing video library on rollout.
- A new tag vocabulary or taxonomy system.
- Login-with-ChatGPT integration or server-side token custody.
- OpenAI Platform API keys or paid embedding APIs.
- OpenAI-compatible or LM Studio embedding support.
- Local vision/chat replacement for Codex.
- Automatic model downloading.
- Broad provider, queue, or schema refactoring unrelated to these workflows.

## Implementation boundary

Implementation may add the narrow coordinator, domain persistence, services,
IPC, and UI required above. It must preserve existing tag semantics, Codex
authentication, smart-category policy, import behavior, and ordinary image
auto-tagging.

No implementation is complete without targeted tests proving both domain
contracts and their interaction.
