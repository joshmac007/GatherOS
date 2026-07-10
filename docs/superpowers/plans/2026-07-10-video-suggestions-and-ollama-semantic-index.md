# Video Suggestions and Ollama Semantic Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship compatible, durable video tag suggestions and Ollama-native semantic indexing as one end-to-end GatherLocal feature.

**Architecture:** Separate video and semantic domain queues persist in each library database. A small priority coordinator runs one background job at a time: video analysis, incremental embedding, then rebuild work. Video uses one Codex contact-sheet request; semantic vectors and category centroids use Ollama's native `/api/embed` only.

**Tech Stack:** Electron 41, Node.js CommonJS, React 18, better-sqlite3, Sharp, Chromium offscreen video decoding, native Ollama HTTP API, Node test runner.

---

## File map

New focused modules:

- `src/main/background-work-coordinator.js` — priority arbitration only.
- `src/main/ollama-embed-client.js` — Ollama health and native embedding transport.
- `src/main/semantic-source.js` — canonical searchable text and source hash.
- `src/main/semantic-index.js` — semantic queue, generations, embedding worker, status.
- `src/main/semantic-search.js` — active-generation ranking and strict dimensions.
- `src/main/video-frame-extractor.js` — offscreen Chromium duration/frame capture.
- `src/main/video-analysis.js` — contact sheet, fingerprint, validation, one Codex call.
- `src/renderer/components/SemanticIndexSettings.jsx` — semantic queue UI.
- `src/renderer/components/VideoTagSuggestions.jsx` — detail-view suggestion UI.

Existing integration files:

- `src/main/db.js` — additive schema/migration and narrow domain repositories.
- `src/main/ai-codex-provider.js`, `src/main/openai.js` — dedicated video Codex port.
- `src/main/index.js` — lifecycle, save routing, coordinator composition.
- `src/main/ipc.js`, `src/main/preload.js` — domain-specific API/events.
- `src/main/save-topic-profiles.js` — exclude MP4 image evidence.
- `src/main/smart-category-memberships.js` — active Ollama generation vectors only.
- `src/renderer/components/SettingsModal.jsx`, `DetailPanel.jsx` — mount focused UI.
- `src/renderer/components/*.module.css` — scoped visual states.
- `docs/local-ai-setup.md` — Ollama-native setup and behavior.

## Task 1: Add durable domain persistence

**Files:**
- Modify: `src/main/db.js`
- Create: `test/semantic-index-db.test.js`
- Create: `test/video-analysis-db.test.js`

- [ ] **Step 1: Write failing migration and repository tests**

Test fresh and upgraded databases for these logical records:

```js
const generation = db.createSemanticGeneration({
  id: 'gen-a', model: 'embeddinggemma', sourceVersion: 1, status: 'building', createdAt: 10,
});
db.enqueueSemanticIndexJob({
  generationId: generation.id, saveId, kind: 'incremental', sourceHash: 'hash-1', now: 20,
});
db.enqueueVideoAnalysis({
  id: 'video-job', saveId, fingerprint: 'fp-1', promptVersion: 1, now: 30,
});
assert.equal(db.getSemanticIndexStatus().waiting, 1);
assert.equal(db.getVideoAnalysis(saveId).state, 'pending');
```

