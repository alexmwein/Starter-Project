#!/bin/zsh

set -euo pipefail

wait_for_merge=false
case "${1:-}" in
  "")
    ;;
  --wait)
    wait_for_merge=true
    ;;
  -h|--help)
    cat <<'HELP'
Usage: conductor-land [--wait]

Publish the current clean feature branch, verify the exact remote SHA, create
or update its pull request, and enqueue it for serialized background landing.
The default command returns as soon as GitHub owns the durable queue item.

Use --wait only when the caller explicitly needs to remain attached until the
pull request is merged and verified on GitHub's default branch.
HELP
    exit 0
    ;;
  *)
    print -u2 "conductor-land: accepted arguments: --wait, --help"
    exit 2
    ;;
esac

if [[ "$#" -gt 1 ]]; then
  print -u2 "conductor-land: accepted arguments: --wait, --help"
  exit 2
fi

for required_command in git gh jq; do
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

origin_url="$(git config --get remote.origin.url 2>/dev/null || true)"
if [[ "$origin_url" != https://github.com/* && "$origin_url" != git@github.com:* ]]; then
  print -u2 "conductor-land: origin is not a GitHub repository"
  exit 2
fi

github_slug="$(print -r -- "$origin_url" | sed -E 's#^https://github\.com/##; s#^git@github\.com:##; s#\.git$##')"
github_owner="${github_slug%%/*}"
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

workflow_state="$(
  gh api \
    "repos/$github_slug/actions/workflows/conductor-autoland.yml" \
    --jq '.state' 2>/dev/null || true
)"
if [[ "$workflow_state" != "active" ]]; then
  print -u2 "conductor-land: $github_slug does not have an active Conductor autoland worker"
  print -u2 "Install .github/workflows/conductor-autoland.yml and its repo-scoped deploy key first."
  exit 3
fi

git fetch --prune origin
canonical_ref="origin/$default_branch"
if ! git show-ref --verify --quiet "refs/remotes/$canonical_ref"; then
  print -u2 "conductor-land: canonical branch $canonical_ref does not exist"
  exit 2
fi
if ! git merge-base "$canonical_ref" HEAD >/dev/null 2>&1; then
  print -u2 "conductor-land: this branch has no common history with $canonical_ref"
  exit 3
fi

unique_commits="$(git rev-list --count "$canonical_ref..HEAD")"
if [[ "$unique_commits" == "0" ]]; then
  print "conductor-land: no commits remain outside $canonical_ref"
  exit 0
fi

if ! git merge-base --is-ancestor "$canonical_ref" HEAD; then
  print "conductor-land: $canonical_ref advanced; GitHub will reconcile it in the background."
fi

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
publish_sha="$local_sha"

if [[ -n "$remote_sha" && "$remote_sha" != "$local_sha" ]]; then
  if ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    git fetch origin "refs/heads/${branch}:refs/remotes/origin/${branch}"
  fi

  if git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    git push --set-upstream origin "HEAD:refs/heads/$branch"
    remote_sha="$(git ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
  elif git merge-base --is-ancestor "$local_sha" "$remote_sha"; then
    publish_sha="$remote_sha"
    git branch --set-upstream-to="origin/$branch" "$branch" >/dev/null 2>&1 || true
    print "conductor-land: remote reconciliation head $remote_sha already contains local HEAD."
  else
    print -u2 "conductor-land: local and remote $branch have diverged"
    print -u2 "Fetch origin/$branch, reconcile both histories semantically, rerun tests, then retry."
    exit 3
  fi
else
  git push --set-upstream origin "HEAD:refs/heads/$branch"
  remote_sha="$(git ls-remote origin "refs/heads/$branch" | awk '{print $1}')"
fi

if [[ "$remote_sha" != "$publish_sha" ]]; then
  print -u2 "conductor-land: remote branch does not match local HEAD"
  print -u2 "Expected: $publish_sha"
  print -u2 "Remote: ${remote_sha:-missing}"
  exit 3
fi

pr_url="$(
  gh pr list \
    --repo "$github_slug" \
    --state open \
    --base "$default_branch" \
    --head "$branch" \
    --limit 1 \
    --json url \
    --jq '.[0].url // empty'
)"
if [[ -z "$pr_url" ]]; then
  pr_url="$(
    gh pr create \
      --repo "$github_slug" \
      --base "$default_branch" \
      --head "$github_owner:$branch" \
      --fill
  )"
fi

