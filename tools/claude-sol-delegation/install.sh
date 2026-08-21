#!/usr/bin/env bash
set -euo pipefail

plugin_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
all_profiles=0
dry_run=0
runner="codex"
sandbox="workspace-write"
targets=()
staging=""
staging_profile=""

preserve_failed_staging() {
  if [ -n "$staging" ] && [ -d "$staging" ]; then
    failed_root="$staging_profile/backups/claude-sol-delegation"
    mkdir -p "$failed_root"
    failed_path="$failed_root/failed-install-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mv "$staging" "$failed_path" 2>/dev/null || true
    echo "PRESERVED_FAILED_INSTALL path=$failed_path" >&2
  fi
}

trap preserve_failed_staging EXIT
trap 'preserve_failed_staging; exit 130' INT TERM

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --all-profiles             Install into ~/.claude and ~/.claude-profiles/*
  --target PATH              Install into one Claude config directory (repeatable)
  --runner codex|sol         Delegation runner (default: codex)
  --sandbox MODE             read-only|workspace-write|danger-full-access
  --dry-run                  Print targets without changing them
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --all-profiles)
      all_profiles=1
      shift
      ;;
    --target)
      targets+=("${2:-}")
      shift 2
      ;;
    --runner)
      runner="${2:-}"
      shift 2
      ;;
    --sandbox)
      sandbox="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$runner" in codex|sol) ;; *) echo "install.sh: invalid runner $runner" >&2; exit 2 ;; esac
case "$sandbox" in read-only|workspace-write|danger-full-access) ;; *) echo "install.sh: invalid sandbox $sandbox" >&2; exit 2 ;; esac
[ "$runner" != "sol" ] || [ "$sandbox" = "danger-full-access" ] || {
  echo "install.sh: runner sol requires --sandbox danger-full-access because that runner owns its sandbox policy" >&2
  exit 2
}

if [ "$all_profiles" = "1" ]; then
  targets+=("${CLAUDE_CONFIG_DIR:-${HOME}/.claude}")
  if [ -d "${HOME}/.claude-profiles" ]; then
    while IFS= read -r profile_dir; do
      profile_name=$(basename "$profile_dir")
      case "$profile_name" in .*) continue ;; esac
      [ -f "$profile_dir/settings.json" ] || [ -f "$profile_dir/CLAUDE.md" ] || continue
      targets+=("$profile_dir")
    done < <(find "${HOME}/.claude-profiles" -mindepth 1 -maxdepth 1 -type d -print | sort)
  fi
fi

[ ${#targets[@]} -gt 0 ] || targets+=("${CLAUDE_CONFIG_DIR:-${HOME}/.claude}")

seen_skills_dirs=()
for profile_dir in "${targets[@]}"; do
  [ -n "$profile_dir" ] || { echo "install.sh: empty target" >&2; exit 2; }
  skills_dir="$profile_dir/skills"
  if [ -d "$skills_dir" ]; then
    skills_real=$(CDPATH= cd -- "$skills_dir" && pwd -P)
  else
    skills_real="$skills_dir"
  fi

  duplicate=0
  if [ ${#seen_skills_dirs[@]} -gt 0 ]; then
    for seen_skills_dir in "${seen_skills_dirs[@]}"; do
      if [ "$skills_real" = "$seen_skills_dir" ]; then
        duplicate=1
        break
      fi
    done
  fi
  if [ "$duplicate" = "1" ]; then
    echo "SKIP_DUPLICATE profile=$profile_dir shared_skills=$skills_real"
    continue
  fi
  seen_skills_dirs+=("$skills_real")
  destination="$skills_real/claude-sol-delegation"

  if [ "$dry_run" = "1" ]; then
    echo "WOULD_INSTALL target=$destination runner=$runner sandbox=$sandbox"
    continue
  fi

  mkdir -p "$skills_dir"
  staging=$(mktemp -d "$skills_dir/.claude-sol-delegation.install.XXXXXX")
  staging_profile="$profile_dir"
  cp -R "$plugin_root/." "$staging/"
  printf 'runner=%s\nsandbox=%s\n' "$runner" "$sandbox" >"$staging/config.local"

  backup=""
  if [ -e "$destination" ]; then
    backup_root="$profile_dir/backups/claude-sol-delegation"
    mkdir -p "$backup_root"
    backup_base="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
    backup="$backup_base"
    backup_suffix=1
    while [ -e "$backup" ]; do
      backup="$backup_base-$backup_suffix"
      backup_suffix=$((backup_suffix + 1))
    done
    mv "$destination" "$backup"
  fi
  mv "$staging" "$destination"
  staging=""
  staging_profile=""
  chmod +x "$destination/bin/delegate-sol" "$destination/install.sh" "$destination/scripts/"*.sh "$destination/test/test.sh"

  echo "INSTALLED target=$destination runner=$runner sandbox=$sandbox"
  [ -z "$backup" ] || echo "BACKUP path=$backup"
done
