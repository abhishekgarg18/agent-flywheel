---
description: Run the agent-flywheel reflect -> write -> proceduralize pass on the current session now (manual trigger, before /clear or mid-session)
---

Run the agent-flywheel self-improvement reflection pass against THIS current
session, right now, inline — do not spawn a subprocess and do not wait for the
automatic SessionEnd hook.

Read the procedure from the single source of truth and follow every stage in
order — use your file-read tool on this exact path:

`${CLAUDE_PLUGIN_ROOT}/core/prompts/session-end.txt`

Your transcript is already in context (unlike the automatic detached pass, which
starts blank) — you do not need to re-read a transcript file; reflect on what
happened in this very session. Write durable output to `~/.agent-flywheel/`
(and to memorix if reachable) exactly as the procedure specifies, and finish
with the one-paragraph summary it asks for.
