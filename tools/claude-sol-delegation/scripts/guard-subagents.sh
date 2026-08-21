#!/usr/bin/env bash
set -euo pipefail

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  model=$(printf '%s' "$input" | jq -r '.tool_input.model // ""' 2>/dev/null || true)
else
  model=$(printf '%s' "$input" | tr '\n' ' ' | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

model_lower=$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]')

case "$model_lower" in
  fable|*fable*)
    exit 0
    ;;
  ""|opus|sonnet|haiku|*claude*|*opus*|*sonnet*|*haiku*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Claude-model subagent fan-out is disabled by claude-sol-delegation. Keep orchestration and judgment in this Claude session; use delegate-sol to send multi-step non-visual execution to gpt-5.6-sol. Fable remains allowed for visual design work."}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
