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

origin_url="$(git config --get remote.origin.url)"
github_slug="$(print -r -- "$origin_url" | sed -E 's#^https://github\.com/##; s#^git@github\.com:##; s#\.git$##')"
if [[ ( "$origin_url" == https://github.com/* || "$origin_url" == git@github.com:* ) && -x "$(command -v gh 2>/dev/null)" ]]; then
  local_head_sha="$(git rev-parse HEAD)"
  merged_pr_rows="$(
    gh pr list \
      --repo "$github_slug" \
      --state merged \
      --base "$default_branch" \
      --head "$branch" \
      --limit 100 \
      --json number,url,headRefOid \
      --jq '.[] | [.number, .url, .headRefOid] | @tsv' \
      2>/dev/null || true
  )"

  while IFS=$'\t' read -r pr_number pr_url pr_head_sha; do
    if [[ -z "$pr_number" || -z "$pr_url" || -z "$pr_head_sha" ]]; then
      continue
    fi
    if [[ "$pr_head_sha" == "$local_head_sha" ]]; then
      print "Archive guard: merged pull request verified: $pr_url"
      exit 0
    fi

    if ! git fetch --no-tags origin "refs/pull/$pr_number/head" >/dev/null 2>&1; then
      continue
    fi
    fetched_pr_head="$(git rev-parse FETCH_HEAD 2>/dev/null || true)"
    if [[ "$fetched_pr_head" != "$pr_head_sha" ]]; then
      continue
    fi
    if git merge-base --is-ancestor "$local_head_sha" "$fetched_pr_head"; then
      print "Archive guard: local HEAD is contained in merged pull request: $pr_url"
      exit 0
    fi
  done <<<"$merged_pr_rows"
fi

unique_commits="$(git rev-list --count "$canonical_ref..HEAD")"
if [[ "$unique_commits" == "0" ]]; then
  print "Archive guard: this branch has no commits outside $canonical_ref."
  exit 0
fi

print -u2 "Archive guard: $branch still has $unique_commits commit(s) not landed in $canonical_ref."
print -u2 "Run conductor-land after testing, or explicitly abandon the branch before archiving."
exit 1