Cover job coalescing to latest hash, stale `running` recovery, retry metadata,
pause/resume, active/building generation isolation, cancellation deleting only
partial vectors/jobs, video fingerprint supersession, accepted/dismissed
history, cascades, and no ordinary tag mutation on failure.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test test/semantic-index-db.test.js test/video-analysis-db.test.js
```

Expected: fail because domain tables/functions do not exist.

- [ ] **Step 3: Append schema and one migration**

Add `semantic_index_state`, `semantic_index_generations`, `semantic_vectors`,
`semantic_index_jobs`, `video_analysis_jobs`, and `video_tag_suggestions` to
both baseline `SCHEMA` and one appended transactional migration. Use foreign
keys with cascades and `CHECK` constraints for states. Keep legacy embedding
columns readable but unreferenced by the new index.

Implement narrow exports used by tests and workers:

```js
createSemanticGeneration(payload)
getSemanticIndexState()
enqueueSemanticIndexJob(payload)
claimSemanticIndexJob(kind, now)
completeSemanticIndexJob(payload)
failSemanticIndexJob(payload)
pauseSemanticIndex(payload)
resumeSemanticIndex(now)
retrySemanticFailures(ids, now)
dismissSemanticFailures(ids, now)
cancelSemanticGeneration(generationId, now)
getSemanticIndexStatus()
listSemanticIndexJobs(options)
getActiveSemanticVectors()
getSemanticVector(saveId)
enqueueVideoAnalysis(payload)
claimVideoAnalysis(now)
completeVideoAnalysis(payload)
failVideoAnalysis(payload)
recoverBackgroundJobs(now)
getVideoAnalysis(saveId)
listVideoTagSuggestions(saveId)
acceptVideoTagSuggestion(payload)
dismissVideoTagSuggestion(payload)
```

Acceptance transaction inserts/normalizes the ordinary tag, resolves the
suggestion, and returns the affected save ID. It does not call worker code.

- [ ] **Step 4: Run tests and verify GREEN**

Run focused tests, then `npm run test:ai`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.js test/semantic-index-db.test.js test/video-analysis-db.test.js
git commit -m "Add durable video and semantic queues"
```

## Task 2: Build the shared priority coordinator

**Files:**
- Create: `src/main/background-work-coordinator.js`
- Create: `test/background-work-coordinator.test.js`

- [ ] **Step 1: Write failing scheduler tests**

Exercise a public interface:

```js
const coordinator = createBackgroundWorkCoordinator({
  lanes: [videoLane, incrementalLane, rebuildLane],
  isForegroundBusy: () => false,
  setTimer: fakeSetTimer,
});
coordinator.start();
coordinator.wake();
await coordinator.whenIdle();
assert.equal(maxConcurrent, 1);
assert.deepEqual(order, ['video', 'incremental', 'rebuild-1', 'rebuild-2']);
```

Test priority, rebuild yielding after one save, blocked-domain skipping,
foreground deferral, timer/backoff wake, stop, and `whenIdle`.

- [ ] **Step 2: Verify RED**

Run the focused test. Expected: module missing.

- [ ] **Step 3: Implement minimal coordinator**

Each lane exposes `claimReady(now)`, `run(job)`, and `nextReadyAt()`. The loop
claims in configured order, awaits exactly one job, then rechecks priority.
`stop()` prevents new claims and `whenIdle()` resolves after the active job.

