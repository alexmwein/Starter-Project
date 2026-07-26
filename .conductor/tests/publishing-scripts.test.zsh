#!/bin/zsh

set -euo pipefail
export GIT_AUTOPUSH=0

script_dir="${0:A:h}"
repo_root="${script_dir:h:h}"
land_script="$repo_root/.conductor/scripts/conductor-land.zsh"
archive_script="$repo_root/.conductor/scripts/archive-guard.zsh"
workflow_file="$repo_root/.github/workflows/conductor-autoland.yml"
fake_bin="$script_dir/fixtures"
real_path="$PATH"
task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT

fail() {
  print -u2 "FAIL: $1"
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

configure_identity() {
  git -C "$1" config user.name "Conductor Test"
  git -C "$1" config user.email "conductor-test@example.com"
}

create_land_fixture() {
  local bare_repo="$task_tmp/land-origin.git"
  local seed_repo="$task_tmp/land-seed"
  local work_repo="$task_tmp/land-work"

  git init --bare -q "$bare_repo"
  git init -q "$seed_repo"
  configure_identity "$seed_repo"
  print "base" >"$seed_repo/file.txt"
  git -C "$seed_repo" add file.txt
  git -C "$seed_repo" commit -q -m "base"
  git -C "$seed_repo" branch -M main
  git -C "$seed_repo" remote add origin "$bare_repo"
  git -C "$seed_repo" push -q -u origin main
  git -C "$bare_repo" symbolic-ref HEAD refs/heads/main

  git clone -q "$bare_repo" "$work_repo"
  configure_identity "$work_repo"
  git -C "$work_repo" switch -q -c feature
  print "feature" >>"$work_repo/file.txt"
  git -C "$work_repo" add file.txt
  git -C "$work_repo" commit -q -m "feature"
  git -C "$work_repo" remote set-url origin https://github.com/example/repo.git
  git -C "$work_repo" config "url.file://$bare_repo.insteadOf" https://github.com/example/repo.git

  print -r -- "$work_repo"
}

create_archive_fixture() {
  local bare_repo="$task_tmp/archive-origin.git"
  local source_repo="$task_tmp/archive-source"
  local work_repo="$task_tmp/archive-work"
  local local_sha
  local pr_head_sha
  local merge_sha

  git init --bare -q "$bare_repo"
  git init -q "$source_repo"
  configure_identity "$source_repo"
  print "base" >"$source_repo/base.txt"
  git -C "$source_repo" add base.txt
  git -C "$source_repo" commit -q -m "base"
  git -C "$source_repo" branch -M main
  git -C "$source_repo" switch -q -c feature
  print "feature" >"$source_repo/feature.txt"
  git -C "$source_repo" add feature.txt
  git -C "$source_repo" commit -q -m "feature"
  local_sha="$(git -C "$source_repo" rev-parse HEAD)"
  git -C "$source_repo" switch -q main
  print "new main" >>"$source_repo/base.txt"
  git -C "$source_repo" add base.txt
  git -C "$source_repo" commit -q -m "advance main"
  git -C "$source_repo" switch -q feature
  git -C "$source_repo" merge -q --no-edit main >/dev/null
  pr_head_sha="$(git -C "$source_repo" rev-parse HEAD)"
  git -C "$source_repo" switch -q main
  git -C "$source_repo" merge -q --squash feature >/dev/null
  git -C "$source_repo" commit -q -m "squash feature"
  merge_sha="$(git -C "$source_repo" rev-parse HEAD)"
  git -C "$source_repo" remote add origin "$bare_repo"
  git -C "$source_repo" push -q origin main
  git -C "$source_repo" push -q origin "${pr_head_sha}:refs/pull/42/head"
  git -C "$bare_repo" symbolic-ref HEAD refs/heads/main

  git clone -q "$bare_repo" "$work_repo"
  configure_identity "$work_repo"
  git -C "$work_repo" fetch -q origin refs/pull/42/head
  git -C "$work_repo" branch feature "$local_sha"
  git -C "$work_repo" switch -q feature
  git -C "$work_repo" remote set-url origin https://github.com/example/repo.git
  git -C "$work_repo" config "url.file://$bare_repo.insteadOf" https://github.com/example/repo.git

  print -r -- "$work_repo|$local_sha|$pr_head_sha|$merge_sha"
}

help_output="$("$land_script" --help)"
assert_contains "$help_output" "serialized background landing"

if "$land_script" --invalid >/dev/null 2>&1; then
  fail "invalid conductor-land argument unexpectedly succeeded"
fi

land_repo="$(create_land_fixture)"
land_head="$(git -C "$land_repo" rev-parse HEAD)"
land_log="$task_tmp/land-gh.log"
: >"$land_log"
land_output="$(
  cd "$land_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_GH_LOG="$land_log" \
    FAKE_HEAD_SHA="$land_head" \
    "$land_script"
)"
assert_contains "$land_output" "QUEUED https://github.com/example/repo/pull/1"
assert_contains "$land_output" "GitHub will reconcile, test, and squash-merge in the background."
if grep -Eq '^pr (checks|merge)' "$land_log"; then
  fail "default conductor-land waited for checks or merge"
