#!/bin/zsh

set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  print -u2 "Archive guard: uncommitted work remains. Commit and land it, or explicitly preserve it before archiving."
  git status --short >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  print -u2 "Archive guard: detached HEAD cannot be proven landed."
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  print -u2 "Archive guard: this repository has no canonical origin remote."
  exit 1
fi

default_branch="${CONDUCTOR_DEFAULT_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"
default_branch="${default_branch:-main}"
canonical_ref="origin/$default_branch"

git fetch --prune origin

if ! git show-ref --verify --quiet "refs/remotes/$canonical_ref"; then
  print -u2 "Archive guard: canonical branch $canonical_ref does not exist."
  exit 1
fi

if git merge-base --is-ancestor HEAD "$canonical_ref"; then
  print "Archive guard: HEAD is contained in $canonical_ref."
  exit 0
fi

origin_url="$(git remote get-url origin)"
github_slug="$(print -r -- "$origin_url" | sed -E 's#^https://github\.com/##; s#^git@github\.com:##; s#\.git$##')"
if [[ ( "$origin_url" == https://github.com/* || "$origin_url" == git@github.com:* ) && -x "$(command -v gh 2>/dev/null)" ]]; then
  merged_pr="$(gh pr list --repo "$github_slug" --state merged --base "$default_branch" --head "$branch" --limit 1 --json url --jq '.[0].url // empty' 2>/dev/null || true)"
  if [[ -n "$merged_pr" ]]; then
    print "Archive guard: merged pull request verified: $merged_pr"
    exit 0
  fi
fi

unique_commits="$(git rev-list --count "$canonical_ref..HEAD")"
if [[ "$unique_commits" == "0" ]]; then
  print "Archive guard: this branch has no commits outside $canonical_ref."
  exit 0
fi

print -u2 "Archive guard: $branch still has $unique_commits commit(s) not landed in $canonical_ref."
print -u2 "Run conductor-land after testing, or explicitly abandon the branch before archiving."
exit 1
