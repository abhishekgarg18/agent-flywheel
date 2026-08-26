#!/usr/bin/env bash
# adapters/claude-code/hooks/session-start.sh
#
# Two responsibilities on every session start/resume:
#   1. Arm this session's periodic mid-session reflection watcher (see
#      periodic-watcher.sh) — Claude Code has no built-in background-timer
#      hook primitive, so this is a detached loop instead.
#   2. Inject the maturity nudge (core/prompts/maturity-nudge.txt) as
#      `additionalContext` so it's in the model's context before the first
#      turn, without requiring the user to remember to paste it anywhere.
#
# Never blocks: SessionStart hooks have no way to fail the session, and
# this script treats every step as best-effort.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../core/lib.sh"

flywheel_is_reflection_pass && exit 0

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
TRANSCRIPT_PATH="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)"

if [ -n "$SESSION_ID" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/periodic-watcher.sh" start "$SESSION_ID" "$TRANSCRIPT_PATH" >/dev/null 2>&1 &
  disown
fi

NUDGE_TEXT="$(flywheel_render_nudge)"
if [ -n "$NUDGE_TEXT" ]; then
  jq -n --arg ctx "$NUDGE_TEXT" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
fi

exit 0