fi
remote_land_head="$(
  git -C "$land_repo" ls-remote origin refs/heads/feature |
    awk '{print $1}'
)"
[[ "$remote_land_head" == "$land_head" ]] || fail "remote feature SHA differs from local HEAD"

: >"$land_log"
requeue_output="$(
  cd "$land_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_EXISTING_PR=true \
    FAKE_GH_LOG="$land_log" \
    FAKE_HEAD_SHA="$land_head" \
    "$land_script"
)"
assert_contains "$requeue_output" "QUEUED https://github.com/example/repo/pull/1"
if grep -q '^pr create' "$land_log"; then
  fail "requeue attempted to create a duplicate pull request"
fi

main_sha="$(git -C "$land_repo" rev-parse origin/main)"
wait_output="$(
  cd "$land_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_GH_LOG="$land_log" \
    FAKE_HEAD_SHA="$land_head" \
    FAKE_MERGE_SHA="$main_sha" \
    CONDUCTOR_LAND_TIMEOUT_SECONDS=1 \
    "$land_script" --wait
)"
assert_contains "$wait_output" "LANDED https://github.com/example/repo/pull/1"

worker_repo="$task_tmp/land-seed"
print "new main" >"$worker_repo/main.txt"
git -C "$worker_repo" add main.txt
git -C "$worker_repo" commit -q -m "advance main"
git -C "$worker_repo" push -q origin main
git -C "$worker_repo" fetch -q origin feature
git -C "$worker_repo" switch -q -c worker-feature --track origin/feature
git -C "$worker_repo" merge -q --no-edit origin/main >/dev/null
worker_head="$(git -C "$worker_repo" rev-parse HEAD)"
git -C "$worker_repo" push -q origin HEAD:feature

: >"$land_log"
reconciled_output="$(
  cd "$land_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_EXISTING_PR=true \
    FAKE_GH_LOG="$land_log" \
    FAKE_HEAD_SHA="$worker_head" \
    "$land_script"
)"
assert_contains "$reconciled_output" "remote reconciliation head $worker_head already contains local HEAD"
assert_contains "$reconciled_output" "QUEUED https://github.com/example/repo/pull/1"

print "local fix" >>"$land_repo/file.txt"
git -C "$land_repo" add file.txt
git -C "$land_repo" commit -q -m "local fix after remote reconciliation"
if (
  cd "$land_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_EXISTING_PR=true \
    FAKE_GH_LOG="$land_log" \
    FAKE_HEAD_SHA="$worker_head" \
    "$land_script" >/dev/null 2>&1
); then
  fail "conductor-land accepted divergent local and remote feature histories"
fi

