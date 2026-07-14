# Workflow contract

## Primary outcome

Receive Brett's source updates safely. Each update creates a fresh independent
candidate from an exact `upstream/main` commit, replays the ordered GatherLocal
patch stack, validates copied data and fresh builds, and promotes only after all
gates pass.

## Secondary outcome

Generic improvements may be developed in `GatherOS-Contrib` and optionally
offered upstream. No advance permission from Brett is required. Push and pull
request creation always remain explicit user actions outside sync.

## Invariants

1. Never rebuild by rebasing or resetting the accepted reconstruction in place.
2. Never open live GatherLocal user data for writes during sync or rehearsal.
3. Never infer a release solely from a tag; record an exact commit and ancestry.
4. Never skip or auto-resolve a conflicting personal patch.
5. Never treat a conflict, empty patch, or overlapping files as upstream adoption.
6. Never allow the sync command to push, publish, deploy, or mutate remote state.
7. Preserve failed candidates and receipts; preserve the accepted reconstruction.
8. Keep app source, user data, secrets, build output, and installation state out
   of this repository.

## Owned artifacts

This repository may own controller source, tests, topology policy, patch
manifests, exported patches, run schemas, recovery instructions, and a pointer to
the most recent accepted receipt. Immutable recovery bundles live in
`Preservation`; disposable candidates and run output stay ignored.

