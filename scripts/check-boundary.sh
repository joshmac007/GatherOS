#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir 2>/dev/null) ||
  fail 'not a Git repository'
[ "$git_dir" = "$repo_root/.git" ] ||
  fail 'workflow repository must own an independent .git directory'

branch=$(git -C "$repo_root" symbolic-ref --short HEAD 2>/dev/null) ||
  fail 'detached or missing HEAD'
[ "$branch" = 'main' ] || fail 'workflow repository must use local main'

remotes=$(git -C "$repo_root" remote)
[ -z "$remotes" ] || fail 'workflow repository must have no remotes'

push_default=$(git -C "$repo_root" config --local --get push.default || true)
[ "$push_default" = 'nothing' ] || fail 'push.default must be nothing'

hooks_path=$(git -C "$repo_root" config --local --get core.hooksPath || true)
[ "$hooks_path" = '.githooks' ] || fail 'core.hooksPath must be .githooks'

hook="$repo_root/.githooks/pre-push"
[ -f "$hook" ] || fail 'tracked pre-push hook is missing'
[ -x "$hook" ] || fail 'tracked pre-push hook is not executable'

if "$hook" origin disabled </dev/null >/dev/null 2>&1; then
  fail 'pre-push hook accepted a synthetic push'
fi

tracked_hook=$(git -C "$repo_root" ls-files --error-unmatch .githooks/pre-push 2>/dev/null || true)
[ "$tracked_hook" = '.githooks/pre-push' ] || fail 'pre-push hook is not tracked'

printf '%s\n' 'PASS: workflow repository boundary is fail-closed'
