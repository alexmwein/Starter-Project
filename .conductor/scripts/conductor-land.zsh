#!/bin/zsh

set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: conductor-land

Publish the current clean feature branch, create or update its pull request,
wait for reported checks, squash-merge it, and verify the result on GitHub.

The branch must already contain the latest origin default branch and must have
been tested after reconciliation.
HELP
  exit 0
fi

if [[ "$#" != "0" ]]; then
  print -u2 "conductor-land: no arguments are accepted"
  exit 2
fi

for required_command in git gh; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    print -u2 "conductor-land: missing required command: $required_command"
    exit 2
  fi
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  print -u2 "conductor-land: run this inside a Git worktree"
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  print -u2 "conductor-land: uncommitted work remains"
  git status --short >&2
  exit 2
fi

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  print -u2 "conductor-land: detached HEAD is not publishable"
  exit 2
fi

origin_url="$(git remote get-url origin 2>/dev/null || true)"
if [[ "$origin_url" != https://github.com/* && "$origin_url" != git@github.com:* ]]; then
  print -u2 "conductor-land: origin is not a GitHub repository"
  exit 2
fi

github_slug="$(print -r -- "$origin_url" | sed -E 's#^https://github\.com/##; s#^git@github\.com:##; s#\.git$##')"
default_branch="${CONDUCTOR_DEFAULT_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"
if [[ -z "$default_branch" ]]; then
  default_branch="$(gh repo view "$github_slug" --json defaultBranchRef --jq .defaultBranchRef.name)"
fi

if [[ "$branch" == "$default_branch" || "$branch" == "main" || "$branch" == "master" ]]; then
  print -u2 "conductor-land: use a unique feature branch, not $branch"
  exit 2
fi

permission="$(gh repo view "$github_slug" --json viewerPermission --jq .viewerPermission)"
if [[ "$permission" != "ADMIN" && "$permission" != "MAINTAIN" && "$permission" != "WRITE" ]]; then
  print -u2 "conductor-land: GitHub permission for $github_slug is $permission, not writable"
  exit 2
fi

git fetch --prune origin
canonical_ref="origin/$default_branch"
if ! git show-ref --verify --quiet "refs/remotes/$canonical_ref"; then
  print -u2 "conductor-land: canonical branch $canonical_ref does not exist"
  exit 2
fi

if ! git merge-base --is-ancestor "$canonical_ref" HEAD; then
  print -u2 "conductor-land: branch does not contain the latest $canonical_ref"
  print -u2 "Fetch and merge $canonical_ref, resolve both intents, rerun tests, then retry."
  exit 3
fi

unique_commits="$(git rev-list --count "$canonical_ref..HEAD")"
if [[ "$unique_commits" == "0" ]]; then
  print "conductor-land: no commits remain outside $canonical_ref"
  exit 0
fi

local_sha="$(git rev-parse HEAD)"
git push --set-upstream origin "HEAD:refs/heads/$branch"
remote_sha="$(git ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
if [[ "$remote_sha" != "$local_sha" ]]; then
  print -u2 "conductor-land: remote branch does not match local HEAD"
  print -u2 "Local:  $local_sha"
  print -u2 "Remote: ${remote_sha:-missing}"
  exit 3
fi

pr_url="$(gh pr list --repo "$github_slug" --state open --base "$default_branch" --head "$branch" --limit 1 --json url --jq '.[0].url // empty')"
if [[ -z "$pr_url" ]]; then
  pr_url="$(gh pr create --repo "$github_slug" --base "$default_branch" --head "$branch" --fill)"
fi
print "conductor-land: pull request $pr_url"

check_count="$(gh pr view "$pr_url" --repo "$github_slug" --json statusCheckRollup --jq '.statusCheckRollup | length')"
if [[ "$check_count" != "0" ]]; then
  gh pr checks "$pr_url" --repo "$github_slug" --watch --fail-fast
fi

git fetch --prune origin
if ! git merge-base --is-ancestor "origin/$default_branch" HEAD; then
  print -u2 "conductor-land: $default_branch changed while this branch was being checked"
  print -u2 "Merge the new origin/$default_branch, rerun tests, push, and retry."
  exit 3
fi

if [[ "$(git rev-parse HEAD)" != "$local_sha" ]]; then
  print -u2 "conductor-land: local HEAD changed during landing"
  exit 3
fi

remote_sha="$(git ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
if [[ "$remote_sha" != "$local_sha" ]]; then
  print -u2 "conductor-land: GitHub branch changed during landing"
  exit 3
fi

gh pr merge "$pr_url" \
  --repo "$github_slug" \
  --squash \
  --match-head-commit "$local_sha"

pr_state="$(gh pr view "$pr_url" --repo "$github_slug" --json state --jq .state)"
merge_oid="$(gh pr view "$pr_url" --repo "$github_slug" --json mergeCommit --jq '.mergeCommit.oid // empty')"
if [[ "$pr_state" != "MERGED" || -z "$merge_oid" ]]; then
  print -u2 "conductor-land: pull request is not merged yet: $pr_url"
  exit 3
fi

git fetch --prune origin
if ! git merge-base --is-ancestor "$merge_oid" "origin/$default_branch"; then
  print -u2 "conductor-land: merge commit is not present in origin/$default_branch"
  exit 3
fi

if [[ -n "$(git ls-remote origin "refs/heads/$branch")" ]]; then
  git push origin --delete "refs/heads/$branch"
fi

print "conductor-land: landed $pr_url"
print "conductor-land: origin/$default_branch contains $merge_oid"
