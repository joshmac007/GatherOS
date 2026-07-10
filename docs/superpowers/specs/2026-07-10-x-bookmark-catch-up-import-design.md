# X Bookmark Catch-Up Import Design

**Date:** 2026-07-10
**Status:** Approved design

## Goal

Add an X bookmark import option that scans bookmarks from newest to oldest, repairs isolated missed imports, and stops after finding two consecutive bookmarks already known to GatherLocal.

## User Experience

The X importer count selector gains a `Catch up to latest saved` option. Existing fixed-count options and `All bookmarks` keep their current behavior.

When catch-up starts:

1. GatherLocal checks whether it has any known X bookmark history.
2. If no known history exists, no import starts. The panel remains open and shows: `No previous X bookmark found. Choose a fixed amount instead.`
3. If known history exists, the importer scans X bookmarks newest to oldest.
4. New bookmarks are saved.
5. Known bookmarks advance a consecutive-known streak.
6. A new bookmark resets that streak to zero.
7. The import stops after two known bookmarks in a row.

An active save and a deletion tombstone both count as known. Catch-up never restores a deleted bookmark.

If the first two scanned bookmarks are known, the completion message is `Already caught up.` If any bookmarks were added, the normal imported-count summary is shown.

## Stop Rule

The stop rule is based on X feed order, not response completion order:

- `new` -> save it; known streak becomes `0`
- `known active` -> do not save it; known streak increments
- `known deleted` -> do not save it; known streak increments
- known streak reaches `2` -> stop before scanning older bookmarks

Example:

```text
known -> new/missed -> known -> known
           save          stop
```

This deliberately scans beyond one duplicate so one previously missed bookmark can be repaired.

## Architecture

### Panel

`extension/panel.js` represents catch-up as a distinct import mode rather than a numeric limit. It sends the selected mode to the background worker and handles a structured `noBoundary` response without closing the panel.

### Background importer

`extension/background.js` keeps existing API-replay and scroll-fallback transports. Catch-up adds mode-specific state:

- `mode: 'catch-up'`
- `knownStreak`
- imported and processed counts

Fixed-count imports continue using their current claim/limit behavior. Catch-up uses the same newest-to-oldest batches but applies the known-streak stop rule.

Catch-up does not send `forceImport`. This preserves deletion tombstones.

### Desktop boundary lookup

GatherLocal remains source of truth for whether an X bookmark is known. The extension asks the desktop app to classify bookmark source keys as:

- `new`
- `known-active`
- `known-dismissed`

The lookup also exposes whether any known X history exists for the preflight. It uses existing live-save records and `dismissed_tweets`; the extension's `gatherosBookmarksSeen` set is not a boundary source because it contains baseline IDs that may never have been saved.

The internal contract is explicit:

- Extension sends native message `{ type: 'x-bookmark-status', tweetUrls: string[] }`.
- Native host forwards it to authenticated `POST /x-bookmark-status` on the local extension server.
- Server returns `{ ok: true, hasKnownHistory: boolean, statuses: ('new' | 'known-active' | 'known-dismissed')[] }`, preserving input order.
- `statuses.length` must equal `tweetUrls.length`; malformed requests or batches over 100 URLs are rejected.

The server derives each canonical X source key with the existing `sourceKeyFromUrl` helper, then checks live saves and `dismissed_tweets`. Existing save response fields remain unchanged.

### Page processing

For each X page, entries remain ordered newest to oldest. The desktop classifies the page's source keys in one request. The background worker walks results in order:

1. Save each `new` entry sequentially.
2. Reset `knownStreak` after each successfully saved new entry.
3. Increment `knownStreak` for either known classification.
4. Stop immediately when `knownStreak === 2`.

Batch classification avoids downloading or rendering bookmarks that are already known.

## Failure Handling

- Boundary preflight unavailable: do not start catch-up; report that GatherLocal could not be reached.
- No known boundary: do not import; ask for a fixed count.
- Classification request fails mid-run: stop and report partial progress.
- Save fails or is rejected: stop and report partial progress. Do not treat the failed item as known or continue past it.
- X pagination ends before two consecutive known items: finish safely and report imported count. Do not claim the two-item boundary was reached.
- Tab closes during scroll fallback: retain current stopped-summary behavior.
- Import watchdog expires: retain current timeout protection and report partial progress.

A later retry starts from newest again. Desktop classification makes already-completed saves known, allowing retry to converge without duplication.

## Compatibility

- Fixed-count and all-bookmark imports retain current `forceImport` semantics and limit accounting.
- Passive cross-device sync is unchanged.
- Existing extension seen-set baseline behavior is unchanged.
- No database schema change is required; active saves and existing tombstones provide boundary data.
- Only X receives catch-up mode. Instagram import behavior is unchanged.

## Tests

Focused tests cover:

1. `new, known, known` saves one and stops.
2. `known, new, known, known` repairs the missed item and stops.
3. `known-dismissed, known-active` stops without restoring the deletion.
4. A new item resets the known streak.
5. No known history returns `noBoundary` and performs no saves.
6. First two entries known returns `Already caught up.`
7. Classification or save failure stops with accurate partial progress.
8. Pagination ending before the two-known boundary does not claim catch-up success.
9. Fixed-count and all imports retain existing behavior.
10. API replay and scroll fallback apply the same catch-up stop helper.

Relevant verification includes focused Node tests, extension JavaScript syntax checks, existing AI tests required by the repo, renderer build if panel code is included in its build path, and `git diff --check`.

## Out of Scope

- Changing X bookmark ordering
- Repairing multiple consecutive historical misses beyond the two-known confidence rule
- Adding catch-up to Instagram
- Changing passive sync cadence
- Refactoring unrelated importer or native-host code
