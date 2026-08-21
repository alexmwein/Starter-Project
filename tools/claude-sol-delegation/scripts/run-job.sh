#!/usr/bin/env bash
set -uo pipefail

exit_file="${1:?missing exit file}"
log_file="${2:?missing log file}"
shift 2

set +e
"$@" </dev/null >"$log_file" 2>&1
exit_code=$?
printf '%s\n' "$exit_code" >"$exit_file"
exit "$exit_code"
