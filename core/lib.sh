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

flywheel_reflection_log() {
  echo "$FLYWHEEL_HOME/reflection.log"
}

flywheel_learn_log() {
  echo "$FLYWHEEL_HOME/LEARN.log"
}

flywheel_guardrails_file() {
  echo "$FLYWHEEL_HOME/GUARDRAILS.md"
}

flywheel_level_file() {
  echo "$FLYWHEEL_HOME/LEVEL.md"
}

# Renders the full session-start nudge: the static maturity-nudge.txt habits
# text, PLUS (when present) a scannable index of GUARDRAILS.md titles and the
# last LEVEL.md trend line — so a binding correction from a past session
# actually reaches the next session's first turn instead of sitting unread
# in a file nobody re-opens. Only the titles are inlined (cheap, bounded);
# the nudge tells the agent to read the full entry before acting on one.
flywheel_render_nudge() {
  local nudge_file guardrails_file level_file titles last
  nudge_file="$(flywheel_nudge_file)"
  [ -f "$nudge_file" ] || return 0
  cat "$nudge_file"

  guardrails_file="$(flywheel_guardrails_file)"
  if [ -f "$guardrails_file" ]; then
    titles="$(grep '^### G' "$guardrails_file" 2>/dev/null | tail -10 || true)"
    if [ -n "$titles" ]; then
      printf '\nActive guardrails from past sessions (binding — read %s for full detail before acting on any that seem relevant):\n%s\n' "$guardrails_file" "$titles"
    fi
  fi

  level_file="$(flywheel_level_file)"
  if [ -f "$level_file" ]; then
    last="$(tail -1 "$level_file" 2>/dev/null || true)"
    [ -n "$last" ] && printf '\nLast self-scored level: %s (see %s for trend)\n' "$last" "$level_file"
  fi
}

# Every root this project knows to check under CHECK-EXISTING before
# scaffolding a new skill — mirrors core/prompts/reference/skill-roots.txt.
# Prints only roots that actually exist, one per line; a project run from
# somewhere with no project-local skills dir simply yields fewer lines.
flywheel_skill_roots() {
  local candidates=(
    "$HOME/.claude/skills"
    "$HOME/.codex/skills"
    "$HOME/.omp/agent/managed-skills"
    "$HOME/.omp/agent/skills"
    "$PWD/.claude/skills"
    "$PWD/.omp/skills"
  )
  local root
  for root in "${candidates[@]}"; do
    [ -d "$root" ] && echo "$root"
  done
}

# Which harness CLIs are actually installed on this machine, one per line as
# "<harness-name> <binary>" — used by `agent-flywheel reflect` to auto-detect
# a target when --harness isn't given explicitly. Detects installed tooling,
# never a currently-running session (there's no portable way to ask "which
# harness is my parent process" from a plain shell command).
flywheel_detected_harness_clis() {
  command -v omp     >/dev/null 2>&1 && echo "omp omp"
  command -v claude   >/dev/null 2>&1 && echo "claude-code claude"
  command -v codex    >/dev/null 2>&1 && echo "codex codex"
  command -v copilot  >/dev/null 2>&1 && echo "copilot copilot"
  return 0
}

# Assembles the full prompt text for a trigger + session, identically to
# what every adapter builds inline — single source of truth so
# `agent-flywheel reflect`/`prompt` never drifts from what the hooks do.
flywheel_build_prompt() {
  local trigger="$1" session="${2:-}" framing="${3:-The session that just ended is}"
  local file
  case "$trigger" in
    session-end) file="$(flywheel_prompt_file)" ;;
    periodic) file="$(flywheel_periodic_prompt_file)" ;;
    *) echo "unknown trigger: $trigger (expected session-end|periodic)" >&2; return 2 ;;
  esac
  [ -f "$file" ] || { echo "missing prompt file: $file" >&2; return 1; }
  cat "$file"
  if [ -n "$session" ]; then
    printf '\n%s recorded at: %s — read it directly for full grounding; this pass'"'"'s own conversation history starts blank, it is NOT pre-loaded from that file despite --resume.\n' "$framing" "$session"
  fi
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
