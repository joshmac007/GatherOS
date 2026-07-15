# GatherLocal workflow

Local control plane for rebuilding GatherLocal on top of BrettfromDJ/GatherOS.

This repository exists outside every app checkout so a failed replay or a
replaced reconstruction cannot destroy the updater that created it. It starts
with no remote, rejects all pushes through a tracked hook, and stores no app
source or user data.

## Repository roles

| Path | Role |
|---|---|
| `GatherOS-Upstream` | Clean fetch-only mirror of Brett's public source |
| `GatherOS-Contrib` | Clean optional `contrib/*` work for the user's fork |
| `GatherLocal-Next` | Last accepted personal reconstruction |
| `GatherLocal-Workflow` | Controller, patch manifest, tests, and receipts |
| `GatherLocal` | Preserved historical working tree until cutover |
| `Preservation` | Recovery bundles, data snapshots, and checksums |

## Non-authority

A normal sync may read public upstream Git state and disposable copies, but it
cannot push, publish, deploy, ship, run remote migrations, replace an installed
app, write live user data, install a native host, or register a URL protocol.

Contribution publication is a separate user-authorized workflow in
`GatherOS-Contrib`. It is not a mode or flag of the source-sync command.

## Boundary check

Run:

```sh
./scripts/check-boundary.sh
```

The check fails if this repository gains a remote, loses its push lockout, uses
an untracked hook path, or no longer rejects a synthetic push invocation.

## Overlay manifest

`manifests/overlay.v1.json` is the source of truth for the current six-patch
stack. Logical IDs survive rebases; revisions change when patch behavior changes.
Artifact checksums protect exported bytes, canonical-diff checksums bind current
source evidence, and stable patch IDs support equivalence checks without being
treated as integrity hashes.

Patch-scoped application tests run through Electron's Node mode because native
dependencies are built for the app's Electron ABI, not the shell's Node ABI.

Verify manifest artifacts and current reconstruction evidence:

```sh
node scripts/check-manifest.mjs --source ../GatherLocal-Next
```

Replay every artifact from the tested upstream base in a disposable independent
clone and prove each intermediate tree:

```sh
node scripts/replay-manifest.mjs \
  --upstream ../GatherOS-Upstream \
  --source ../GatherLocal-Next
```

The replay probe deletes a passing candidate unless `--keep` is supplied. A
failed candidate is always preserved and printed for diagnosis.

## Copied-data rehearsal

`manifests/data-rehearsal.v1.json` binds the preserved version-21 GatherLocal
snapshot by checksum and declares its non-sensitive counts, protected columns,
protected tables, path counts, exact named-migration ledger, and source-key
postconditions.

The verifier APFS-clones the complete 2.9 GB preserved user-data tree into a
unique temporary directory. It calls the same `initializePersistentState()`
function as production without loading the full app. A macOS sandbox denies all
network access and every filesystem write outside the disposable run root;
in-process guards also reject child processes, forbidden modules, and listening
servers. Physical-path checks stop copied symlinks from redirecting database or
media access outside the copy. Stored absolute media paths are mapped into the
copy and never dereferenced against the live library.

Run:

```sh
node scripts/verify-data-rehearsal.mjs \
  --app-source ../GatherLocal-Next \
  --receipt runs/data-rehearsal-latest.json
```

The first startup must adopt six legacy migrations, apply the seventh, retain
every pre-existing value and mapped file, and create one verified backup. The
second startup must make zero row changes, preserve the full ledger, and create
no backup. A run is rejected unless both repositories are clean and the app
commit/tree exactly match the overlay manifest. Receipts are new-file-only and
may live only under ignored `runs/` or a separate Preservation evidence folder.
Passing copies are removed; failed copies are preserved and printed.

## Update controller

One-time setup:

```sh
node scripts/gatherlocal-sync.mjs init
```

Receive Brett's latest `main` after independently confirming its full SHA:

```sh
node scripts/gatherlocal-sync.mjs sync \
  --upstream-ref upstream/main \
  --target-sha FULL_40_CHARACTER_SHA
```

Sync is one-way. It fetches public source, builds a new candidate, replays the
personal overlay, validates package and copied data, then promotes only if every
gate passes. It cannot push or create a pull request. Failed candidates remain
under `.gatherlocal-sync-runs`; current accepted app remains selected.

See `docs/steady-state-workflow.md` for normal update and optional contribution
flows.
