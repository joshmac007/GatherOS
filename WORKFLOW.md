# GatherLocal workflow

## Mental model

- `upstream/main`: Brett's live repository.
- `origin/main`: clean GitHub mirror of Brett's branch.
- `origin/local`: Josh's complete GatherLocal product.
- `origin/contrib/<feature>`: temporary contribution work suitable for Brett.

The canonical checkout stays on `local`. Do not create permanent second clones.

Brett's GitHub default branch currently points to an outdated Claude branch.
Always request `BrettfromDJ/GatherOS:main` explicitly. Never use Brett's remote
HEAD or default branch as the update source.

## Work on GatherLocal

Start every personal feature from current `local`:

```bash
cd '/Users/joshmcswain/Documents/GatherOS Remake/GatherLocal'
git switch local
git pull --ff-only origin local
```

Commit and push the feature to `local` or a short-lived branch based on `local`.
Build installed GatherLocal releases only from tested `local` commits.

## Receive Brett's updates

GitHub Actions checks Brett's `main` daily and on manual dispatch. When Brett
changes it, the workflow:

1. updates clean mirror branch `origin/main`;
2. opens a pull request from `main` into `local`;
3. leaves conflicts and verification visible in that pull request.

Take the full upstream update. Preserve GatherLocal behavior through explicit
local provider, server, auth, storage, and feature seams. Do not build a second
copy of Brett's repository or selectively copy upstream files.

An agent may resolve update conflicts, but it must test both Brett's new behavior
and GatherLocal's local behavior before merging.

## Contribute to Brett

Create each contribution from Brett's clean branch, never from `local`:

```bash
git fetch upstream
git switch --create contrib/feature-name upstream/main
```

Bring over only portable feature commits. Exclude local AI/runtime integration,
server replacements, entitlement changes, personal config, secrets, and user
data. Push the contribution branch to `origin`, then open a pull request against
`BrettfromDJ/GatherOS:main`.

Delete the temporary local contribution branch/worktree after the pull request
is complete. GitHub retains the review history.

## Storage policy

- GitHub branches and tags provide recovery.
- Never create permanent preservation, reconstruction, accepted-repo, sync-run,
  overlay, offline, indexing, upstream, or contribution copies locally.
- Use temporary worktrees only under the system temp directory; remove them at
  task completion.
- Treat build outputs as disposable or publish them through GitHub
  Actions/Releases.
- Never upload GatherLocal user libraries or application data.
