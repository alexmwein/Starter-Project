#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
export CLAUDE_ACCOUNT_STORE="$HOME/.claude-accounts"
export CLAUDE_PROFILE_ROOT="$HOME/.claude-profiles"
export CLAUDE_GLOBAL_CONFIG="$HOME/.claude"
export CLAUDE_ACCOUNT_BIN_DIR="$HOME/.claude/bin"
export CLAUDE_ACCOUNT_BACKUP_ROOT="$HOME/backups"
export CLAUDE_ACCOUNT_SELECTED_FILE="$CLAUDE_ACCOUNT_STORE/.conductor-active"
export CONDUCTOR_CLAUDE_BIN="$TEST_ROOT/fake-claude"
export CAPTURE_FILE="$TEST_ROOT/capture"

mkdir -p "$CLAUDE_ACCOUNT_STORE" "$CLAUDE_PROFILE_ROOT/alpha/projects" "$CLAUDE_PROFILE_ROOT/beta/projects" "$CLAUDE_GLOBAL_CONFIG/projects"

python3 - "$CLAUDE_ACCOUNT_STORE" "$CLAUDE_PROFILE_ROOT" <<'PY'
import json
import sys
import time
from pathlib import Path

store = Path(sys.argv[1])
profiles = Path(sys.argv[2])
for name in ("alpha", "beta"):
    blob = {
        "claudeAiOauth": {
            "accessToken": f"access-{name}",
            "refreshToken": f"sk-ant-ort-{name}",
            "expiresAt": int((time.time() + 3600) * 1000),
        }
    }
    (store / f"{name}.json").write_text(json.dumps(blob))
    (profiles / name / ".credentials.json").write_text(json.dumps(blob))
PY

printf 'alpha\n' > "$CLAUDE_ACCOUNT_STORE/.active"
printf '# shared instructions\n' > "$CLAUDE_GLOBAL_CONFIG/CLAUDE.md"
printf '{"session":"alpha"}\n' > "$CLAUDE_PROFILE_ROOT/alpha/projects/session.jsonl"

cat > "$CONDUCTOR_CLAUDE_BIN" <<'FAKE'
#!/bin/bash
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
    printf '{"loggedIn":true}\n'
    exit 0
  fi
  printf '{"loggedIn":false}\n'
  exit 1
fi
printf '%s\n' "$CLAUDE_CONFIG_DIR" > "$CAPTURE_FILE"
printf '%s\n' "$*" >> "$CAPTURE_FILE"
FAKE
chmod 700 "$CONDUCTOR_CLAUDE_BIN"

"$ROOT/install.sh" >/dev/null

[ -L "$CLAUDE_PROFILE_ROOT/alpha/projects" ]
[ -f "$CLAUDE_GLOBAL_CONFIG/projects/session.jsonl" ]

"$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" use beta >/dev/null
[ "$("$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" current)" = "beta" ]

"$CLAUDE_ACCOUNT_BIN_DIR/conductor-claude" --version
[ "$(sed -n '1p' "$CAPTURE_FILE")" = "$CLAUDE_PROFILE_ROOT/beta" ]
[ "$(sed -n '2p' "$CAPTURE_FILE")" = "--version" ]
[ "$(sed -n '1p' "$CLAUDE_PROFILE_ROOT/beta/CLAUDE.md")" = "# shared instructions" ]

"$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" next >/dev/null
[ "$("$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" current)" = "alpha" ]

echo "router tests passed"
