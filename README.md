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

`manifests/overlay.v1.json` is the source of truth for the current ordered patch
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
