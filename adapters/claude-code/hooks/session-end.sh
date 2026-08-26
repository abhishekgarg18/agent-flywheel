#!/usr/bin/env bash
# adapters/claude-code/hooks/session-end.sh
#
# Claude Code SessionEnd hook — fires once per session but is fire-and-
# forget (https://code.claude.com/docs/en/hooks: "no decision control...
# side effects like logging or cleanup"). It cannot force Claude to keep
# going in this process. Instead this spawns a detached headless
# `claude -p` subprocess that resumes the transcript that just ended and
# runs the shared reflection prompt against it.
#
# BUG CLASS THIS GUARDS AGAINST: the spawned reflection subprocess is
# itself a `claude -p` session, and it too ends, firing its OWN SessionEnd.
# Without the AGENT_FLYWHEEL_PASS guard (checked first, in lib.sh) this
# spawns forever.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../core/lib.sh"

flywheel_is_reflection_pass && exit 0

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty')"
TRANSCRIPT_PATH="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')"

# Stop this session's periodic watcher (adapters/claude-code/hooks/periodic-watcher.sh)
# regardless of whether we can spawn a reflection pass below.
if [ -n "$SESSION_ID" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/periodic-watcher.sh" stop "$SESSION_ID" || true
fi

[ -n "$SESSION_ID" ] || exit 0

# Cross-source close-out lock. If agent-flywheel is wired BOTH as a Claude Code
# plugin (hooks/hooks.json) AND via install.sh's settings.json — different
# command strings, so Claude Code can't dedupe them — both SessionEnd hooks fire
# and would each spawn a reflection pass (2x cost, racing ledger appends). An
# atomic mkdir lock per session_id makes exactly one win, regardless of how many
# registrations invoke this script. The reflection subprocess is separately
# guarded from re-spawning by AGENT_FLYWHEEL_PASS (checked at the top).
mkdir -p "$FLYWHEEL_HOME/watchers" 2>/dev/null || true
if ! mkdir "$FLYWHEEL_HOME/watchers/${SESSION_ID}.reflect-lock" 2>/dev/null; then
  exit 0
fi

PROMPT_FILE="$(flywheel_prompt_file)"
[ -f "$PROMPT_FILE" ] || exit 0

PROMPT="$(cat "$PROMPT_FILE")

The session that just ended is recorded at: ${TRANSCRIPT_PATH:-<unknown, use --resume>} (session id ${SESSION_ID}) — read it directly for full grounding; this reflection pass's own conversation history starts blank, it is NOT pre-loaded from that file despite --resume.

$(flywheel_cli_note)"

AGENT_FLYWHEEL_PASS=1 nohup claude -p "$PROMPT" --resume "$SESSION_ID" >>"$(flywheel_reflection_log)" 2>&1 &
disown

exit 0
