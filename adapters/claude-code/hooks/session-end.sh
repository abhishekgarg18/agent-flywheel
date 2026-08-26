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
# tr -cd (delete, not replace): jq's trailing newline is not in the allowed set,
# so `tr -c ... '_'` used to turn it into a trailing "_" (REASON="resume_"),
# which broke the exact-match reason skip below. Deleting disallowed chars yields
# a clean token.
REASON="$(printf '%s' "$INPUT" | jq -r '.reason // "end"' 2>/dev/null | tr -cd 'A-Za-z0-9_' || echo end)"
[ -n "$REASON" ] || REASON="end"

# Stop this session's periodic watcher (adapters/claude-code/hooks/periodic-watcher.sh)
# regardless of whether we can spawn a reflection pass below.
if [ -n "$SESSION_ID" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/periodic-watcher.sh" stop "$SESSION_ID" || true
fi

# reason=resume is NOT a session end — it fires when a session is being resumed;
# reflecting then is both pointless and the session isn't closed. Skip it.
case "$REASON" in resume) exit 0 ;; esac

[ -n "$SESSION_ID" ] || exit 0
# The reflection reads the transcript FILE directly (it is not pre-loaded), so a
# transcript path is required — without it the pass would be blind.
[ -n "$TRANSCRIPT_PATH" ] || exit 0
# Machine-wide rate limit: rapid /new /clear /exit cycling would otherwise each
# spawn a reflection (each writes memory), which bursts the memory backend. Bound
# to once per AGENT_FLYWHEEL_MIN_REFLECT_GAP_SECONDS (default 120s).
flywheel_reflect_gap_ok || exit 0

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

The session that just ended is recorded at: ${TRANSCRIPT_PATH} (session id ${SESSION_ID}) — read that transcript file directly (it is JSON Lines) for full grounding; this reflection pass's own conversation history starts blank, nothing is pre-loaded.

$(flywheel_cli_note)"

# Spawn a fresh headless pass, NOT `--resume <session_id>`: Claude Code's
# `-p --resume <uuid>` fails with "No conversation found" for a just-ended
# session (the id isn't a resumable conversation in that store), which aborted
# the whole reflection. The prompt already carries the transcript path and reads
# it directly, so resume is unnecessary. --no-session-persistence keeps the
# reflection from cluttering the session list.
# Lean MCP: load ONLY memorix, not playwright + every claude.ai connector — those
# make each reflection heavy (and pile up when passes fire). $MCP_ARGS is
# intentionally unquoted for word-splitting the flags.
MCP_ARGS="$(flywheel_lean_mcp_args)"
# shellcheck disable=SC2086
AGENT_FLYWHEEL_PASS=1 nohup claude -p "$PROMPT" --no-session-persistence $MCP_ARGS >>"$(flywheel_reflection_log)" 2>&1 &
disown
flywheel_mark_reflected_now

exit 0
