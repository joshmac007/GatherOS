# X and Instagram Import Activity Implementation Plan

**Status:** Approved design; ready for implementation

## Goal

Show one bottom-right GatherLocal activity indicator while an explicit X or Instagram import runs. Collapsed state shows spinner, source, and current stage. Expanded state shows counts, elapsed time, and a Stop import action.

## Product contract

- Covers explicit X and Instagram imports only. Passive background sync stays quiet.
- Covers API replay and visible-scroll fallbacks.
- Enforce one explicit social import total: starting X while Instagram runs, or Instagram while X runs, returns the existing busy response.
- Collapsed pill: spinner, source icon, `Importing X bookmarks` or `Importing Instagram saves`, short stage/count.
- Click toggles an expanded card above the existing bottom-right FAB lane.
- Expanded fields: mode, scanned, newly saved, already known/skipped, failed, elapsed time, stage.
- Expanded card includes `Stop import`.
- Stop is cooperative: current save finishes; no new item/page starts afterward.
- Terminal result remains for 6 seconds, then disappears. Clicking terminal state dismisses it immediately.
- No heartbeat for 30 seconds changes display to `Import may be stalled`; it does not end the import.
- No history screen, pause/resume, rollback, or concurrent-import UI.

## Shared progress payload

Use one internal contract for X and Instagram:

```js
{
  runId: 'crypto-random-id',
  platform: 'x' | 'instagram',
  mode: 'catch-up' | 'fixed' | 'all',
  stage: 'starting' | 'scanning' | 'saving' | 'stopping' | 'complete' | 'stopped' | 'failed',
  scanned: 0,
  saved: 0,
  known: 0,
  failed: 0,
  target: 25 | null,
  startedAt: 1783730000000,
  message: null
}
```

Rules:

- Counters are monotonic non-negative integers.
- `target` is fixed count only; catch-up/all use `null`.
- Every update carries the complete snapshot, not a delta.
- Main process accepts updates only for the same `runId`, or a new `starting` run.
- Every progress response returns `{ ok: true, cancelRequested: boolean }`.
- Extension checks `cancelRequested` before processing the next item and before fetching/scrolling another page.

## File map

### New files

- `extension/social-import-progress.mjs` — run creation, monotonic counters, payload validation, native progress reporting, cancellation check.
- `src/main/social-import-state.js` — in-memory active snapshot, validation, stale timer, cancel request, renderer subscription.
- `src/renderer/components/SocialImportActivity.jsx` — collapsed/expanded accessible UI.
- `src/renderer/components/SocialImportActivity.module.css` — bottom-right placement, spinner, expanded card, reduced motion.
- `src/renderer/lib/socialImportView.mjs` — pure labels, elapsed/stalled/terminal view model.
- `test/social-import-progress.test.js` — extension lifecycle/cancel behavior.
- `test/social-import-state.test.js` — main state validation/cancel/stale behavior.
- `test/social-import-view.test.js` — renderer view-model behavior.

### Modified files

- `extension/background.js` — instrument X/Instagram API + scroll imports; cooperative cancellation.
- `src/main/native-host.js` — relay `social-import-status` to local app.
- `src/main/extension-server.js` — authenticated `POST /social-import-status` route and injected status callback.
- `src/main/index.js` — own state controller; emit renderer updates; provide callback to extension server.
- `src/main/ipc.js` — `social-import:get`, `social-import:cancel`, `social-import:dismiss` handlers.
- `src/main/preload.js` — expose methods and allow `social-import:status` event.
- `src/renderer/App.jsx` — subscribe/re-hydrate activity, render component, refresh grid on terminal saved count.
- Existing focused import tests where state wiring changes.

## Task 1 — Main-process state controller

1. Add failing tests for:
   - valid `starting` snapshot becomes active;
   - counters cannot decrease;
   - mismatched non-starting `runId` is rejected;
   - cancel marks same run `stopping` and returns true;
   - status response exposes `cancelRequested`;
   - terminal snapshots are retained;
   - 30-second heartbeat gap derives stalled without mutating stage;
   - dismiss clears only matching terminal run.
2. Implement `createSocialImportState({ now, setTimer, clearTimer, onChange })`.
3. Keep state memory-only. Do not add DB schema/settings.
4. Run `rtk node --test test/social-import-state.test.js`.

## Task 2 — Authenticated extension-to-main progress bridge

1. Add failing server/native contract tests.
2. Reuse extension server’s existing origin/token/body validation.
3. Add authenticated `POST /social-import-status` with strict payload keys, enum validation, counter validation, and body-size limit inherited from current server.
4. Extend `extensionServer.start` with `onSocialImportStatus(payload)`; return its `{ cancelRequested }` result.
5. Add native message `social-import-status`; ensure app is running, forward unchanged to endpoint, return body.
6. Wire controller changes to `mainWindow.webContents.send('social-import:status', snapshot)`.
7. Add IPC:
   - `social-import:get`
   - `social-import:cancel`
   - `social-import:dismiss`
