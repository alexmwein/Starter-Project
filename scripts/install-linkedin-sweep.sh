#!/bin/bash
set -euo pipefail

STATE="$HOME/.local/state/linkedin-applicants"
REPO="$STATE/repo"
PLIST="$HOME/Library/LaunchAgents/com.ovo.linkedin-applicant-sweep.plist"
DOMAIN="gui/$(id -u)"
LABEL="com.ovo.linkedin-applicant-sweep"

mkdir -p "$STATE/deltas" "$HOME/Library/LaunchAgents"

if [[ ! -f "$STATE/jobs.json" ]]; then
  cat > "$STATE/jobs.json" <<'JSON'
{"jobs":[{"id":"4452746983","label":"ovo-intern-2026-08","active":true}]}
JSON
  chmod 600 "$STATE/jobs.json"
fi

if [[ ! -f "$STATE/config.json" ]]; then
  cat > "$STATE/config.json" <<'JSON'
{"crm_import_script":null}
JSON
  chmod 600 "$STATE/config.json"
fi

if [[ -d "$REPO/.git" ]]; then
  git -C "$REPO" pull --ff-only
elif [[ -e "$REPO" ]]; then
  echo "Refusing to replace non-git path: $REPO" >&2
  exit 1
else
  git clone --depth 1 --branch main https://github.com/alexmwein/Starter-Project.git "$REPO"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd \$HOME/.local/state/linkedin-applicants/repo &amp;&amp; git pull --ff-only &amp;&amp; node scripts/linkedin-applicant-sweep.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>$STATE/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE/launchd.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
