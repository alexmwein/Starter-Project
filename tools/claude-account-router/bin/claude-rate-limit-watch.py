#!/usr/bin/env python3
"""Stop only a Conductor Claude child after a new subscription-limit event.

Conductor's Retry action reuses a live Claude process. A process that has
cached a capped OAuth account therefore keeps returning the same error even
after another account is selected. This watcher observes persisted Claude
transcripts and sends SIGHUP only to the process whose own session just wrote
a rate-limit error. Its next Conductor start is routed to the healthiest
profile by conductor-claude.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

GLOBAL_CONFIG = Path(
    os.environ.get("CLAUDE_GLOBAL_CONFIG", Path.home() / ".claude")
)
PROFILE_ROOT = Path(
    os.environ.get("CLAUDE_PROFILE_ROOT", Path.home() / ".claude-profiles")
)
STORE = Path(os.environ.get("CLAUDE_ACCOUNT_STORE", Path.home() / ".claude-accounts"))
CONDUCTOR_DB = Path(
    os.environ.get(
        "CONDUCTOR_DB",
        Path.home() / "Library/Application Support/com.conductor.app/conductor.db",
    )
)
USAGE_HELPER = Path(
    os.environ.get(
        "CLAUDE_USAGE_HELPER",
        Path.home() / ".claude/bin/claude-acct-usage.py",
    )
)
FIVE_HOUR_DRAIN = float(os.environ.get("CLAUDE_SWITCHER_FIVE_HOUR_DRAIN", "90"))
SEVEN_DAY_DRAIN = float(os.environ.get("CLAUDE_SWITCHER_SEVEN_DAY_DRAIN", "95"))
STATE_FILE = Path(
    os.environ.get(
        "CLAUDE_RATE_LIMIT_STATE", STORE / ".rate-limit-watcher-state.json"
    )
)
SESSION_PATTERN = re.compile(
    r"--(?:session-id|resume)\s+"
    r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"
)
PS_PATTERN = re.compile(
    r"^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$"
)


def load_state() -> dict[str, str]:
    try:
        value = json.loads(STATE_FILE.read_text())
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def save_state(state: dict[str, str]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.parent.chmod(0o700)
    temporary = STATE_FILE.with_name(f"{STATE_FILE.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(state, sort_keys=True))
    temporary.chmod(0o600)
    os.replace(temporary, STATE_FILE)


def parse_process_start(value: str) -> datetime | None:
    try:
        parsed = datetime.strptime(value.strip(), "%a %b %d %H:%M:%S %Y")
        return parsed.astimezone()
    except ValueError:
        return None


def process_account(pid: int) -> str | None:
    result = subprocess.run(
        ["/bin/ps", "eww", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    match = re.search(r"(?:^| )CLAUDE_CONFIG_DIR=([^ ]+)", result.stdout)
    if not match:
        return None
    config_dir = Path(match.group(1))
    try:
        config_dir.relative_to(PROFILE_ROOT)
    except ValueError:
        return None
    return config_dir.name


def active_claude_sessions() -> dict[str, tuple[int, datetime | None, str | None]]:
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,lstart=,command="],
        capture_output=True,
        text=True,
        check=False,
    )
    sessions: dict[str, tuple[int, datetime | None, str | None]] = {}
    for row in result.stdout.splitlines():
        if "/agent-binaries/claude/" not in row:
            continue
        match = PS_PATTERN.match(row)
        if not match:
            continue
        pid, _, started, command = match.groups()
        session = SESSION_PATTERN.search(command)
        if session:
            numeric_pid = int(pid)
            sessions[session.group(1)] = (
                numeric_pid,
                parse_process_start(started),
                process_account(numeric_pid),
            )
    return sessions


def transcript_path(session_id: str) -> Path | None:
    projects = GLOBAL_CONFIG / "projects"
    if not projects.exists():
        return None
    for path in projects.glob(f"*/{session_id}.jsonl"):
        return path
    return None


def latest_rate_limit(path: Path) -> str | None:
    latest = None
    try:
        with path.open(errors="ignore") as transcript:
            for line in transcript:
                if '"rate_limit"' not in line and "session limit" not in line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    event.get("type") == "assistant"
                    and event.get("error") == "rate_limit"
                    and event.get("isApiErrorMessage") is True
                ):
                    timestamp = event.get("timestamp")
                    if isinstance(timestamp, str):
                        latest = timestamp
    except OSError:
        return None
    return latest


def parse_event_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def account_usage() -> dict[str, tuple[float, float]]:
    if not USAGE_HELPER.exists():
        return {}
    try:
        result = subprocess.run(
            [str(USAGE_HELPER), "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    usage = {}
    for row in payload.get("accounts", []):
        entry = row.get("usage") or {}
        five_hour = entry.get("five_hour")
        seven_day = entry.get("seven_day")
        if row.get("authenticated") and five_hour is not None:
            usage[row["name"]] = (float(five_hour), float(seven_day or 0))
    return usage


def draining_accounts() -> set[str]:
    return {
        name
        for name, (five_hour, seven_day) in account_usage().items()
        if five_hour >= FIVE_HOUR_DRAIN or seven_day >= SEVEN_DAY_DRAIN
    }


def session_is_idle(session_id: str) -> bool:
    if not CONDUCTOR_DB.exists():
        return False
    try:
        with sqlite3.connect(f"file:{CONDUCTOR_DB}?mode=ro", uri=True) as database:
            row = database.execute(
                "select status from sessions where id = ?", (session_id,)
            ).fetchone()
        return bool(row and row[0] == "idle")
    except sqlite3.Error:
        return False


def scan(
    *, initialize: bool = False, draining: set[str] | None = None
) -> list[tuple[str, int, str]]:
    state = load_state()
    stopped: list[tuple[str, int, str]] = []
    for session_id, (pid, process_start, account) in active_claude_sessions().items():
        if (
            not initialize
            and account
            and draining
            and account in draining
            and session_is_idle(session_id)
        ):
            try:
                os.kill(pid, signal.SIGHUP)
                stopped.append((session_id, pid, f"{account} reached drain threshold"))
                continue
            except ProcessLookupError:
                continue
            except PermissionError as error:
                print(f"cannot stop Claude process {pid}: {error}", file=sys.stderr)

        path = transcript_path(session_id)
        if not path:
            continue
        event_timestamp = latest_rate_limit(path)
        if not event_timestamp or state.get(session_id) == event_timestamp:
            continue

        event_time = parse_event_time(event_timestamp)
        is_current_process_event = bool(
            event_time
            and process_start
            and event_time.astimezone() >= process_start - timedelta(seconds=2)
        )
        state[session_id] = event_timestamp

        if initialize or not is_current_process_event:
            continue
        try:
            os.kill(pid, signal.SIGHUP)
            stopped.append((session_id, pid, "hard session limit"))
        except ProcessLookupError:
            pass
        except PermissionError as error:
            print(f"cannot stop Claude process {pid}: {error}", file=sys.stderr)
    save_state(state)
    return stopped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--initialize", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()

    if args.initialize:
        scan(initialize=True)
        return 0
    if args.once:
        for session_id, pid, reason in scan(draining=draining_accounts()):
            print(f"stopped Claude session {session_id} (pid {pid}): {reason}")
        return 0

    draining: set[str] = set()
    next_usage_check = 0.0
    while True:
        now = time.monotonic()
        if now >= next_usage_check:
            draining = draining_accounts()
            next_usage_check = now + 60
        for session_id, pid, reason in scan(draining=draining):
            print(
                f"stopped Claude session {session_id} (pid {pid}): {reason}",
                flush=True,
            )
        time.sleep(max(args.interval, 0.25))


if __name__ == "__main__":
    raise SystemExit(main())
