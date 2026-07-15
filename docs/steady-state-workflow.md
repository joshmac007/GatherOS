# Steady-state workflow

## Mental model

Three separate code lanes:

1. **Brett source:** `GatherOS-Upstream`. Clean, fetch-only, never personal code.
2. **Your app:** `GatherLocal-Next`. Accepted Brett source plus local patch stack.
3. **Optional contribution:** `GatherOS-Contrib`. Clean Brett source plus one
   generic improvement suitable for a future pull request.

Brett need not review, approve, or do anything for updates to work.

## Receive an update

From `GatherLocal-Workflow`, run:

```sh
git ls-remote https://github.com/BrettfromDJ/GatherOS.git refs/heads/main
node scripts/gatherlocal-sync.mjs sync \
  --upstream-ref upstream/main \
  --target-sha SHA_PRINTED_BY_LS_REMOTE
```

Controller rejects tags, `HEAD`, abbreviated SHAs, history rewrites, dirty
control repos, patch conflicts, failed tests, failed package checks, and failed
copied-data rehearsals. It never edits accepted app in place. Success switches
`GatherLocal-Next` to new immutable reconstruction. Failure leaves old accepted
reconstruction selected and preserves diagnostics.

## Make personal/local-AI changes

Personal work belongs in overlay reconstruction. Convert each coherent change
into a named manifest patch only after its behavior and migration policy pass.
Never copy personal AI endpoints, credentials, branding, or data assumptions
into `GatherOS-Upstream` or `GatherOS-Contrib`.

## Contribute optionally

Start from clean `GatherOS-Contrib`, based on current Brett `main`. Copy or
reimplement only generic improvement. Keep one contribution per branch. Test it
without local-AI config. Commit locally.

Push or pull-request creation is a later, explicit user action. Sync controller
cannot perform either action. Brett is not part of local update process.

## Recovery authority

`GatherLocal-Accepted.git:refs/gatherlocal/accepted` is authoritative accepted
commit. `GatherLocal-Next` is convenience pointer. Immutable reconstructions and
recovery refs remain available for rollback. Preservation bundles and checksum
receipts prove each promotion input.