- [ ] **Step 4: Verify GREEN and commit**

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test test/background-work-coordinator.test.js
git add src/main/background-work-coordinator.js test/background-work-coordinator.test.js
git commit -m "Add background AI work coordinator"
```

## Task 3: Implement native Ollama transport and canonical source

**Files:**
- Create: `src/main/ollama-embed-client.js`
- Create: `src/main/semantic-source.js`
- Create: `test/ollama-embed-client.test.js`
- Create: `test/semantic-source.test.js`
- Modify: `src/main/ai-provider-config.js`
- Modify: `src/main/ai-local-provider.js`
- Modify: `src/main/openai.js`
- Modify: `test/ai-provider-config.test.js`

- [ ] **Step 1: Write failing transport tests**

Assert exact native contracts:

```js
await client.embed('Find dark aviation dashboards');
assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/embed');
assert.deepEqual(calls[0].body, {
  model: 'embeddinggemma', input: 'Find dark aviation dashboards',
});
assert.deepEqual(vector, [0.25, -0.5, 0.75]);
```

Health uses `GET /api/tags`; reject missing model, empty/malformed/non-finite
vectors, and dimension mismatch. Source scans prove semantic code contains no
`/v1/embeddings`, `/embeddings`, LM Studio, or Platform fallback.

- [ ] **Step 2: Write failing source tests**

`buildSemanticSource({save,tags,topicProfile})` returns deterministic labeled
text and SHA-256 hash. Test normalized whitespace, sorted tags/concepts, notes,
tweet/quoted text, OCR, title/description, and topic summary. Prove no video
suggestion/contact-sheet/evidence field is accepted; adding an accepted
ordinary tag changes the hash.

- [ ] **Step 3: Verify RED**

Run both focused files. Expected: modules missing and old config expectations.

- [ ] **Step 4: Implement minimal modules and remove generic embedding lane**

Add dedicated Ollama config:

```js
ollama: {
  baseUrl: 'http://127.0.0.1:11434',
  embedModel: env.GATHERLOCAL_OLLAMA_EMBED_MODEL || 'embeddinggemma',
}
```

Remove `embedText` from the active Codex/local-chat facade. Export a dedicated
`createOllamaEmbedClient` seam. Local chat/vision behavior remains supported;
LM Studio embedding claims and generic OpenAI-shaped embedding calls do not.

- [ ] **Step 5: Verify GREEN and commit**

Run focused tests plus `npm run test:ai`, then commit explicit files.

## Task 4: Implement semantic generations, queue worker, and search

**Files:**
- Create: `src/main/semantic-index.js`
- Create: `src/main/semantic-search.js`
- Create: `test/semantic-index-worker.test.js`
- Create: `test/semantic-index-generations.test.js`
- Create: `test/semantic-search.test.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/db.js`

- [ ] **Step 1: Write failing worker/generation tests**

Use injected repository, client, clock, and notifier. Prove one save per run,
latest-hash coalescing, unchanged-source skip, capped retry, runtime-wide pause
for unavailable Ollama/model, strict vector validation, stale-result revision
protection, restart recovery, and atomic activation only after complete build.

Test model change creates separate generation; partial generation is never
searchable; pause resumes; cancel discards partial generation and retains old
active vectors.

- [ ] **Step 2: Write failing search tests**

Assert query embedding uses active generation model/dimension, ranking rejects
mismatch rather than truncating, current hybrid literal/structural filters
remain, find-similar reads active generation only, and Ollama failure falls
back to LIKE/palette behavior.

- [ ] **Step 3: Verify RED**

Run the three focused files. Expected: missing modules/new DB reads.

- [ ] **Step 4: Implement semantic domain**

Expose:

```js
createSemanticIndex({repository, ollama, coordinator, notify, now})
// enqueue, startRebuild, pause, resume, cancelRebuild,
// retryFailed, dismissFailed, status, queue, createLanes
```

Incremental and rebuild lanes each claim one durable job. Recompute canonical
source immediately before embedding. Write vector + completed revision in one
transaction. Search reads only active complete generation.

Replace `ipc.js` semantic query and find-similar reads with injected
`semanticSearch`; remove Codex-session gating and legacy dimension truncation.

- [ ] **Step 5: Verify GREEN and commit**

Run focused semantic tests, `npm run test:ai`, `node --check` on new main files,
then commit.

## Task 5: Implement semantic IPC and Settings queue

**Files:**
- Create: `src/renderer/components/SemanticIndexSettings.jsx`
- Create: `src/renderer/components/SemanticIndexSettings.module.css`
- Create: `test/semantic-index-ui.test.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/preload.js`
- Modify: `src/renderer/components/SettingsModal.jsx`
- Modify: `src/renderer/App.jsx`

- [ ] **Step 1: Write failing API/UI contract tests**

Test IPC/preload methods `status`, `queue`, `pause`, `resume`, `retryFailed`,
`dismissFailed`, `startRebuild`, and `cancelRebuild`, plus allowed events
`semantic-index:status`, `semantic-index:progress`, `semantic-index:notice`.
Extract pure view-state helpers so tests assert button/status behavior without
restating JSX source.

- [ ] **Step 2: Verify RED**

Run `test/semantic-index-ui.test.js`. Expected: contracts missing.

- [ ] **Step 3: Implement Settings component**

Render connected/model state, exact install command, indexed/total/percentage,
waiting/indexing/failed counts, current title, expandable queue rows, retry and
dismiss failure controls, pause/resume, rebuild/cancel. Snapshot on mount and
subscribe while open; background work continues while closed.

App semantic availability derives from `semanticStatus.searchReady`, never
Codex session. Existing entitlement gating remains unchanged.

- [ ] **Step 4: Verify GREEN and commit**

Run focused UI contract test and renderer build, then commit.

## Task 6: Implement video frame capture, fingerprint, and Codex contract

**Files:**
- Create: `src/main/video-frame-extractor.js`
- Create: `src/main/video-analysis.js`
- Create: `test/video-frame-extractor.test.js`
- Create: `test/video-analysis.test.js`
- Modify: `src/main/ai-codex-provider.js`
- Modify: `src/main/openai.js`
- Modify: `test/ai-provider-config.test.js`

- [ ] **Step 1: Write failing pure media/analysis tests**

Test duration bands produce 6--12 interior timestamps; injected extractor
returns JPEG buffers; Sharp composition produces one contact sheet request;
fingerprint uses content identity + canonical context + prompt version;
unchanged fingerprint skips provider; changed fingerprint replaces unresolved
only; poster fallback calls provider once; no usable visual makes unavailable
with zero provider calls.

Validator keeps only normalized unique `high` tags whose evidence contains
`visual`, filters generic/accepted/text-only/conflicting results, and never
returns ordinary tag mutations.

- [ ] **Step 2: Verify RED**

Run focused files. Expected: modules/provider method missing.

- [ ] **Step 3: Implement offscreen extractor**

Use an injected Electron `BrowserWindow` adapter. A hidden/offscreen file page
loads the local MP4, reads `video.duration`, seeks each timestamp, paints to
canvas, and returns JPEG data URLs. Production code converts them to buffers;
tests use a fake adapter. This avoids a system/package FFmpeg dependency and
uses Chromium's packaged MP4 decoder.

- [ ] **Step 4: Implement one-call analysis and dedicated Codex lane**

Add `generateVideoTagSuggestions(input,{imagePath})` to Codex provider and a
dedicated Codex facade that never routes through the active local-chat
provider. Build/cache contact sheet under active library derived storage,
invoke Codex once, validate output, and delete superseded derived sheets.

- [ ] **Step 5: Verify GREEN and commit**

Run focused tests plus `npm run test:ai`, then commit.

## Task 7: Implement video worker, media guards, and import routing

**Files:**
- Create: `test/video-media-guard.test.js`
- Create: `test/video-semantic-workflows.test.js`
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/save-topic-profiles.js`
- Modify: `src/main/extension-server.js`
- Modify: `src/main/storage.js`

