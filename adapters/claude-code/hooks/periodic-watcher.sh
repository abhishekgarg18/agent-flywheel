#!/usr/bin/env bash
# adapters/claude-code/hooks/periodic-watcher.sh
#
# Claude Code has no built-in "run this every N minutes while idle" hook
# primitive (unlike omp's `ctx.setInterval`), so this implements the same
# behavior as a detached background loop: started once per session by
# session-start.sh, stopped by session-end.sh. Idle detection and the
# cross-harness rate-limit marker are delegated to scripts/idle-gap.mjs —
# see that file for why this is Node and not pure bash (portable mtime
# comparison without BSD-vs-GNU `stat` flag differences).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../core/lib.sh"

CHECK_INTERVAL_SECONDS="${AGENT_FLYWHEEL_PERIODIC_CHECK_SECONDS:-900}"  # how often the idle check runs (15 min)
IDLE_SECONDS="${AGENT_FLYWHEEL_IDLE_SECONDS:-300}"                       # how long the transcript must be untouched
MIN_GAP_SECONDS="${AGENT_FLYWHEEL_MIN_PERIODIC_GAP_SECONDS:-7200}"       # floor between actual passes, shared across harnesses
WATCHER_DIR="$FLYWHEEL_HOME/watchers"
SCRIPTS_DIR="$(flywheel_scripts_dir)"
mkdir -p "$WATCHER_DIR"

start() {
  local session_id="$1" transcript="$2"
  local pidfile="$WATCHER_DIR/$session_id.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0 # already running for this session
  fi

  (
    while true; do
      sleep "$CHECK_INTERVAL_SECONDS"
      [ -f "$pidfile" ] || exit 0 # stopped while sleeping

      if node "$SCRIPTS_DIR/idle-gap.mjs" check \
        --transcript "$transcript" \
        --idle-seconds "$IDLE_SECONDS" \
        --min-gap-seconds "$MIN_GAP_SECONDS" >/dev/null 2>&1; then

        node "$SCRIPTS_DIR/idle-gap.mjs" mark >/dev/null 2>&1 || true

        PROMPT_FILE="$(flywheel_periodic_prompt_file)"
        [ -f "$PROMPT_FILE" ] || continue
        PROMPT="$(cat "$PROMPT_FILE")

This still-running, idle session, so far, is recorded at: $transcript (session id $session_id) — read it directly for grounding; this checkpoint pass's own history starts blank."

        AGENT_FLYWHEEL_PASS=1 nohup claude -p "$PROMPT" --resume "$session_id" >/dev/null 2>&1 &
        disown
      fi
    done
  ) &
  disown
  echo $! > "$pidfile"
}

stop() {
  local session_id="$1"
  local pidfile="$WATCHER_DIR/$session_id.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    rm -f "$pidfile"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
}

case "${1:-}" in
  start) start "${2:?session_id required}" "${3:?transcript_path required}" ;;
  stop) stop "${2:?session_id required}" ;;
  *) echo "usage: periodic-watcher.sh <start|stop> <session_id> [transcript_path]" >&2; exit 2 ;;
esac
