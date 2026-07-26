#!/bin/zsh

set -euo pipefail

default_branch="${CONDUCTOR_DEFAULT_BRANCH:-main}"
canonical_ref="origin/$default_branch"

git fetch --prune origin

if git show-ref --verify --quiet "refs/remotes/$canonical_ref"; then
  if git merge-base --is-ancestor HEAD "$canonical_ref"; then
    git merge --ff-only "$canonical_ref"
  elif ! git merge-base --is-ancestor "$canonical_ref" HEAD; then
    print -u2 "GitHub sync: this branch diverges from $canonical_ref and must be reconciled before editing."
    exit 1
  fi
fi

root_path="${CONDUCTOR_ROOT_PATH:-}"
if [[ -z "$root_path" || ! -d "$root_path" ]]; then
  exit 0
fi

git -C "$root_path" fetch --prune origin
root_branch="$(git -C "$root_path" branch --show-current)"
if [[ "$root_branch" != "$default_branch" ]]; then
  exit 0
fi

if [[ -n "$(git -C "$root_path" status --porcelain)" ]]; then
  print -u2 "GitHub sync: root checkout has local changes, so it was fetched but not moved."
  exit 0
fi

git -C "$root_path" merge --ff-only "$canonical_ref"
