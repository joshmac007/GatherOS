# GatherLocal development and contribution playbook

Audience: Josh and future AI agents operating the GatherLocal workspace.

## Mission

Primary goal: receive Brett's GatherOS updates without losing Josh's app,
personal AI behavior, data, or recovery path.

Secondary goal: offer useful generic improvements back to Brett through clean,
optional pull requests. Brett is not involved in Josh's local update process.

## Mental model

Do not think of this as one repository. It is five lanes with different jobs:

| Path | Job | May edit? | May push? |
|---|---|---:|---:|
| `GatherOS-Upstream` | Exact clean view of Brett's `main` | No | Never |
| `GatherLocal-Next` | Last fully accepted personal app | No, immutable | Never |
| `GatherLocal-Workflow` | Sync controller, patch manifest, evidence contracts | Yes, carefully | Never |
| `GatherOS-Contrib` | Generic changes suitable for Brett | Yes, on `contrib/*` | Only with explicit approval |
| `GatherLocal` | Preserved historical dirty workspace | No routine work | Never |

Supporting stores:

- `GatherLocal-Reconstructions/<commit>` contains immutable accepted builds.
- `GatherLocal-Accepted.git` holds authoritative accepted and recovery refs.
- `Preservation` holds recovery bundles, copied-data snapshots, and receipts.
- `.gatherlocal-sync-runs` holds controller runs and failed candidates.

`GatherLocal-Next` is a symlink to one immutable reconstruction. Never edit it
in place, switch its branch, reset it, clean it, install packages into it, or use
it as a scratch checkout.

## Start every agent session here

Run read-only checks before planning changes:

```sh
ROOT="/Users/joshmcswain/Documents/GatherOS Remake"

git -C "$ROOT/GatherLocal-Workflow" status --short
git -C "$ROOT/GatherLocal-Next" status --short
git -C "$ROOT/GatherOS-Upstream" status --short
git -C "$ROOT/GatherOS-Contrib" status --short
git -C "$ROOT/GatherLocal" status --short
git ls-remote https://github.com/BrettfromDJ/GatherOS.git refs/heads/main
git --git-dir "$ROOT/GatherLocal-Accepted.git" show-ref
readlink "$ROOT/GatherLocal-Next"
```

Expected:

- Workflow, accepted app, upstream, and contribution checkouts are clean.
- Historical `GatherLocal` may remain dirty. Preserve it.
- Brett's live SHA may change. Never treat a stored SHA or release tag as latest.
- `refs/gatherlocal/upstream/accepted` records upstream SHA used by accepted app.

Stop if clean lanes are unexpectedly dirty, a path changed role, or accepted
pointer and accepted ref disagree. Diagnose; do not reset or clean around it.

## Use current accepted app

Launch verified accepted build:

```sh
open "/Users/joshmcswain/Documents/GatherOS Remake/GatherLocal-Next/dist/build/mac-arm64/GatherLocal.app"
```

This is GatherLocal, not Brett's GatherOS. Runtime identity, user-data root,
extension identity, native host, protocol, and local AI adapters remain separate.

## Receive Brett updates

This is supported and automated.

1. Close running GatherLocal dev/build processes.
2. Read Brett's current full `main` SHA.
3. Give exact SHA to controller.

```sh
cd "/Users/joshmcswain/Documents/GatherOS Remake/GatherLocal-Workflow"

git ls-remote https://github.com/BrettfromDJ/GatherOS.git refs/heads/main

node scripts/gatherlocal-sync.mjs sync \
  --upstream-ref upstream/main \
  --target-sha FULL_40_CHARACTER_SHA_FROM_PREVIOUS_COMMAND
```

Controller then:

1. Fetches literal public `upstream/main`.
2. Proves release and previous-target ancestry.
3. Creates independent candidate; accepted app stays untouched.
4. Replays every checksummed overlay patch in order.
5. Runs patch-specific checks, full Electron tests, renderer build, extension
   packaging, arm64 packaging, signing, archive validation, and copied-data
   rehearsal.
6. Seals recovery evidence.
7. Atomically promotes accepted Git refs.
8. Repoints `GatherLocal-Next` only after every gate passes.

Success prints `PASS: sync ...`. Failure preserves diagnostics and leaves prior
accepted app selected. Never resolve a patch conflict by skipping, forcing,
reverse-applying, or assuming Brett adopted it.

After success:

```sh
git -C ../GatherLocal-Next status --short
git -C ../GatherLocal-Next rev-parse HEAD
git --git-dir ../GatherLocal-Accepted.git show-ref
readlink ../GatherLocal-Next
```

## Decide where a new feature belongs

Ask one question: could Brett ship this unchanged to every GatherOS user?

### Personal overlay

Use personal lane when feature contains any of these:

- Josh-specific AI provider, endpoint, model, preference, or local service;
- GatherLocal branding or separate app/runtime identity;
- GatherLocal-only user-data or migration policy;
- machine-specific path, port, secret, entitlement composition, or assumption;
- behavior Brett should not inherit automatically.

### Contribution

Use contribution lane when feature:

- is provider-neutral and useful to ordinary GatherOS users;
- contains no secrets, local endpoints, personal paths, or GatherLocal identity;
- has focused tests and follows Brett's existing architecture/style;
- can be reviewed independently from personal behavior.

### Mixed feature

Split it:

