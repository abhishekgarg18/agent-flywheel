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
# SessionEnd can fire more than once per session id (e.g. reason=clear then
# reason=exit); the lock key includes reason so each distinct boundary reflects
# once, while two registrations of the SAME event (plugin + settings.json double-
# wire) still collapse to one. Sanitized to a lock-safe token.
REASON="$(printf '%s' "$INPUT" | jq -r '.reason // "end"' 2>/dev/null | tr -c 'A-Za-z0-9_' '_' || echo end)"

# Stop this session's periodic watcher (adapters/claude-code/hooks/periodic-watcher.sh)
# regardless of whether we can spawn a reflection pass below.
if [ -n "$SESSION_ID" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/periodic-watcher.sh" stop "$SESSION_ID" || true
fi

[ -n "$SESSION_ID" ] || exit 0

PROMPT_FILE="$(flywheel_prompt_file)"
[ -f "$PROMPT_FILE" ] || exit 0

# Cross-source close-out lock, taken LAST — after every `|| exit 0` guard — so a
# transient missing-prompt path can't leave a lock held and permanently suppress
# this session's reflection. If agent-flywheel is wired BOTH as a plugin and via
# install.sh's settings.json (different command strings, so Claude Code can't
# dedupe them), both SessionEnd hooks fire; this atomic mkdir lock makes exactly
# one win. The reflection subprocess itself is separately guarded from
# re-spawning by AGENT_FLYWHEEL_PASS (checked at the top).
mkdir -p "$FLYWHEEL_HOME/watchers" 2>/dev/null || true
if ! mkdir "$FLYWHEEL_HOME/watchers/${SESSION_ID}.${REASON}.reflect-lock" 2>/dev/null; then
  exit 0
fi

PROMPT="$(cat "$PROMPT_FILE")

The session that just ended is recorded at: ${TRANSCRIPT_PATH:-<unknown, use --resume>} (session id ${SESSION_ID}) — read it directly for full grounding; this reflection pass's own conversation history starts blank, it is NOT pre-loaded from that file despite --resume.

$(flywheel_cli_note)"

AGENT_FLYWHEEL_PASS=1 nohup claude -p "$PROMPT" --resume "$SESSION_ID" >>"$(flywheel_reflection_log)" 2>&1 &
disown

exit 0
