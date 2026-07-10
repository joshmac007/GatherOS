# GatherLocal AI setup

GatherLocal uses two independent desktop AI runtimes. Neither path needs an
OpenAI Platform API key.

## Codex subscription

Codex handles judgment work: image and video analysis, visible-text extraction,
tag suggestions, topic profiles, and smart-category fallback decisions.

```sh
npm install -g @openai/codex@latest
codex login
npm run dev
```

Video analysis uses the signed-in Codex subscription. GatherLocal extracts
representative frames locally, sends one derived JPEG contact sheet to Codex,
and keeps returned tags as suggestions until the user accepts them.

Codex never creates semantic vectors. A Codex outage does not stop Ollama
indexing, search, or find-similar work over an existing semantic index.

## Ollama semantic index

Ollama is the only embedding runtime. Install Ollama, then install the default
model explicitly:

```sh
ollama pull embeddinggemma
npm run dev
```

GatherLocal sends embedding requests directly to Ollama's native endpoint:

```http
POST http://127.0.0.1:11434/api/embed
Content-Type: application/json

{"model":"embeddinggemma","input":"searchable save text"}
```

Optional overrides:

```sh
GATHERLOCAL_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
GATHERLOCAL_OLLAMA_EMBED_MODEL=embeddinggemma \
npm run dev
```

GatherLocal does not use OpenAI-compatible embedding endpoints, OpenAI
Platform embedding APIs, LM Studio embedding compatibility, cloud fallback,
or automatic model downloads.

## Queue and rebuild controls

Open **Settings → AI usage → Semantic index** to inspect Ollama health, active
model, indexed-save count, progress, current item, waiting work, and failures.
From there you can:

- pause or resume semantic indexing;
- retry or dismiss failed items;
- start an explicit full rebuild; and
- cancel an active rebuild.

Incremental indexing runs one save at a time in the background. Saving and
importing stay available while it runs. A full rebuild keeps the prior complete
generation intact until the replacement finishes; partial generations never
serve search results.

If Ollama is stopped, semantic work pauses without blocking ordinary library
use or Codex video analysis. If the model is missing, Settings shows the exact
setup command:

```sh
ollama pull embeddinggemma
```