1. Generic capability or UI -> contribution commit.
2. GatherLocal provider/identity/config -> personal overlay commit depending on
   generic capability.

Never send mixed commit upstream.

## Develop a new personal feature

Personal-patch intake is a separate fail-closed command. It extends canonical
evidence but never promotes the accepted app itself.

Safe process:

1. Leave `GatherLocal-Next` untouched.
2. Create an independent no-hardlink feature clone under a new workspace path.
3. Disable all pushes in that clone.
4. Create one `codex/personal-*` branch from current accepted commit.
5. Implement one coherent behavior with regression tests.
6. Run targeted tests, full Electron tests, renderer build, and diff inspection.
7. Classify commit as `personal-overlay`, `personal-support`, or
   `pending-contribution`.
8. Create a checksummed intake spec and run `scripts/intake-overlay.mjs`.
9. Preserve previous canonical evidence ref before moving it.
10. Prove artifact checksum, canonical diff, stable patch ID, source tree,
    dependencies, and replay from exact accepted upstream target.
11. Commit clean Workflow changes before running sync; controller rejects dirty
    Workflow state.
12. Run full sync against current upstream SHA. Only successful promotion makes
    feature part of usable GatherLocal.

Josh can describe a desired feature and tell an agent:

> Build this as a personal GatherLocal feature. Do not edit GatherLocal-Next.
> Use an independent feature clone, keep changes as one coherent patch, update
> the overlay evidence fail-closed, and run full sync acceptance before promotion.

Intake must finish with a clean Workflow commit, verified canonical evidence,
and a recovery ref. Manual ref edits without recovery evidence are forbidden.

## Develop a contribution

Contribution lane is ready.

Refresh clean base:

```sh
cd "/Users/joshmcswain/Documents/GatherOS Remake/GatherOS-Contrib"
git status --short
git fetch upstream --prune
git switch main
git merge --ff-only upstream/main
```

Create one focused branch:

```sh
git switch -c contrib/short-feature-name
```

Implement generic change. Then run relevant tests, inspect diff, and commit:

```sh
git diff --check
git status --short
git diff
git add EXACT_FILES_ONLY
git commit -m "Sentence case summary"
```

Before publication, prove:

- branch name starts `contrib/`;
- branch descends from current `upstream/main`;
- diff contains no personal AI, credentials, local paths, GatherLocal identity,
  private data, generated output, or unrelated changes;
- tests pass without GatherLocal-only environment/config;
- pull-request description states behavior, checks, and limitations.

Push requires explicit user approval:

```sh
git push -u origin contrib/short-feature-name
```

Local pre-push guard blocks wrong remote, wrong branch family, deletions,
non-fast-forward updates, stale upstream ancestry, and mismatched branch names.
Pull request target is Brett's `BrettfromDJ/GatherOS` `main`; source is Josh's
fork branch. Opening PR is always separate explicit action. Never ask Brett to
participate in local update setup.

## Turn a contribution into personal app behavior

A contribution may also be needed locally before Brett accepts it. Represent
same generic commit as `pending-contribution` patch in overlay, followed by any
personal adapter patch.

On future sync:

- keep pending patch unless exact evidence proves Brett's target owns it;
- automatic evidence is exact source ancestry or stable patch ID reachable from
  target;
- reviewed removal requires passing contract tests without patch plus source
  inspection confirming upstream ownership;
- conflict, empty apply, overlapping files, or reverse apply never prove adoption.

## Tests and evidence

Workflow checks:

```sh
cd "/Users/joshmcswain/Documents/GatherOS Remake/GatherLocal-Workflow"
node --test tests/*.test.mjs
scripts/check-boundary.sh
node scripts/check-manifest.mjs --source ../GatherLocal-Accepted.git
git diff --check
```

Do not overwrite receipts. Use new run-specific paths. Never run migration tests
against live user data. Copied-data rehearsal owns disposable copies only.

## Recovery rules

- Accepted authority: `GatherLocal-Accepted.git:refs/gatherlocal/accepted`.
- `GatherLocal-Next` is pointer, not authority.
- Recovery refs keep previous accepted and upstream targets.
- Sealed sync evidence lives under `Preservation/GatherLocal-Sync-<run-id>`.
- Failed runs live under `.gatherlocal-sync-runs/<run-id>`.
- Historical dirty `GatherLocal` remains preservation evidence until separately
  classified and migrated.

Never use `git reset --hard`, `git clean`, force push, ref deletion, branch
deletion, stash/drop, or live-data mutation as recovery shortcuts.

## Current verified baseline

Verified 2026-07-15; recheck live state before reuse:

- Brett `main`: `527f92639aaa897458a6502dc0f49e2d0c2aade6`.
- Accepted upstream target: same SHA.
- Accepted reconstruction: `21bba2b3327174cba20b8095d018bf38b5323d47`.
- Personal stack: six ordered patches.
- Original `GatherLocal`: preserved with unfinished local work; not accepted app.
- Last full sync evidence:
  `Preservation/GatherLocal-Sync-20260715T051228Z-b711a913`.

These hashes are evidence, not future update inputs. Always fetch Brett's current
full SHA before sync.

## Agent completion report

Every agent changing this system must report:

- lane used and why;
- files and commits changed;
- exact upstream SHA;
- tests passed, failed, and unrun;
- accepted ref/pointer state;
- recovery evidence location;
- whether any push, PR, deploy, install, or live-data write occurred.