- [ ] **Step 1: Write failing guard/integration tests**

Prove MP4 never reaches `analyzeImage`, `autoTagImage`, `generateImagePrompt`,
or topic-profile image input; non-video paths remain. New nonduplicate video
import enqueues video + semantic once; duplicate/existing video does not.
Pending jobs recover after restart only when fingerprint current.

Prove one global active background job, priority order, provider outage
isolation, distinct event namespaces, accept enqueues one coalesced semantic
job, dismiss enqueues none, and library switch/restore cannot write into the
wrong library epoch.

- [ ] **Step 2: Verify RED**

Run guard/workflow tests. Expected: current MP4 route and inline enrichment fail.

- [ ] **Step 3: Compose coordinator and workers**

At startup recover queues, register lanes, and start coordinator. On video save,
persist both jobs before wake. On image save, retain Codex enrichment but move
embedding to semantic queue after persisted metadata changes. Stop/idle before
DB close, library switch, backup restore, and quit; resume against new library.

Guard manual image-only IPC for video. Topic evidence uses `imagePath:null` for
video, and v1 does not add a second video Codex summary call. Ensure derived
contact sheets clean on replacement and hard deletion.

- [ ] **Step 4: Verify GREEN and commit**

Run focused integration, all AI tests, and `node --check` touched main files.
Commit.

## Task 8: Implement video suggestion IPC and detail UI

**Files:**
- Create: `src/renderer/components/VideoTagSuggestions.jsx`
- Create: `src/renderer/components/VideoTagSuggestions.module.css`
- Create: `test/video-suggestions-ui.test.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/preload.js`
- Modify: `src/renderer/components/DetailPanel.jsx`
- Modify: `src/renderer/App.jsx`

