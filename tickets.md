# Tickets: Smart categories classifier

Build hands-off learned smart categories for GatherLocal: weighted category lenses, Codex-powered topic profiles, quiet background refresh, stable naming, and optional local embeddings. Source spec: `docs/superpowers/specs/2026-07-09-smart-categories-classifier-design.md`.

Work the **frontier**: any ticket whose blockers are all done.

## Add smart category foundation

**What to build:** Add the underlying smart category model so GatherLocal can store smart categories, aliases, topic profiles, weighted memberships, run history, and category controls without changing existing library behavior.

**Blocked by:** None — can start immediately.

- [x] Smart categories can be created, read, hidden, pinned, and archived internally.
- [x] Smart category aliases and weighted memberships can be stored and queried.
- [x] Existing tags, folders, boards, search, and X import behavior remain unchanged.
- [x] Migration is covered by database tests.

## Create save topic profiles with Codex

**What to build:** Generate internal topic profiles for saves through the Codex subscription path, using available tweet text, image reading, OCR, and existing metadata as evidence.

**Blocked by:** Add smart category foundation.

- [x] Weak X bookmarks with image-only meaning produce useful concepts, summaries, content type, intent, and confidence.
- [x] The app attaches image evidence when present and uses text-only evidence when image evidence is unavailable.
- [x] Invalid or incomplete Codex JSON fails safely without changing category state.
- [x] Topic profiles are internal classifier fuel, not user-facing tags.

## Assign Codex-only weighted memberships

**What to build:** Assign saves to zero or more smart categories with weights using Codex JSON scoring, without requiring embeddings.

**Blocked by:** Create save topic profiles with Codex.

- [x] One save can belong to multiple categories with different weights.
- [x] Strong, secondary, and low-confidence memberships follow the spec thresholds.
- [x] Low-confidence saves remain unassigned or candidate-only instead of being forced into categories.
- [x] Membership evidence is stored compactly for later inspection/debugging.

## Show smart categories as quiet navigation

**What to build:** Show useful smart categories in the app navigation and let users open category views as weighted lenses over saved items.

**Blocked by:** Assign Codex-only weighted memberships.

- [ ] Only visible categories that meet usefulness thresholds appear in navigation.
- [ ] Category views rank saves by membership strength and recency.
- [ ] Secondary memberships do not clutter the main category grid by default.
- [ ] Hidden and candidate categories stay out of normal navigation.

## Run background smart category refresh

**What to build:** Refresh smart categories hands-off during quiet app windows after enough new saves arrive.

**Blocked by:** Show smart categories as quiet navigation.

- [ ] Refresh waits for capture/import, search typing, detail editing, modal, and drag/drop quiet.
- [ ] Refresh starts after the configured pending-save threshold or explicit user action.
- [ ] Work pauses or defers when the user resumes active interaction.
- [ ] Refresh run metadata records success, failure, counts, and timing.

## Add alias-powered smart category search

**What to build:** Let search terms match smart category names and aliases, then expand into weighted member saves while preserving direct save matches first.

**Blocked by:** Show smart categories as quiet navigation.

- [ ] Searching an old or alternate category name finds the matching smart category.
- [ ] Category-expanded saves appear after direct save/title/tag/OCR matches.
- [ ] Alias search works after a category rename.
- [ ] Structural filters continue to constrain expanded category results.

## Add stability controls and recent-change indicator

**What to build:** Keep category names stable, preserve old names as aliases, let users hide/pin categories, and show a tiny recent-change indicator for changed categories.

**Blocked by:** Show smart categories as quiet navigation.

- [ ] Renames create aliases and recent-change metadata.
- [ ] Pinned category names do not auto-rename.
- [ ] Hidden categories do not reappear unless explicitly restored or rebuilt.
- [ ] Recently changed categories show a small history/info indicator only during the configured window.

## Add conservative taxonomy refresh

**What to build:** Periodically review the taxonomy and apply conservative rename/alias improvements first, with merge/split behavior guarded by strong evidence.

**Blocked by:** Add stability controls and recent-change indicator; Run background smart category refresh.

- [ ] Cosmetic renames are rejected.
- [ ] Rename proposals obey cooldowns and pinned-name rules.
- [ ] Failed or invalid refresh output keeps the previous taxonomy intact.
- [ ] Merge/split proposals are recorded or deferred until assignment behavior is stable.

## Use local embeddings for faster smart category scoring

**What to build:** When a local embedding provider is configured, use vector math for category membership scoring and clustering while keeping Codex for naming, aliases, and explanations.

**Blocked by:** Assign Codex-only weighted memberships.

- [ ] Local embedding path produces the same membership shape as the Codex-only path.
- [ ] Category centroids can be computed and compared against save embeddings.
- [ ] If local embeddings fail, app falls back to Codex-only scoring or pending state.
- [ ] No OpenAI Platform API key is required.
