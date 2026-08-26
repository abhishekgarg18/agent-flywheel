# Codex CLI adapter notes

## What's wired

`hooks/session-end.sh` spawns a detached `codex exec resume <session_id> <prompt>`
against the shared `core/prompts/session-end.txt` reflection prompt whenever
a Codex session ends, guarded against recursive self-spawn the same way as
every other adapter (see `core/lib.sh`).

`install.sh` copies this script to `~/.agent-flywheel/adapters/codex/hooks/session-end.sh`
and registers it as Codex's session-end hook where Codex's own config format
allows a scripted install; otherwise it prints the path and the exact config
line to add by hand.

One-time step Codex itself requires: newly added or changed hooks need an
interactive `/hooks` trust review before Codex will run them — run Codex
once interactively after installing and approve the hook when prompted.

## Not wired here (verify before relying on it)

This project does not ship a Codex session-start / periodic-checkpoint
integration, because Codex CLI's hook schema for an `additionalContext`-
style injection point and for a background-timer primitive were not
confirmed against Codex's own documentation while building this adapter —
shipping an unverified hook config in a public repo people install directly
onto their machines is worse than shipping nothing. Two things you can do
today, verified to work with any CLI-based tool:

- **Maturity nudge**: append `core/prompts/maturity-nudge.txt` (or run
  `bin/agent-flywheel nudge`) to your project's `AGENTS.md`/system prompt.
  It's a static file; there's no dependency on a hook firing correctly.
- **Periodic mid-session checkpoint**: `bin/agent-flywheel periodic-check
  --transcript <path>` and `periodic-mark` are pure CLI primitives with no
  Codex-specific assumptions. Wire them into a `cron`/`launchd`/`systemd
  --user` timer that runs every 15 minutes and, on a "fire" exit code,
  spawns `codex exec resume <session_id> "$(bin/agent-flywheel prompt
  periodic --session <session_id>)"`.

If you confirm Codex's actual SessionStart-equivalent schema, a PR adding
`hooks/session-start.sh` and `hooks/periodic-watcher.sh` (mirroring the
Claude Code adapter) is welcome.
