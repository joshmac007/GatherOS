# GatherLocal offline mode

GatherLocal is composed as a local app, not as an entitled GatherOS client.

## Contract

- No GatherOS login, license verification, checkout, billing portal, remote
  announcement, or GatherOS AI proxy is included in runtime composition.
- Every save entry point is available. There is no trial, free-plan save cap,
  Pro feature gate, upgrade banner, or paywall.
- AI routes are user-owned: `codex` or a local OpenAI-compatible endpoint for
  structured vision work, and Ollama for embeddings.
- Unknown AI providers fail closed. Selecting `proxy` is invalid.
- X and Instagram imports still access those services through the user's
  browser session. URL capture still accesses the URL being saved. "Offline"
  here means independent from Brett's accounts and servers, not air-gapped.

## Local AI configuration

Defaults:

```text
GATHERLOCAL_AI_STRUCTURED_PROVIDER=codex
GATHERLOCAL_AI_EMBEDDING_PROVIDER=ollama
GATHERLOCAL_AI_IMAGE_PROVIDER=disabled
```

Alternative local structured provider:

```text
GATHERLOCAL_AI_STRUCTURED_PROVIDER=local
GATHERLOCAL_LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1
GATHERLOCAL_LOCAL_VISION_MODEL=llama3.2-vision
```

Regression contract: `test/gatherlocal-offline-mode.test.js`.