- [ ] **Step 1: Write failing domain UI tests**

Test APIs `getForSave`, `accept`, `dismiss`, `acceptAll`, `dismissAll` and event
`video-analysis:updated`. Test pure UI state mapping for queued/analyzing,
suggested, accepted/dismissed, poster evidence, empty, and failure states.

- [ ] **Step 2: Verify RED**

Run focused file. Expected: new methods/components absent.

- [ ] **Step 3: Implement IPC and UI**

Fetch on video record change; filter events by save ID. Show subtle analyzing
copy, suggestion chips with accept/dismiss, Accept all/Dismiss all, and evidence
wording without numeric confidence. Refresh ordinary tags after accept. Hide
generic image auto-tag/prompt actions for video. Unresolved suggestions never
enter grid/search/tag state.

- [ ] **Step 4: Verify GREEN and commit**

Run focused test and renderer build, then commit.

## Task 9: Align smart-category vectors and documentation

**Files:**
- Modify: `src/main/smart-category-memberships.js`
- Modify: `src/main/db.js`
- Modify: `test/smart-category-memberships.test.js`
- Modify: `docs/local-ai-setup.md`

- [ ] **Step 1: Write failing identity tests**

Prove local category scoring reads active-generation Ollama vectors and stores
category centroid identity with generation/model/dimension/source hash. A
mismatch cannot be compared. Preserve Codex JSON judgment fallback when local
vectors are unavailable; Codex never generates a vector.

- [ ] **Step 2: Verify RED**

Run smart-category membership tests. Expected: legacy untyped centroid path.

- [ ] **Step 3: Implement minimal identity-aware category seam**

Add generation-scoped centroid persistence or compute from active member
vectors. Remove generic `embedText` calls from category code. Preserve existing
thresholds, evidence, and taxonomy policies.

Update setup docs: `ollama pull embeddinggemma`, native endpoint, Settings
queue/rebuild, outage behavior, Codex/video boundary, no LM Studio/OpenAI-shaped
embedding support.

- [ ] **Step 4: Verify GREEN and commit**

Run membership tests and full AI suite, then commit.

## Task 10: End-to-end verification and final review

**Files:**
- Add fixture if needed: `test/fixtures/video-suggestions-smoke.mp4`
- Modify only files required by findings.

- [ ] **Step 1: Automated verification**

```bash
npm run test:ai
npm run build:renderer
node --check src/main/background-work-coordinator.js
node --check src/main/ollama-embed-client.js
node --check src/main/semantic-index.js
node --check src/main/video-frame-extractor.js
node --check src/main/video-analysis.js
git diff --check
```

Expected: all tests/build/checks pass; no warnings introduced by feature code.

- [ ] **Step 2: Live Electron verification with isolated user data**

Start Ollama with `embeddinggemma`, run `npm run dev:fresh`, then use real app
controls via browser/computer automation:

1. Open Settings → Semantic index; verify health/model/zero or current progress.
2. Start rebuild; verify current item/queue; pause/resume; cancel; restart.
3. Stop Ollama; verify semantic pause and normal library/video workflow.
4. Restart Ollama; retry/resume and complete index.
5. Import a real MP4 fixture; verify import returns before analysis.
6. Open video detail; observe analyzing then suggestions/poster fallback.
7. Dismiss one; verify no ordinary tag or semantic job change.
8. Accept one; verify ordinary tag appears and exactly one incremental job runs.
9. Use semantic search and find-similar after completed generation.
10. Relaunch; verify queues/resolutions persist.

- [ ] **Step 3: Review gates**

Run independent spec-compliance review, then code-quality review. Fix every
important finding with a failing regression test first; re-run review until
approved.

- [ ] **Step 4: Final commit**

```bash
git status --short
git add src/main src/renderer test docs/local-ai-setup.md
git diff --cached --check
git commit -m "Complete video suggestions and semantic index"
```

Record final SHAs and evidence. Do not merge to `main` without user direction.
