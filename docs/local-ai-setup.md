# GatherLocal AI Setup

GatherLocal does not use OpenAI Platform API keys by default. AI runs through
one of two desktop providers.

## Codex Subscription Provider

Use this when you want ChatGPT/Codex subscription auth.

```bash
npm install -g @openai/codex@latest
codex login
```

Then launch GatherLocal normally. This is the default provider:

```bash
GATHERLOCAL_AI_PROVIDER=codex npm run dev
```

Codex provider supports:

- Auto-name screenshots
- Screenshot descriptions and visible text extraction
- Auto-tagging
- Image prompt generation

Codex provider does not expose:

- Vector embeddings for semantic search
- Raw image-generation bytes for variations

For those, use local provider below.

## Local Model Provider

Use this when you want on-device models, usually through Ollama or LM Studio.

Example Ollama setup:

```bash
ollama pull llama3.2-vision
ollama pull nomic-embed-text
GATHERLOCAL_AI_PROVIDER=local npm run dev
```

Default local settings:

```bash
GATHERLOCAL_LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1
GATHERLOCAL_LOCAL_CHAT_MODEL=llama3.2-vision
GATHERLOCAL_LOCAL_EMBED_MODEL=nomic-embed-text
```

LM Studio example:

```bash
GATHERLOCAL_AI_PROVIDER=local \
GATHERLOCAL_LOCAL_AI_BASE_URL=http://127.0.0.1:1234/v1 \
GATHERLOCAL_LOCAL_CHAT_MODEL=your-vision-model \
GATHERLOCAL_LOCAL_EMBED_MODEL=your-embedding-model \
npm run dev
```

Local provider supports semantic search when the configured server exposes
`/v1/embeddings`.

Image variations are disabled until a local image-generation endpoint is wired.
