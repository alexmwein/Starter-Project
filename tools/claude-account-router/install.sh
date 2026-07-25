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
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$BACKUP_ROOT/$stamp"

mkdir -p "$TARGET_BIN" "$STORE" "$PROFILE_ROOT" "$GLOBAL_CONFIG/projects" "$backup"
chmod 700 "$TARGET_BIN" "$STORE" "$PROFILE_ROOT" "$BACKUP_ROOT" "$backup"

for name in claude-acct claude-acct-run claude-acct-usage.py conductor-claude; do
  if [ -e "$TARGET_BIN/$name" ]; then
    cp -p "$TARGET_BIN/$name" "$backup/$name"
  fi
  install -m 700 "$BIN_SOURCE/$name" "$TARGET_BIN/$name"
done

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
