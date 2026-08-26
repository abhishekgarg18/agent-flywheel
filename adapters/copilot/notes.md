# GitHub Copilot CLI adapter notes

## What's wired

`hooks/session-end.sh` spawns a detached `copilot --resume <session_id> -p
<prompt>` against the shared `core/prompts/session-end.txt` reflection
prompt whenever a Copilot CLI session ends, guarded against recursive
self-spawn (see `core/lib.sh`).

**Verify the resume flag before relying on this.** Copilot CLI's exact
non-interactive resume invocation varies by version; run `copilot --help`
(or check your installed version's docs) and adjust `hooks/session-end.sh`
if the flag differs from `--resume ... -p ...`. This adapter is shipped as
a starting point, not a guarantee for every Copilot CLI release.

## Not wired here (verify before relying on it)

Same situation as the Codex adapter: a session-start/`additionalContext`
injection point and a background-timer primitive were not confirmed
against Copilot CLI's own hook documentation, so this project doesn't ship
an unverified session-start integration for it. Use the harness-agnostic
fallback instead:

- **Maturity nudge**: `bin/agent-flywheel nudge` (or append
  `core/prompts/maturity-nudge.txt` directly) into your project's system
  prompt/instructions file.
- **Periodic mid-session checkpoint**: `bin/agent-flywheel periodic-check`
  / `periodic-mark` wired into a `cron`/`launchd` timer, same as described
  in `adapters/codex/notes.md`.

A PR that confirms Copilot CLI's real hook schema and adds
`hooks/session-start.sh` + `hooks/periodic-watcher.sh` is welcome.