archive_fixture="$(create_archive_fixture)"
archive_repo="${archive_fixture%%|*}"
archive_rest="${archive_fixture#*|}"
archive_local_sha="${archive_rest%%|*}"
archive_rest="${archive_rest#*|}"
archive_pr_head_sha="${archive_rest%%|*}"

archive_output="$(
  cd "$archive_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_GH_MODE=archive \
    FAKE_PR_HEAD_SHA="$archive_pr_head_sha" \
    "$archive_script"
)"
assert_contains "$archive_output" "local HEAD is contained in merged pull request"
[[ "$(git -C "$archive_repo" rev-parse HEAD)" == "$archive_local_sha" ]] ||
  fail "archive fixture moved local HEAD"

if (
  cd "$archive_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_GH_MODE=archive \
    FAKE_PR_HEAD_SHA=1111111111111111111111111111111111111111 \
    "$archive_script" >/dev/null 2>&1
); then
  fail "archive guard accepted a mismatched immutable pull ref"
fi

print "post-enqueue" >>"$archive_repo/feature.txt"
git -C "$archive_repo" add feature.txt
git -C "$archive_repo" commit -q -m "post-enqueue work"
if (
  cd "$archive_repo"
  PATH="$fake_bin:$real_path" \
    FAKE_GH_MODE=archive \
    FAKE_PR_HEAD_SHA="$archive_pr_head_sha" \
    "$archive_script" >/dev/null 2>&1
); then
  fail "archive guard accepted a local post-enqueue commit"
fi

grep -Fq -- '--state merged' "$workflow_file" ||
  fail "background cleanup does not scan merged queue items"
grep -Fq -- '--label "conductor-autoland"' "$workflow_file" ||
  fail "background cleanup is not limited to Conductor queue items"
grep -Fq -- '.isCrossRepository == false' "$workflow_file" ||
  fail "background cleanup does not reject fork pull requests"
grep -Fq -- '.baseRefName == $default_branch' "$workflow_file" ||
  fail "background cleanup is not limited to the default branch"
grep -Fq -- 'grep -Fxq "$head_ref" <<<"$open_head_refs"' "$workflow_file" ||
  fail "background cleanup does not preserve open pull-request reuse"
grep -Fq -- '--force-with-lease="refs/heads/$head_ref:$expected_head_sha"' "$workflow_file" ||
  fail "background cleanup does not compare-and-swap the exact merged head"
grep -Fq -- 'clear_queue_label "$pr_number"' "$workflow_file" ||
  fail "background cleanup does not terminalize completed queue labels"
grep -Fq -- 'CONDUCTOR_AUTOLAND_DEPLOY_KEY is not configured; merged branch cleanup cannot continue' "$workflow_file" ||
  fail "background cleanup hides a missing credential"

cleanup_expected_sha="$(git -C "$worker_repo" rev-parse HEAD)"
git -C "$worker_repo" push -q \
  --force-with-lease="refs/heads/feature:$cleanup_expected_sha" \
  origin \
  :refs/heads/feature
if git -C "$worker_repo" ls-remote --exit-code --heads origin refs/heads/feature >/dev/null 2>&1; then
  fail "exact cleanup lease did not delete an unchanged merged branch"
fi

print "reused branch" >"$worker_repo/reused.txt"
git -C "$worker_repo" add reused.txt
git -C "$worker_repo" commit -q -m "reuse branch after merge"
reused_head_sha="$(git -C "$worker_repo" rev-parse HEAD)"
git -C "$worker_repo" push -q origin HEAD:feature
if git -C "$worker_repo" push \
  --force-with-lease="refs/heads/feature:$cleanup_expected_sha" \
  origin \
  :refs/heads/feature >/dev/null 2>&1
then
  fail "stale cleanup lease deleted a reused branch"
fi
remote_reused_sha="$(
  git -C "$worker_repo" ls-remote origin refs/heads/feature |
    awk '{print $1}'
)"
[[ "$remote_reused_sha" == "$reused_head_sha" ]] ||
  fail "stale cleanup lease changed the reused branch"

print "PASS: Conductor publishing scripts"
