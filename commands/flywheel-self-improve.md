---
description: Run the agent-flywheel META pass now — reflect on and improve the loop itself (its prompts, adapters, guardrail effectiveness, level trend, next-skill curriculum)
---

Run the agent-flywheel META self-improvement pass now, regardless of the
configured cadence (this is the manual, on-demand trigger). Its subject is the
loop ITSELF, not the last coding session.

Use your file-read tool on this exact path and follow the procedure against this
plugin's checkout plus your `~/.agent-flywheel/*` files:

`${CLAUDE_PLUGIN_ROOT}/core/prompts/self-improve.txt`

The flywheel checkout to assess is `${CLAUDE_PLUGIN_ROOT}`. After finishing,
record that a meta pass ran so the auto-cadence clock resets — run
`"${CLAUDE_PLUGIN_ROOT}/bin/agent-flywheel" self-improve --mark` (or
`~/.agent-flywheel/bin/agent-flywheel self-improve --mark`).
