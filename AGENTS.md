# GatherLocal agent rules

## Repository identity

- This is the only active GatherLocal checkout.
- Canonical path: `/Users/joshmcswain/Documents/GatherOS Remake/GatherLocal`.
- GitHub fork: `joshmac007/GatherOS` (`origin`).
- Brett's repository: `BrettfromDJ/GatherOS` (`upstream`, fetch only).
- Before changing anything, run `git rev-parse --show-toplevel`,
  `git branch --show-current`, `git status --short`, and `git remote -v`.
- Stop if repository, branch, or remote identity does not match the task.

## Branch roles

- `main`: exact mirror of `upstream/main`. Read-only. Never develop, commit, or
  add local policy files on this branch.
- `local`: Josh's complete GatherLocal product. Default branch for personal
  features, local AI, semantic indexing, packaging, and installed builds.
- `contrib/<feature>`: temporary clean contribution branch created from
  `upstream/main`. Include only code suitable for Brett's repository. Never
  merge `local` wholesale into a contribution branch.
- `archive/*`: GitHub recovery history only. Never resume development there.

## Update flow

1. Fetch `upstream`.
2. Fast-forward mirror branch `main` to `upstream/main`.
3. Merge `main` into `local` through a tested update branch or pull request.
4. Take Brett's complete update. Keep local behavior through explicit provider,
   auth, server, storage, and feature seams instead of selectively copying files.
5. If conflicts exist, resolve them on the update branch and verify both Brett's
   new behavior and GatherLocal's local behavior before merging.

## Local and contribution boundaries

- GatherLocal may use local AI/runtime implementations and must not call or
  bypass Brett's paid server services.
- Contributions must work against clean upstream code and exclude personal
  config, local-only integrations, entitlement changes, user data, and secrets.
- Portable features should be reapplied or cherry-picked deliberately onto a
  fresh `contrib/<feature>` branch from `upstream/main`.

## Storage and safety

- GitHub branches are recovery. Do not create permanent local preservation
  folders, reconstruction repos, sync-run copies, duplicate clones, bundles, or
  backup worktrees.
- Temporary worktrees are allowed only under the system temp directory and must
  be removed when the task ends.
- Never copy, commit, upload, or rehearse against live GatherLocal user data.
- Build artifacts are disposable or uploaded to GitHub Actions/Releases; do not
  retain duplicate packages locally.
- Preserve unrelated dirty changes. Never force-reset or delete without explicit
  user approval.

## Work and validation

- Follow existing code, schema, migration, and test patterns. Do not weaken
  validation, auth, types, or error handling.
- Use sentence case for interface text.
- Run targeted tests, affected build, `git diff --check`, and inspect final diff.
- Build and install the personal app only from `local`.
- After code changes, include this local rerun command:

  ```bash
  cd '/Users/joshmcswain/Documents/GatherOS Remake/GatherLocal' && git checkout local && git pull origin local && npm run dev
  ```
