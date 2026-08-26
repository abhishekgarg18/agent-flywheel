#!/usr/bin/env bash
# core/lib.sh — shared helpers sourced by every harness's session-end /
# session-start hook script. Keeping this logic in one file is the whole
# point of the project: omp, Claude Code, Codex CLI, and GitHub Copilot CLI
# each get a thin adapter script that sources this and calls one function,
# instead of four scripts drifting apart over time.
#
# Usage (from an adapter hook script):
#   source "$(dirname "${BASH_SOURCE[0]}")/../../core/lib.sh"
#   flywheel_is_reflection_pass && exit 0
#   flywheel_spawn_reflection "$SESSION_ID" "<harness-resume-command...>"
set -uo pipefail

FLYWHEEL_HOME="${AGENT_FLYWHEEL_HOME:-$HOME/.agent-flywheel}"
FLYWHEEL_CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

flywheel_prompt_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/session-end.txt"
}

flywheel_periodic_prompt_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/periodic.txt"
}

flywheel_nudge_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/maturity-nudge.txt"
}

flywheel_scripts_dir() {
  echo "$FLYWHEEL_CORE_DIR/../scripts"
}

# Guard against infinite self-spawn: the reflection subprocess is itself a
# session in the same harness and will fire its own SessionEnd/shutdown
# event. Every adapter sets AGENT_FLYWHEEL_PASS=1 on the spawned process env
# and every hook checks this FIRST, before doing anything else, or
# reflection sessions spawn reflection sessions forever.
flywheel_is_reflection_pass() {
  [ "${AGENT_FLYWHEEL_PASS:-}" = "1" ]
}

# Rate-limits periodic (idle, mid-session) reflection across every harness
# on this machine to at most once per $1 seconds, tracked in one shared
# marker file — so if omp, Claude Code, Codex, and Copilot are all running
# with the periodic watcher active, they don't each independently fire a
# reflection pass and multiply cost. Returns 0 (ok to fire) or 1 (too soon).
flywheel_periodic_gap_ok() {
  local min_gap_seconds="$1"
  local marker="$FLYWHEEL_HOME/.last-periodic-reflection"
  if [ -f "$marker" ]; then
    local last now
    last="$(cat "$marker" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    now="$(date +%s)"
    if [ "$(( now - last ))" -lt "$min_gap_seconds" ]; then
      return 1
    fi
  fi
  return 0
}

flywheel_mark_periodic_ran() {
  mkdir -p "$FLYWHEEL_HOME"
  date +%s > "$FLYWHEEL_HOME/.last-periodic-reflection"
}

# Best-effort deterministic advisor auto-tune (omp only — other harnesses
# have no advisor subsystem to tune, so adapters for those harnesses simply
# never call this). Never fatal: a missing node/script must never block the
# hook from completing.
flywheel_run_advisor_autotune() {
  local config_file="$1"
  command -v node >/dev/null 2>&1 || return 0
  local script="$FLYWHEEL_CORE_DIR/../scripts/advisor-autotune.mjs"
  [ -f "$script" ] || return 0
  node "$script" --config "$config_file" --sessions-dir "$(dirname "$config_file")/sessions" >>"$FLYWHEEL_HOME/advisor-autotune.log" 2>&1 || true
}

mkdir -p "$FLYWHEEL_HOME" 2>/dev/null || true
