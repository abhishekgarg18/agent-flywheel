#!/usr/bin/env bash
# adapters/codex/hooks/session-end.sh
#
# Codex CLI SessionEnd-equivalent hook. Per Codex's hooks documentation it
# is fire-and-forget with a short default timeout, too short for any
# blocking work — so, same pattern as every other adapter in this project,
# this spawns a detached `codex exec resume` subprocess that runs the
# shared reflection prompt against the transcript that just ended.
#
# Guarded by AGENT_FLYWHEEL_PASS (see core/lib.sh) so the reflection
# subprocess's own session end doesn't re-fire this and spawn forever.
#
# NOTE ON TRUST: newly-added/changed Codex hooks require a one-time
# interactive `/hooks` trust review before Codex will actually run them.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../core/lib.sh"

flywheel_is_reflection_pass && exit 0

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty')"

[ -n "$SESSION_ID" ] || exit 0

PROMPT_FILE="$(flywheel_prompt_file)"
[ -f "$PROMPT_FILE" ] || exit 0

PROMPT="$(cat "$PROMPT_FILE")

The session that just ended has id ${SESSION_ID} — resume and read it directly for full grounding; this reflection pass's own conversation history starts blank."

AGENT_FLYWHEEL_PASS=1 nohup codex exec resume "$SESSION_ID" "$PROMPT" >/dev/null 2>&1 &
disown

exit 0
