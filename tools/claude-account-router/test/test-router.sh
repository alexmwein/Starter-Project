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
export CLAUDE_SWITCHER_DISCOVERY_BIN="$HOME/.local/bin"
export CLAUDE_ACCOUNT_BACKUP_ROOT="$HOME/backups"
export CLAUDE_ACCOUNT_INSTALL_WATCHER=0
export CONDUCTOR_BIN_DIR="$HOME/conductor-bin"
export CLAUDE_ACCOUNT_SELECTED_FILE="$CLAUDE_ACCOUNT_STORE/.conductor-active"
export CONDUCTOR_CLAUDE_BIN="$TEST_ROOT/fake-claude"
export CAPTURE_FILE="$TEST_ROOT/capture"
export CLAUDE_USAGE_HELPER="$TEST_ROOT/fake-usage"

mkdir -p "$CLAUDE_ACCOUNT_STORE" "$CLAUDE_PROFILE_ROOT/alpha/projects" "$CLAUDE_PROFILE_ROOT/beta/projects" "$CLAUDE_GLOBAL_CONFIG/projects" "$CONDUCTOR_BIN_DIR"
ln -s "$CONDUCTOR_CLAUDE_BIN" "$CONDUCTOR_BIN_DIR/claude"

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

cat > "$CLAUDE_USAGE_HELPER" <<'FAKE'
#!/bin/bash
if [ "${1:-}" = "--best" ]; then
  printf 'beta\n'
fi
FAKE
chmod 700 "$CLAUDE_USAGE_HELPER"

"$ROOT/install.sh" >/dev/null

[ -L "$CLAUDE_PROFILE_ROOT/alpha/projects" ]
[ -f "$CLAUDE_GLOBAL_CONFIG/projects/session.jsonl" ]
[ "$(readlink "$CONDUCTOR_BIN_DIR/claude")" = "$CLAUDE_ACCOUNT_BIN_DIR/conductor-claude" ]
[ "$(readlink "$CONDUCTOR_BIN_DIR/claude-router-target")" = "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CONDUCTOR_CLAUDE_BIN")" ]
[ "$(readlink "$CLAUDE_SWITCHER_DISCOVERY_BIN/claude-switcher")" = "$CLAUDE_ACCOUNT_BIN_DIR/claude-switcher" ]

"$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" use beta >/dev/null
[ "$("$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" current)" = "beta" ]

"$CLAUDE_ACCOUNT_BIN_DIR/conductor-claude" --version
[ "$(sed -n '1p' "$CAPTURE_FILE")" = "$CLAUDE_PROFILE_ROOT/beta" ]
[ "$(sed -n '2p' "$CAPTURE_FILE")" = "--version" ]
[ "$(sed -n '1p' "$CLAUDE_PROFILE_ROOT/beta/CLAUDE.md")" = "# shared instructions" ]

"$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" next >/dev/null
[ "$("$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" current)" = "alpha" ]

# A new process ignores the stale pointer and automatically selects the
# healthiest profile reported by the read-only usage helper.
"$CLAUDE_ACCOUNT_BIN_DIR/conductor-claude" --version
[ "$("$CLAUDE_ACCOUNT_BIN_DIR/claude-acct" current)" = "beta" ]
"$CLAUDE_ACCOUNT_BIN_DIR/claude-switcher" help >/dev/null
"$CLAUDE_SWITCHER_DISCOVERY_BIN/claude-switcher" help >/dev/null

python3 - "$ROOT/bin/claude-rate-limit-watch.py" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("switcher_watch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

command = (
    "/path/agent-binaries/claude/2.1.201/claude "
    "--resume 12345678-1234-1234-1234-123456789abc"
)
assert module.SESSION_PATTERN.search(command).group(1) == "12345678-1234-1234-1234-123456789abc"
module.account_usage = lambda: {
    "healthy": (42.0, 20.0),
    "five-hour-drain": (90.0, 20.0),
    "weekly-drain": (5.0, 95.0),
}
assert module.draining_accounts() == {"five-hour-drain", "weekly-drain"}
PY

echo "router tests passed"
