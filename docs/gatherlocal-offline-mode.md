# GatherLocal offline mode

GatherLocal is composed as a local app, not as an entitled GatherOS client.

## Contract

- No GatherOS login, license verification, checkout, billing portal, remote
  announcement, or GatherOS AI proxy is included in runtime composition.
- Every save entry point is available. There is no trial, free-plan save cap,
  Pro feature gate, upgrade banner, or paywall.
- AI routes are user-owned: ChatGPT Codex or a local OpenAI-compatible endpoint
  for structured vision work, and Ollama for embeddings.
- Unknown AI providers fail closed. Selecting `proxy` is invalid.
- X and Instagram imports still access those services through the user's
  browser session. URL capture still accesses the URL being saved. "Offline"
  here means independent from Brett's accounts and servers, not air-gapped.

## Local AI configuration

ChatGPT Codex is the default structured provider. It opens OpenAI OAuth only after
the user clicks **Connect**. Its callback is exactly
`http://localhost:1455/auth/callback`; GatherLocal does not register a custom-protocol
OAuth callback. OAuth token ciphertext is encrypted through Electron `safeStorage`
backed by macOS Keychain. Tokens go only to `auth.openai.com` and `chatgpt.com`.
Images and text needed by enabled AI features go directly to OpenAI. Credentials
are excluded from GatherLocal exports and snapshots, though system backups may
include encrypted ciphertext. Logging out removes stored credentials.

Optional Codex tuning:

```text
GATHERLOCAL_CODEX_MODEL=gpt-5.6-luna
GATHERLOCAL_CODEX_TIMEOUT_MS=120000
GATHERLOCAL_CODEX_MAX_IMAGE_BYTES=2097152
```

Settings shows aggregate requests and tokens observed by GatherLocal on this Mac.
This local ledger contains counts only, not prompts, images, responses, or OAuth
credentials. It is not a ChatGPT plan quota and cannot show remaining allowance.

Alternative local structured provider:

```text
GATHERLOCAL_AI_STRUCTURED_PROVIDER=local
GATHERLOCAL_LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1
GATHERLOCAL_LOCAL_VISION_MODEL=llama3.2-vision
```

Regression contract: `test/gatherlocal-offline-mode.test.js`.
