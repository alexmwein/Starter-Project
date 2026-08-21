#!/usr/bin/env bash
set -euo pipefail

plugin_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_tmp=$(mktemp -d)
trap 'rm -rf "$test_tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  printf '%s' "$haystack" | grep -Fq -- "$needle" || fail "expected '$needle'"
}

mkdir -p "$test_tmp/bin" "$test_tmp/work" "$test_tmp/state"
git -C "$test_tmp/work" init -q

cat >"$test_tmp/bin/codex" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--version" ]; then
  echo "codex-cli mock"
  exit 0
fi
printf '%s\n' "$@" >"${MOCK_CODEX_ARGS:?}"
[ "${MOCK_CODEX_SLEEP:-0}" = "0" ] || sleep "$MOCK_CODEX_SLEEP"
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then
    output="$arg"
  fi
  previous="$arg"
done
[ -z "$output" ] || printf '%s\n' 'MOCK_RESULT' >"$output"
echo "MOCK_CODEX_OK"
MOCK
chmod +x "$test_tmp/bin/codex"

cat >"$test_tmp/bin/sol" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
echo "MOCK_SOL_OK"
MOCK
chmod +x "$test_tmp/bin/sol"

export PATH="$test_tmp/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export MOCK_CODEX_ARGS="$test_tmp/codex-args"
export CLAUDE_SOL_STATE_DIR="$test_tmp/state"
export CLAUDE_SOL_CONFIG="$test_tmp/missing-config"

foreground_output=$("$plugin_root/bin/delegate-sol" --foreground --effort xhigh --sandbox read-only --workdir "$test_tmp/work" -- "inspect the repo")
assert_contains "$foreground_output" "MOCK_CODEX_OK"
assert_contains "$foreground_output" "DELEGATION_COMPLETE"
foreground_job=$(printf '%s' "$foreground_output" | sed -n 's/^DELEGATION_COMPLETE job=\([^ ]*\).*/\1/p')
[ -n "$foreground_job" ] || fail "missing foreground job id"
foreground_status=$("$plugin_root/bin/delegate-sol" status "$foreground_job")
assert_contains "$foreground_status" "state=finished"
args=$(cat "$MOCK_CODEX_ARGS")
assert_contains "$args" "gpt-5.6-sol"
assert_contains "$args" 'model_reasoning_effort="xhigh"'
assert_contains "$args" "read-only"
assert_contains "$args" "$test_tmp/work"
assert_contains "$args" "inspect the repo"

sol_output=$("$plugin_root/bin/delegate-sol" --foreground --runner sol --effort high --sandbox danger-full-access --workdir "$test_tmp/work" -- "use the seat-aware runner")
assert_contains "$sol_output" "MOCK_SOL_OK"
assert_contains "$sol_output" "runner=sol exit=0"
sol_result=$(printf '%s' "$sol_output" | sed -n 's/^result=//p')
[ -L "$sol_result" ] || fail "sol result path is not linked to its full log"
grep -Fq "MOCK_SOL_OK" "$sol_result" || fail "sol result log is unreadable"
if "$plugin_root/bin/delegate-sol" --runner sol --sandbox workspace-write -- "bad sandbox" >/dev/null 2>&1; then
  fail "sol runner accepted an implicit sandbox mismatch"
fi

if "$plugin_root/bin/delegate-sol" --effort ultra -- "bad" >/dev/null 2>&1; then
  fail "ultra effort was accepted"
fi
if "$plugin_root/bin/delegate-sol" wait '../../escape' --timeout 0 >/dev/null 2>&1; then
  fail "unsafe job id was accepted"
fi

export MOCK_CODEX_SLEEP=2
background_output=$("$plugin_root/bin/delegate-sol" --effort low --workdir "$test_tmp/work" -- "background check")
assert_contains "$background_output" "DELEGATION_STARTED"
job_id=$(printf '%s' "$background_output" | sed -n 's/^DELEGATION_STARTED job=\([^ ]*\).*/\1/p')
[ -n "$job_id" ] || fail "missing job id"
active_output=$("$plugin_root/bin/delegate-sol" active)
assert_contains "$active_output" "job=$job_id state=running"
"$plugin_root/bin/delegate-sol" wait "$job_id" --timeout 10 >/dev/null
unset MOCK_CODEX_SLEEP
status_output=$("$plugin_root/bin/delegate-sol" status "$job_id")
assert_contains "$status_output" "state=finished"
assert_contains "$status_output" "exit=0"

session_json=$("$plugin_root/scripts/inject-context.sh" SessionStart)
printf '%s' "$session_json" | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["hookSpecificOutput"]["hookEventName"] == "SessionStart"'

opus_guard=$(printf '%s' '{"tool_input":{"model":"opus"}}' | "$plugin_root/scripts/guard-subagents.sh")
assert_contains "$opus_guard" '"permissionDecision":"deny"'
fable_guard=$(printf '%s' '{"tool_input":{"model":"fable"}}' | "$plugin_root/scripts/guard-subagents.sh")
[ -z "$fable_guard" ] || fail "fable was denied"

ultra_guard=$(printf '%s' '{"tool_input":{"command":"delegate-sol --effort ultra -- task"}}' | "$plugin_root/scripts/guard-ultra.sh")
assert_contains "$ultra_guard" '"permissionDecision":"deny"'
reversed_ultra_guard=$(printf '%s' '{"tool_input":{"command":"model_reasoning_effort=ultra codex exec -m gpt-5.6-sol task"}}' | "$plugin_root/scripts/guard-ultra.sh")
assert_contains "$reversed_ultra_guard" '"permissionDecision":"deny"'
max_guard=$(printf '%s' '{"tool_input":{"command":"delegate-sol --effort max -- task"}}' | "$plugin_root/scripts/guard-ultra.sh")
[ -z "$max_guard" ] || fail "max effort was denied"

mkdir -p "$test_tmp/home/.claude/skills" "$test_tmp/home/.claude-profiles/profile"
ln -s "$test_tmp/home/.claude/skills" "$test_tmp/home/.claude-profiles/profile/skills"
touch "$test_tmp/home/.claude-profiles/profile/CLAUDE.md"
mkdir -p "$test_tmp/home/.claude-profiles/.locks"
dry_run=$(HOME="$test_tmp/home" "$plugin_root/install.sh" --all-profiles --dry-run)
assert_contains "$dry_run" ".claude/skills/claude-sol-delegation"
assert_contains "$dry_run" "SKIP_DUPLICATE profile=$test_tmp/home/.claude-profiles/profile"
would_install_count=$(printf '%s\n' "$dry_run" | grep -c '^WOULD_INSTALL ')
[ "$would_install_count" = "1" ] || fail "shared skills destination was installed more than once"

HOME="$test_tmp/home" "$plugin_root/install.sh" --runner codex >/dev/null
HOME="$test_tmp/home" "$plugin_root/install.sh" --runner codex >/dev/null
[ -f "$test_tmp/home/.claude/skills/claude-sol-delegation/config.local" ] || fail "plugin was not installed"
if find "$test_tmp/home/.claude/skills" -maxdepth 1 -name 'claude-sol-delegation.backup-*' | grep -q .; then
  fail "backup was left in the auto-loaded skills directory"
fi
backup_count=$(find "$test_tmp/home/.claude/backups/claude-sol-delegation" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
[ "$backup_count" = "1" ] || fail "expected one recoverable plugin backup"

echo "PASS: claude-sol-delegation"
