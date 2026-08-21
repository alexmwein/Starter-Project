#!/usr/bin/env bash
set -euo pipefail

event_name="${1:-UserPromptSubmit}"
message='[claude-sol-delegation] Keep orchestration, judgment, visual direction, review, and the final answer in Claude. Delegate multi-step non-visual work such as implementation, debugging, repository inspection, research, tests, data work, infrastructure, CI/CD, scripting, and log analysis to gpt-5.6-sol with delegate-sol. Choose low, medium, high, xhigh, or max effort; never ultra. Give Sol a bounded brief with scope, constraints, validation, and a completion receipt. Do not delegate a single trivial operation when the round trip is larger than the work, and do not claim a background job is complete until you inspect its result.'

case "$event_name" in
  SessionStart|UserPromptSubmit) ;;
  *) event_name="UserPromptSubmit" ;;
esac

if [ "$event_name" = "SessionStart" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  active_jobs=$("$script_dir/../bin/delegate-sol" active 2>/dev/null | head -5 | tr '\n' ';' || true)
  if [ -n "$active_jobs" ]; then
    message="$message Active delegated jobs already exist; do not relaunch them. Inspect with delegate-sol status or delegate-sol tail: $active_jobs"
  fi
fi

escaped_message=${message//\\/\\\\}
escaped_message=${escaped_message//\"/\\\"}

printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
  "$event_name" "$escaped_message"
