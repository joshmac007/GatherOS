# Ollama-only semantic index design

## Status

Approved design. This document defines the semantic-index provider boundary,
index lifecycle, and Settings experience. It does not authorize implementation
outside this scope.

## Goal

Give the personal GatherLocal desktop app reliable, fully local semantic search
and vector-based smart-category scoring without OpenAI Platform embedding calls
or an OpenAI-compatible embedding protocol.

## Decisions

- Ollama is the sole embedding runtime.
- The app calls Ollama's native `POST /api/embed` endpoint at
  `http://127.0.0.1:11434`.
- Default embedding model is `embeddinggemma`.
- The existing Codex subscription provider remains responsible for text and
  vision judgment: OCR, image analysis, tags, topic profiles, and category
  judgment.
- Embedding work never falls back to cloud services, OpenAI Platform APIs,
  OpenAI-compatible embedding endpoints, or another local runtime.
- Semantic indexing is background work. It must not block saves, imports, or
  ordinary library use.
- The user sees index state and queue details in Settings, not as persistent
  noise in the library UI.

## Provider boundary

```text
Codex subscription provider
  -> image analysis, OCR, tags, topic profiles, category judgment

Ollama native embedding runtime
  -> semantic search, find similar, vector scoring, category centroids
```

Codex is not an embedding provider. Ollama is not a required general-purpose
chat or vision provider for this feature.

If Ollama is unavailable, the app remains usable. Semantic capabilities pause
and Settings explains what is needed to resume them. The app must never route
that work to a remote provider.

## Ollama contract

### Request

```http
POST http://127.0.0.1:11434/api/embed
Content-Type: application/json

{"model":"embeddinggemma","input":"searchable save text"}
```

### Response

The integration accepts Ollama's native `embeddings` array and uses its first
vector for one input item. Empty, malformed, non-numeric, or dimension-mismatched
vectors are errors; they must not be stored.

### Availability

Before embedding work starts, the app verifies that Ollama is reachable and
that the configured model is installed. A missing model shows an exact setup
action, such as:

```sh
ollama pull embeddinggemma
```

The app does not download models automatically.

## Index lifecycle

### Embedding source

One deterministic searchable-text input is built from existing save metadata:

- title
- description
- tags
- extracted visible text
- topic-profile concepts and summary

This remains a retrieval representation, not an additional user-visible
content field.

### Incremental work

Each candidate save has a source hash. A save is re-embedded only when its
searchable input changes or it has no current vector for the active model.

New or changed saves enter a durable background queue. The worker processes
one item at a time to fit the available memory budget and to avoid competing
with imports and the UI.

### Index identity

Every stored vector records:

- embedding model identifier
- vector dimension
- source hash
- index generation or equivalent model-specific identity

Vectors from different models or dimensions are never compared or merged.

### Model change and rebuild

Changing the model creates a separate index generation and pauses semantic
search until an explicit rebuild completes. Old vectors remain intact until
the new index is complete. The app does not silently mix models or silently
rebuild the full library.

The rebuild can be started, paused, cancelled, and resumed. Cancellation keeps
the prior completed index available when one exists; a partial new generation
is not used for results.

## Settings experience

Settings contains a **Semantic index** section with:

```text
Ollama: Connected
Model: embeddinggemma
Index: 648 / 1,204 saves
Queue: 12 waiting · 1 indexing · 3 failed
Progress: 54%
Current: “Aviation design system reference”
```

Available actions:

- pause or resume queue processing
- retry failed items
- cancel an active rebuild
- start an explicit rebuild

An expandable queue lists each save title, state, retry count, and failure
reason. Failed items remain inspectable until retried or dismissed.

The library surface stays quiet. A small, non-blocking notice appears only when
indexing pauses unexpectedly or a rebuild completes.

## Failure behavior

- Ollama unavailable: pause queue and show a Settings error; do not fall back
  to a cloud or alternate embedding provider.
- Model missing: show the install action; do not auto-download it.
- Restart: restore durable queue and progress state, then continue only when
  Ollama is healthy.
- Transient failure: retry with capped backoff.
- Permanent failure: retain failed queue entry with reason and user action.
- Malformed or incompatible vector: reject it, retain failure evidence, and
  require an explicit rebuild when index compatibility is affected.

## Acceptance evidence

Implementation must prove:

1. Native Ollama `/api/embed` request and response parsing works.
2. No OpenAI Platform or OpenAI-compatible embedding path is used.
3. Queue state persists across app restart.
4. Pause, resume, cancel, retry, and rebuild behaviors are correct.
5. Source-hash checks prevent unchanged saves from being embedded again.
6. Model or dimension changes gate search until a valid rebuilt index exists.
7. Settings accurately renders health, progress, current work, failures, and
   queue entries.
8. Ordinary saving and importing remain usable while indexing runs.

## Explicitly out of scope

- A Login-with-ChatGPT provider.
- Server-side token custody or proxying.
- OpenAI Platform API keys or paid embedding APIs.
- LM Studio embedding support.
- Local vision/chat replacement for Codex.
- Automatic model downloading.
- Broad AI-provider refactoring unrelated to semantic indexing.
