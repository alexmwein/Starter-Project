#!/usr/bin/env python3
"""Read-only usage inspector for isolated Claude account profiles."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STORE = Path(os.environ.get("CLAUDE_ACCOUNT_STORE", Path.home() / ".claude-accounts"))
PROFILE_ROOT = Path(os.environ.get("CLAUDE_PROFILE_ROOT", Path.home() / ".claude-profiles"))
SELECTED = Path(
    os.environ.get("CLAUDE_ACCOUNT_SELECTED_FILE", STORE / ".conductor-active")
)
CACHE = STORE / ".usage-cache.json"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USER_AGENT = "claude-cli/2.1.201 (external, cli)"


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(payload))
    tmp.chmod(0o600)
    os.replace(tmp, path)


def account_names() -> list[str]:
    names = {path.stem for path in STORE.glob("*.json") if not path.name.startswith(".")}
    if PROFILE_ROOT.exists():
        names.update(
            path.name
            for path in PROFILE_ROOT.iterdir()
            if path.is_dir() and (path / ".credentials.json").exists()
        )
    return sorted(names)


def credentials(name: str) -> dict | None:
    profile_dir = PROFILE_ROOT / name
    service = (
        "Claude Code-credentials-"
        + hashlib.sha256(str(profile_dir).encode()).hexdigest()[:8]
    )
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        keychain = json.loads(result.stdout)
        if keychain:
            return keychain
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError):
        pass
    profile = read_json(PROFILE_ROOT / name / ".credentials.json")
    return profile or read_json(STORE / f"{name}.json")


def token_state(name: str) -> tuple[str, str | None, bool]:
    blob = credentials(name) or {}
    oauth = blob.get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    expires_at = oauth.get("expiresAt") or 0
    usable = bool(token and expires_at > (time.time() + 60) * 1000)
    return name, token, usable


def read_usage(token: str) -> dict | None:
    request = urllib.request.Request(USAGE_URL)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("User-Agent", USER_AGENT)
    request.add_header("anthropic-beta", "oauth-2025-04-20")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())
    except (urllib.error.HTTPError, OSError, ValueError):
        return None


def normalized(reading: dict) -> dict:
    five_hour = reading.get("five_hour") or {}
    seven_day = reading.get("seven_day") or {}
    return {
        "five_hour": five_hour.get("utilization"),
        "five_hour_resets_at": five_hour.get("resets_at"),
        "seven_day": seven_day.get("utilization"),
        "seven_day_resets_at": seven_day.get("resets_at"),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


def projected(entry: dict | None) -> dict | None:
    if not entry:
        return None
    now = datetime.now(timezone.utc)
    result = dict(entry)
    for usage_key, reset_key in (
        ("five_hour", "five_hour_resets_at"),
        ("seven_day", "seven_day_resets_at"),
    ):
        reset = entry.get(reset_key)
        if not reset or entry.get(usage_key) is None:
            continue
        try:
            if datetime.fromisoformat(reset) <= now:
                result[usage_key] = 0.0
                result[reset_key] = None
        except ValueError:
            pass
    return result


def format_reset(value: str | None) -> str:
    if not value:
        return "-"
    try:
        minutes = int(
            (datetime.fromisoformat(value) - datetime.now(timezone.utc)).total_seconds()
            // 60
        )
        if minutes <= 0:
            return "now"
        days, minutes = divmod(minutes, 1440)
        hours, minutes = divmod(minutes, 60)
        if days:
            return f"in {days}d {hours}h" if hours else f"in {days}d"
        if hours:
            return f"in {hours}h {minutes}m" if minutes else f"in {hours}h"
        return f"in {minutes}m"
    except (TypeError, ValueError):
        return "?"


def format_age(value: str | None) -> str:
    if not value:
        return ""
    try:
        minutes = int(
            (datetime.now(timezone.utc) - datetime.fromisoformat(value)).total_seconds()
            // 60
        )
        if minutes < 60:
            return f"{minutes}m"
        if minutes < 1440:
            return f"{minutes // 60}h"
        return f"{minutes // 1440}d"
    except (TypeError, ValueError):
        return ""


def main() -> int:
    cache = read_json(CACHE) or {}
    states = [token_state(name) for name in account_names()]
    live: dict[str, dict] = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(states) or 1)) as pool:
        futures = {
            pool.submit(read_usage, token): name
            for name, token, usable in states
            if usable and token
        }
        for future in concurrent.futures.as_completed(futures):
            reading = future.result()
            if reading:
                name = futures[future]
                live[name] = normalized(reading)
                cache[name] = live[name]

    atomic_write(CACHE, cache)
    try:
        selected = SELECTED.read_text().strip()
    except OSError:
        selected = ""

    rows = []
    for name, _, usable in states:
        entry = live.get(name) or projected(cache.get(name))
        rows.append(
            {
                "name": name,
                "selected": name == selected,
                "authenticated": usable,
                "usage": entry,
                "cached": name not in live,
            }
        )

    if "--json" in sys.argv:
        print(json.dumps({"accounts": rows}))
        return 0

    if "--best" in sys.argv:
        candidates = []
        for row in rows:
            entry = row["usage"] or {}
            five_hour = entry.get("five_hour")
            seven_day = entry.get("seven_day")
            if row["authenticated"] and five_hour is not None and (seven_day or 0) < 95:
                candidates.append((five_hour, seven_day or 0, row["name"]))
        if not candidates:
            return 1
        print(min(candidates)[2])
        return 0

    print(f"{'':2}{'account':<24}{'5h used':>8}  {'resets':<11}{'7d used':>8}  {'resets':<11}")
    for row in rows:
        marker = "*" if row["selected"] else " "
        entry = row["usage"] or {}
        five_hour = entry.get("five_hour")
        seven_day = entry.get("seven_day")
        if not row["authenticated"]:
            print(f"{marker:2}{row['name']:<24}{'—':>8}  login required")
            continue
        if five_hour is None:
            print(f"{marker:2}{row['name']:<24}{'—':>8}  no usage data")
            continue
        age = format_age(entry.get("checked_at"))
        cached = f" ~{age} old" if row["cached"] and age else ""
        print(
            f"{marker:2}{row['name']:<24}{five_hour:>7.0f}%  "
            f"{format_reset(entry.get('five_hour_resets_at')):<11}"
            f"{(seven_day or 0):>7.0f}%  "
            f"{format_reset(entry.get('seven_day_resets_at')):<11}{cached}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
