#!/bin/bash
# Install the account router and preserve existing profile/session data.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SOURCE="$SCRIPT_DIR/bin"
TARGET_BIN="${CLAUDE_ACCOUNT_BIN_DIR:-$HOME/.claude/bin}"
STORE="${CLAUDE_ACCOUNT_STORE:-$HOME/.claude-accounts}"
PROFILE_ROOT="${CLAUDE_PROFILE_ROOT:-$HOME/.claude-profiles}"
GLOBAL_CONFIG="${CLAUDE_GLOBAL_CONFIG:-$HOME/.claude}"
BACKUP_ROOT="${CLAUDE_ACCOUNT_BACKUP_ROOT:-$HOME/.claude-account-router-backups}"
CONDUCTOR_BIN_DIR="${CONDUCTOR_BIN_DIR:-$HOME/Library/Application Support/com.conductor.app/bin}"
CONDUCTOR_CLAUDE_LINK="$CONDUCTOR_BIN_DIR/claude"
CONDUCTOR_ROUTER_TARGET="$CONDUCTOR_BIN_DIR/claude-router-target"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.alexweinstein.claude-switcher.plist"
LEGACY_LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.alexweinstein.claude-account-router.plist"
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$BACKUP_ROOT/$stamp"

mkdir -p "$TARGET_BIN" "$STORE" "$PROFILE_ROOT" "$GLOBAL_CONFIG/projects" "$backup"
chmod 700 "$TARGET_BIN" "$STORE" "$PROFILE_ROOT" "$BACKUP_ROOT" "$backup"

for name in claude-acct claude-acct-run claude-acct-usage.py conductor-claude claude-rate-limit-watch.py claude-switcher; do
  if [ -e "$TARGET_BIN/$name" ]; then
    cp -p "$TARGET_BIN/$name" "$backup/$name"
  fi
  install -m 700 "$BIN_SOURCE/$name" "$TARGET_BIN/$name"
done

# Conductor caches its executable-path setting in the running sidecar. Route
# the live bundled symlink through the launcher so future Claude processes use
# the router immediately, without restarting Conductor or unrelated chats.
if [ -L "$CONDUCTOR_CLAUDE_LINK" ] || [ -e "$CONDUCTOR_CLAUDE_LINK" ]; then
  if [ "$(readlink "$CONDUCTOR_CLAUDE_LINK" 2>/dev/null || true)" != "$TARGET_BIN/conductor-claude" ]; then
    resolved_claude="$(python3 - "$CONDUCTOR_CLAUDE_LINK" <<'PY'
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
)"
    printf '%s\n' "$resolved_claude" > "$backup/conductor-claude-original-target.txt"
    ln -sfn "$resolved_claude" "$CONDUCTOR_ROUTER_TARGET"
  fi
  if [ -x "$CONDUCTOR_ROUTER_TARGET" ]; then
    ln -sfn "$TARGET_BIN/conductor-claude" "$CONDUCTOR_CLAUDE_LINK"
  fi
fi

for snapshot in "$STORE"/*.json; do
  [ -e "$snapshot" ] || continue
  account="$(basename "$snapshot" .json)"
  profile="$PROFILE_ROOT/$account"
  mkdir -p "$profile"
  chmod 700 "$profile"
  if [ ! -f "$profile/.credentials.json" ]; then
    install -m 600 "$snapshot" "$profile/.credentials.json"
  fi

  # Claude stores resumable transcripts under projects. Merge any pre-existing
  # isolated history into the global transcript store, retain a backup, then
  # share the global directory so an affected Conductor chat can resume after
  # selecting another account.
  if [ -d "$profile/projects" ] && [ ! -L "$profile/projects" ]; then
    mkdir -p "$backup/profile-projects/$account"
    rsync -a --ignore-existing "$profile/projects/" "$GLOBAL_CONFIG/projects/"
    mv "$profile/projects" "$backup/profile-projects/$account/projects"
  fi
  if [ ! -e "$profile/projects" ]; then
    ln -s "$GLOBAL_CONFIG/projects" "$profile/projects"
  fi
done

if [ "${CLAUDE_ACCOUNT_INSTALL_WATCHER:-1}" = "1" ] && command -v launchctl >/dev/null 2>&1; then
  mkdir -p "$(dirname "$LAUNCH_AGENT")" "$HOME/Library/Logs"
  "$TARGET_BIN/claude-rate-limit-watch.py" --initialize
  if [ -f "$LEGACY_LAUNCH_AGENT" ]; then
    launchctl bootout "gui/$(id -u)" "$LEGACY_LAUNCH_AGENT" >/dev/null 2>&1 || true
    mv "$LEGACY_LAUNCH_AGENT" "$backup/"
  fi
  cat > "$LAUNCH_AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.alexweinstein.claude-switcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$TARGET_BIN/claude-rate-limit-watch.py</string>
    <string>--interval</string>
    <string>1</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/claude-account-router.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/claude-account-router.err.log</string>
</dict>
</plist>
PLIST
  chmod 600 "$LAUNCH_AGENT"
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
fi

selected="$STORE/.conductor-active"
if [ ! -f "$selected" ]; then
  if [ -f "$STORE/.active" ]; then
    sed -n '1p' "$STORE/.active" > "$selected"
  else
    first=""
    for snapshot in "$STORE"/*.json; do
      [ -e "$snapshot" ] || continue
      first="$(basename "$snapshot" .json)"
      break
    done
    [ -n "$first" ] && printf '%s\n' "$first" > "$selected"
  fi
  [ ! -f "$selected" ] || chmod 600 "$selected"
fi

echo "installed Claude account router"
echo "backup: $backup"
echo "Conductor executable: $TARGET_BIN/conductor-claude"
echo "automatic rate-limit watcher: $LAUNCH_AGENT"
