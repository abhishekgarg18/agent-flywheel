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

# Loads user config from $FLYWHEEL_HOME/config.env (plain KEY=VALUE lines,
# seeded from config.env.example by install.sh — never overwritten on re-run).
# Precedence: an env var already set in the environment WINS over the file, so a
# one-off `AGENT_FLYWHEEL_SELF_IMPROVE_MODE=off agent-flywheel ...` overrides the
# file for that run; the file provides the persistent default; a hardcoded
# default in each getter is the final fallback if neither is present. Only
# AGENT_FLYWHEEL_* keys are honored. bash 3.2 safe (no associative arrays).
flywheel_load_config() {
  local cfg="${1:-$FLYWHEEL_HOME/config.env}"
  [ -f "$cfg" ] || return 0
  local line key val curr
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in AGENT_FLYWHEEL_*) ;; *) continue ;; esac
    # strip one layer of surrounding quotes and trailing inline whitespace
    val="${val%%$'\t'*}"
    val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
    eval "curr=\${$key:-}"
    [ -n "$curr" ] && continue   # env var already set: it wins over the file
    eval "$key=\$val"            # \$val, not $val: assign the literal, no re-eval
  done < "$cfg"
}

flywheel_prompt_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/session-end.txt"
}

flywheel_periodic_prompt_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/periodic.txt"
}

flywheel_nudge_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/maturity-nudge.txt"
}

flywheel_self_improve_prompt_file() {
  echo "$FLYWHEEL_CORE_DIR/prompts/self-improve.txt"
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

# Which durable-memory backend is reachable, as "<backend> <how-detected>" on
# one line, richest first. memorix/claude-mem are the PREFERRED semantic store
# when present (the reflection prompts treat them as primary); the flat-file
# MEMORY.md is the always-present zero-dependency baseline that never depends on
# either being installed (ADR-0003). This is detection only — it never installs
# or requires anything. See docs/prerequisites.md for how to make memorix
# reachable per harness. Prints the flat-file baseline line unconditionally so a
# caller always has at least one backend to report.
flywheel_memory_backend() {
  local found=0
  if command -v memorix >/dev/null 2>&1; then
    echo "memorix cli:memorix"; found=1
  fi
  if command -v claude-mem >/dev/null 2>&1; then
    echo "claude-mem cli:claude-mem"; found=1
  fi
  # A memorix MCP server configured for this project counts as reachable even
  # when no standalone CLI is on PATH — the reflection pass calls its tools, not
  # a shell command. Cheap best-effort check of the two common config spots.
  if [ "$found" = "0" ]; then
    if grep -rqi 'memorix' "$HOME/.claude.json" "$PWD/.claude/settings.json" "$PWD/.mcp.json" 2>/dev/null; then
      echo "memorix mcp:configured"; found=1
    fi
  fi
  echo "flat-file $FLYWHEEL_HOME/MEMORY.md"
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
  local trigger="$1" session="${2:-}" framing="${3:-The session that just ended is}" locator="${4:-recorded at}"
  local file
  case "$trigger" in
    session-end) file="$(flywheel_prompt_file)" ;;
    periodic) file="$(flywheel_periodic_prompt_file)" ;;
    self-improve) file="$(flywheel_self_improve_prompt_file)" ;;
    *) echo "unknown trigger: $trigger (expected session-end|periodic|self-improve)" >&2; return 2 ;;
  esac
  [ -f "$file" ] || { echo "missing prompt file: $file" >&2; return 1; }
  cat "$file"
  if [ -n "$session" ]; then
    # The "despite --resume" caveat only applies to the session-resume triggers
    # (session-end/periodic); the self-improve meta pass reads files without any
    # resume, so it gets the plainer "starts blank" clause.
    local resume_caveat=" despite --resume"
    [ "$trigger" = "self-improve" ] && resume_caveat=""
    printf '\n%s %s: %s — read it directly for full grounding; this pass'"'"'s own conversation history starts blank, it is NOT pre-loaded from that file%s.\n' "$framing" "$locator" "$session" "$resume_caveat"
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

# Rate-limits the META self-improvement pass (the loop reflecting on itself) to
# at most once per $1 seconds (default 7 days), tracked in its own marker so it
# never competes with the per-session periodic gap. Meta review is expensive and
# only has enough new signal to act on across many sessions, not every close-out
# — so it is opt-in and weekly by default. Returns 0 (ok to run) or 1 (too soon).
flywheel_self_improve_gap_ok() {
  local min_gap_seconds="${1:-604800}" # 7 days
  local marker="$FLYWHEEL_HOME/.last-self-improve"
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

flywheel_mark_self_improve_ran() {
  mkdir -p "$FLYWHEEL_HOME"
  date +%s > "$FLYWHEEL_HOME/.last-self-improve"
}

# Decides whether the META self-improvement pass is due to auto-run NOW, given
# the trigger point it's being asked from ("session-end" or "mid-session") and
# the user's configured cadence. This is the single source of cadence truth —
# both the session-end and periodic prompts call it (via `agent-flywheel
# self-improve --gate`) instead of each hardcoding a schedule. Returns 0 (due)
# or 1 (not due). Config keys (see config.env.example):
#   AGENT_FLYWHEEL_SELF_IMPROVE_MODE     every-session | gap (default) | days | off
#   AGENT_FLYWHEEL_SELF_IMPROVE_TRIGGER  session-end (default) | mid-session | both
#   AGENT_FLYWHEEL_SELF_IMPROVE_GAP_DAYS integer, for mode=gap (default 7)
#   AGENT_FLYWHEEL_SELF_IMPROVE_DAYS     comma list Mon..Sun or 1..7, for mode=days (default Sat)
flywheel_self_improve_due() {
  local trigger="${1:-session-end}"
  local mode="${AGENT_FLYWHEEL_SELF_IMPROVE_MODE:-gap}"
  local want="${AGENT_FLYWHEEL_SELF_IMPROVE_TRIGGER:-session-end}"

  # The trigger point must match what the user allows the meta pass to run from.
  case "$want" in
    both) ;;
    "$trigger") ;;
    *) return 1 ;;
  esac

  case "$mode" in
    off) return 1 ;;
    every-session) return 0 ;;
    days)
      local today_num today_abbr days field IFS
      today_num="$(date +%u)"                                  # 1=Mon .. 7=Sun
      today_abbr="$(date +%a | tr '[:upper:]' '[:lower:]')"    # mon .. sun
      days="${AGENT_FLYWHEEL_SELF_IMPROVE_DAYS:-Sat}"
      IFS=','
      for field in $days; do
        field="$(printf '%s' "$field" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
        [ -z "$field" ] && continue
        [ "$field" = "$today_num" ] && return 0
        [ "$(printf '%s' "$field" | cut -c1-3)" = "$today_abbr" ] && return 0
      done
      return 1 ;;
    gap|*)
      local gap_days="${AGENT_FLYWHEEL_SELF_IMPROVE_GAP_DAYS:-7}"
      case "$gap_days" in ''|*[!0-9]*) gap_days=7 ;; esac
      flywheel_self_improve_gap_ok "$(( gap_days * 86400 ))" ;;
  esac
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

# Apply user config once, at source time, so every getter/decision below sees
# it. Cheap (a small file read); no-op when config.env is absent.
flywheel_load_config

mkdir -p "$FLYWHEEL_HOME" 2>/dev/null || true
