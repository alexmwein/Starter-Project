#!/usr/bin/env bash
set -euo pipefail

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  command_text=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
else
  command_text="$input"
fi

if printf '%s' "$command_text" | grep -Eiq '(delegate-sol|gpt-5\.6-sol|model_reasoning_effort)' &&
   printf '%s' "$command_text" | grep -Eiq '(^|[^[:alnum:]_])ultra([^[:alnum:]_]|$)'; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The ultra effort tier is disabled. Use max for the hardest single-agent work; ultra may trigger hidden self-delegation and uncontrolled spend."}}'
fi