pr_json="$(
  gh pr view "$pr_url" \
    --repo "$github_slug" \
    --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository
)"
pr_number="$(jq -r '.number' <<<"$pr_json")"
verified_url="$(jq -r '.url' <<<"$pr_json")"
pr_state="$(jq -r '.state' <<<"$pr_json")"
pr_draft="$(jq -r '.isDraft' <<<"$pr_json")"
pr_base="$(jq -r '.baseRefName' <<<"$pr_json")"
pr_head="$(jq -r '.headRefName' <<<"$pr_json")"
pr_head_sha="$(jq -r '.headRefOid' <<<"$pr_json")"
pr_head_repo="$(jq -r '.headRepository.nameWithOwner // empty' <<<"$pr_json")"

if [[ "$pr_state" != "OPEN" || "$pr_draft" != "false" ]]; then
  print -u2 "conductor-land: pull request is not an open, ready pull request: $verified_url"
  exit 3
fi
if [[ "$pr_base" != "$default_branch" || "$pr_head" != "$branch" || "$pr_head_repo" != "$github_slug" ]]; then
  print -u2 "conductor-land: pull request refs do not match this same-repository branch"
  exit 3
fi
if [[ "$pr_head_sha" != "$publish_sha" ]]; then
  print -u2 "conductor-land: pull request head does not match the verified remote head"
  print -u2 "Expected: $publish_sha"
  print -u2 "PR:    $pr_head_sha"
  exit 3
fi

gh label create "conductor-autoland" \
  --repo "$github_slug" \
  --color "0E8A16" \
  --description "Queued for serialized background landing" \
  >/dev/null 2>&1 || true
gh label create "conductor-blocked" \
  --repo "$github_slug" \
  --color "B60205" \
  --description "Background landing needs human attention" \
  >/dev/null 2>&1 || true
gh api \
  --method DELETE \
  "repos/$github_slug/issues/$pr_number/labels/conductor-blocked" \
  >/dev/null 2>&1 || true
gh api \
  --method POST \
  "repos/$github_slug/issues/$pr_number/labels" \
  -f "labels[]=conductor-autoland" \
  >/dev/null

if ! gh pr view "$verified_url" \
  --repo "$github_slug" \
  --json labels \
  --jq '[.labels[].name] | index("conductor-autoland") != null' |
  grep -qx true
then
  print -u2 "conductor-land: GitHub did not retain the autoland queue label"
  exit 3
fi

print "conductor-land: QUEUED $verified_url"
print "conductor-land: head $publish_sha"
if [[ "$publish_sha" != "$local_sha" ]]; then
  print "conductor-land: local HEAD $local_sha is preserved in that remote history."
fi
print "conductor-land: GitHub will reconcile, test, and squash-merge in the background."

if [[ "$wait_for_merge" != "true" ]]; then
  exit 0
fi

wait_timeout="${CONDUCTOR_LAND_TIMEOUT_SECONDS:-1800}"
wait_interval="${CONDUCTOR_LAND_POLL_SECONDS:-5}"
if [[ ! "$wait_timeout" =~ ^[0-9]+$ || ! "$wait_interval" =~ ^[1-9][0-9]*$ ]]; then
  print -u2 "conductor-land: wait timeout and poll interval must be positive integers"
  exit 2
fi

elapsed=0
while (( elapsed <= wait_timeout )); do
  wait_json="$(
    gh pr view "$verified_url" \
      --repo "$github_slug" \
      --json state,mergeCommit,labels
  )"
  wait_state="$(jq -r '.state' <<<"$wait_json")"
  if [[ "$wait_state" == "MERGED" ]]; then
    merge_oid="$(jq -r '.mergeCommit.oid // empty' <<<"$wait_json")"
    if [[ -z "$merge_oid" ]]; then
      print -u2 "conductor-land: merged pull request has no merge commit"
      exit 3
    fi
    git fetch --prune origin
    if ! git merge-base --is-ancestor "$merge_oid" "origin/$default_branch"; then
      print -u2 "conductor-land: merge commit is not present in origin/$default_branch"
      exit 3
    fi
    print "conductor-land: LANDED $verified_url"
    print "conductor-land: origin/$default_branch contains $merge_oid"
    exit 0
  fi
  if [[ "$wait_state" != "OPEN" ]]; then
    print -u2 "conductor-land: pull request closed without merging: $verified_url"
    exit 3
  fi
  if jq -e '[.labels[].name] | index("conductor-blocked") != null' \
    >/dev/null <<<"$wait_json"
  then
    print -u2 "conductor-land: background landing is blocked: $verified_url"
    exit 3
  fi

  sleep "$wait_interval"
  (( elapsed += wait_interval ))
done

print -u2 "conductor-land: timed out waiting for background landing: $verified_url"
exit 3
