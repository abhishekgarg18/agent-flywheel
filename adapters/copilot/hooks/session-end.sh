#!/usr/bin/env bash
# adapters/copilot/hooks/session-end.sh
#
# GitHub Copilot CLI's own sessionEnd hook — same fire-and-forget
# constraint and same detached-subprocess pattern as every other adapter
# here. Spawns `copilot --resume <session_id> -p <prompt>` (adjust the flag
# to match your installed Copilot CLI version if it differs; verify with
# `copilot --help` before relying on this in a fresh install) against the
# shared reflection prompt.
#
# Guarded by AGENT_FLYWHEEL_PASS (see core/lib.sh) so the reflection
# subprocess's own session end doesn't re-fire this and spawn forever.
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

AGENT_FLYWHEEL_PASS=1 nohup copilot --resume "$SESSION_ID" -p "$PROMPT" >>"$(flywheel_reflection_log)" 2>&1 &
disown

exit 0
