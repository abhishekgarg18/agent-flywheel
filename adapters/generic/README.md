# Generic adapter — any other harness (Cursor, Windsurf, Cline, Aider, custom scripts, ...)

agent-flywheel's core is three harness-agnostic primitives, exposed as plain
text/exit-codes through `bin/agent-flywheel`, with zero assumptions about
your specific tool's config format:

1. **Reflect at session end.** Something in your harness must run, once a
   session/conversation ends, whatever CLI invocation resumes that
   conversation non-interactively, with the prompt from:
   ```
   agent-flywheel prompt session-end --session <transcript-path-or-id>
   ```
   piped into it. If your harness has ANY "run a shell command when a
   session/conversation ends" mechanism — a hook, an event, a plugin API,
   even a wrapper shell function around your `alias ai=...` — this is the
   one integration point that matters most.

2. **Nudge at session start.** Feed the output of `agent-flywheel nudge`
   into whatever your harness treats as system-prompt/first-turn context —
   a system prompt file, an `AGENTS.md`/`CLAUDE.md`-equivalent, a
   `--append-system-prompt` flag, or a session-start hook's context-
   injection field if it has one.

3. **Periodic mid-session checkpoint (optional).** If you want reflection
   to happen during long-lived sessions too, not just at the end, run this
   on a timer (a `cron`/`launchd`/`systemd --user` job checked every
   10-15 minutes is plenty):
   ```
   if agent-flywheel periodic-check --transcript <path>; then
     <your resume-with-prompt invocation> "$(agent-flywheel prompt periodic --session <path>)"
     agent-flywheel periodic-mark
   fi
   ```
   `periodic-check` exits 0 only when the transcript has been idle long
   enough AND the shared cross-harness rate-limit marker allows another
   pass — it costs nothing to poll it far more often than it actually
   fires.

## Worked example: a bare `bash` alias with no hook system at all

```bash
# in ~/.bashrc, wrapping whatever your tool's non-interactive resume flag is
ai_end_session() {
  local transcript="$1"
  some-ai-cli --resume "$transcript" -p "$(agent-flywheel prompt session-end --session "$transcript")"
}
```

Call `ai_end_session "$TRANSCRIPT_PATH"` from wherever your workflow already
marks a session as finished (closing a terminal tab via a trap, a Makefile
`stop` target, a script you run by habit) — this is intentionally the
lowest common denominator, so it works even for tools with no plugin system
whatsoever.

## What "portable baseline" means for memory

Every prompt this project ships (`core/prompts/*.txt`) instructs the
reflection pass to write durable insights to `~/.agent-flywheel/MEMORY.md`
first, and to your harness's own memory convention second, if one exists.
That file has no dependency on any harness at all — even a from-scratch
integration that only wires step 1 above gets real, working memory
persistence with zero other setup.