8. Expose preload methods and event allowlist.
9. Run focused server/state/preload tests plus Node syntax checks.

## Task 3 — Extension lifecycle reporter

1. Add failing behavioral tests for run initialization, full-snapshot output, monotonic counts, error count, terminal state, and cancel response.
2. Implement run IDs with `crypto.randomUUID()` and pure state updates in `extension/social-import-progress.mjs`.
3. Reporter sends `chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'social-import-status', ...snapshot })`.
4. Report `starting` before API/template work.
5. Report `scanning` after each fetched/intercepted batch.
6. Report after each processed item so Stop latency is bounded by current item duration.
7. Before next item/page, stop when last response says `cancelRequested`.
8. Native progress failure must not abort an otherwise healthy import; log once, continue import, retry on next normal progress point.
9. Run `rtk node --test test/social-import-progress.test.js`.

## Task 4 — X import instrumentation and cancellation

1. Add transport tests for catch-up, fixed/all, API replay, and scroll fallback.
2. Add cross-platform busy regression: X start rejects while Instagram is active.
3. Populate counts:
   - `scanned`: unique entries inspected;
   - `saved`: genuinely new accepted saves;
   - `known`: duplicate, dismissed, or catch-up known entries;
   - `failed`: rejected/thrown saves.
4. API path checks cancellation between entries and before next cursor fetch.
5. Scroll path sends existing pause message immediately on cancel, then calls normal end cleanup with `stopped` stage.
6. Catch-up boundary ends as `complete`, not `stopped`.
7. Existing X in-page toast remains; main app indicator is additional feedback.
8. Run catch-up/import-limit/transport/progress tests and syntax checks.

## Task 5 — Instagram instrumentation and cancellation

1. Add matching API and scroll transport tests.
2. Add cross-platform busy regression: Instagram start rejects while X is active.
3. Use same counter meanings and reporter.
4. API path checks cancellation between entries and before `next_max_id` fetch.
5. Scroll path clears `gatherosIgImportActive`, sends `gatheros:ig-stop-import`, and completes normal cleanup.
6. Fixed count maps to numeric target; All maps to `null`.
7. Existing Instagram page toast remains.
8. Run Instagram/progress tests and syntax checks.

## Task 6 — Renderer activity UI

1. Add pure view-model tests for platform/mode/stage labels, pluralization, elapsed time, stalled state, and terminal auto-dismiss metadata.
2. Build `SocialImportActivity`:
   - collapsed button with `aria-expanded`;
   - CSS spinner marked `aria-hidden` plus live status text;
   - expanded card with definition-list counts;
   - Stop button disabled while stopping/terminal;
   - terminal card click dismisses;
   - Escape collapses expanded card;
   - focus-visible styles and reduced-motion spinner fallback.
3. In `App.jsx`, fetch current snapshot on mount, subscribe to `social-import:status`, tick elapsed display once per second only while visible, invoke cancel/dismiss APIs.
4. On terminal state with `saved > 0`, call existing `reload()` once per `runId`.
5. Position at `right: 24px`; collapsed bottom offset `76px` when existing sort/Add FAB occupies bottom-right, otherwise `24px`. Expanded card grows upward. Use existing CSS variables/glass treatment.
6. Ensure selection bar, upgrade banner, focused detail, modals, and narrow window layouts do not obscure controls.
7. Run renderer view tests and `rtk npm run build:renderer`.

## Task 7 — End-to-end verification

Run:

```bash
rtk node --test test/social-import-state.test.js test/social-import-progress.test.js test/social-import-view.test.js
rtk node --test test/catch-up-import.test.js test/import-limit.test.js test/x-import-transport.test.js test/x-bookmark-status.test.js
rtk node --check extension/background.js src/main/native-host.js src/main/extension-server.js src/main/index.js src/main/ipc.js src/main/preload.js
rtk npm run test:ai
rtk npm run build:renderer
rtk git diff --check
```

Manual smoke test:

1. Start fixed X import; verify collapsed/expanded counts update.
2. Stop during API save; verify current save completes, next item does not start.
3. Force X scroll fallback; Stop halts page movement.
4. Repeat API + scroll Stop for Instagram.
5. Run X catch-up to boundary; verify `complete`, not `stopped`.
6. Leave a mocked run without heartbeat; verify stalled copy at 30 seconds.
7. Verify terminal state dismisses after 6 seconds and grid reloads once.

## Risks and controls

- **Native-message overhead:** progress per item launches local native messaging. Keep payload small; if measurement shows material slowdown, switch only this reporter to a persistent native port in a separate scoped change.
- **Cancel race:** controller is authoritative; extension checks returned flag before each next unit of work.
- **Stale service worker:** add visible extension version/run metadata to expanded details only in development logs, not user UI. Manual QA must reload extension and source tabs.
- **UI collision:** use explicit bottom-right stack offset and narrow-window test.
- **Progress mismatch:** tests assert counters from real transport decisions, not inferred desktop save bursts.
