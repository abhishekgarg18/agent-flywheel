#!/usr/bin/env bash
# uninstall.sh — reverse everything install.sh wired, leaving no trace in
# any harness's config. Safe to run even if install.sh was never run (every
# step is a no-op guard, not an assumption something exists).
#
# What this does NOT touch, on purpose:
#   - ~/.omp/agent/WATCHDOG.md / WATCHDOG.yml — install.sh only ever seeded
#     these if absent; by the time you're uninstalling they're your own
#     config, not agent-flywheel's, so removing them would delete content
#     you may have since customized. Delete by hand if you want them gone.
#   - Anything inside your project repos (this project never writes there).
#
# Usage:
#   ./uninstall.sh               # unwire from every detected harness, keep ~/.agent-flywheel
#   ./uninstall.sh --purge       # also delete ~/.agent-flywheel entirely
#   ./uninstall.sh --home <path> # target a non-default install location
set -euo pipefail

FLYWHEEL_HOME="${AGENT_FLYWHEEL_HOME:-$HOME/.agent-flywheel}"
PURGE=0

info() { printf '\033[34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --home) FLYWHEEL_HOME="$2"; shift 2 ;;
    --help|-h) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

remove_marked_block() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  local start="# >>> agent-flywheel: $key >>>"
  local end="# <<< agent-flywheel: $key <<<"
  grep -qF "$start" "$file" 2>/dev/null || return 0
  awk -v start="$start" -v end="$end" '
    $0 == start { skip=1; next }
    $0 == end { skip=0; next }
    !skip { print }
  ' "$file" > "$file.flywheel-tmp"
  mv "$file.flywheel-tmp" "$file"
}

unwire_omp() {
  local omp_dir="$HOME/.omp/agent"
  [ -d "$omp_dir" ] || return 0
  info "Unwiring omp adapter from $omp_dir"
  rm -f "$omp_dir/extensions/agent-flywheel-self-improvement-loop.ts" \
    "$omp_dir/rules/agent-flywheel-todo-continuation-enforcer.md" \
    "$omp_dir/rules/agent-flywheel-comment-checker.md"
  remove_marked_block "$omp_dir/config.yml" "advisor"
  ok "omp unwired (extension + rules removed; config.yml advisor: block removed)"
  warn "WATCHDOG.md / WATCHDOG.yml left in place — remove by hand if you no longer want them"
}

unwire_claude_code() {
  local settings="$HOME/.claude/settings.json"
  [ -f "$settings" ] || return 0
  command -v jq >/dev/null 2>&1 || { warn "jq not found — cannot auto-remove hooks from $settings; remove the agent-flywheel SessionStart/SessionEnd entries by hand"; return 0; }
  info "Unwiring Claude Code hooks from $settings"
  local start_cmd="$FLYWHEEL_HOME/adapters/claude-code/hooks/session-start.sh"
  local end_cmd="$FLYWHEEL_HOME/adapters/claude-code/hooks/session-end.sh"
  jq \
    --arg start_cmd "$start_cmd" \
    --arg end_cmd "$end_cmd" \
    '
    .hooks.SessionStart = ((.hooks.SessionStart // []) | map(select((.hooks[0].command // "") != $start_cmd)))
    | .hooks.SessionEnd = ((.hooks.SessionEnd // []) | map(select((.hooks[0].command // "") != $end_cmd)))
    ' "$settings" > "$settings.flywheel-tmp"
  mv "$settings.flywheel-tmp" "$settings"
  ok "Claude Code unwired"
}

main() {
  unwire_omp
  unwire_claude_code

  if [ "$PURGE" = "1" ]; then
    if [ -d "$FLYWHEEL_HOME" ]; then
      rm -rf "$FLYWHEEL_HOME"
      ok "Removed $FLYWHEEL_HOME"
    fi
  else
    info "$FLYWHEEL_HOME left in place (contains logs/markers) — pass --purge to delete it"
  fi

  echo
  ok "Done. Codex/Copilot/other harnesses were never auto-wired (see their adapters/*/notes.md) — remove any hook line you added by hand there too."
}

main "$@"
