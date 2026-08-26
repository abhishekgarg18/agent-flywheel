# ADR-0001: Detached background spawn for reflection, not a blocking in-session call

**Date**: 2026-08-26
**Status**: accepted
**Deciders**: agent-flywheel maintainers

## Context

A reflection pass needs to run against a session that just ended (session-end
hook) or one left idle mid-session (periodic checkpoint). In every harness
studied while building this project (omp, Claude Code, Codex CLI, GitHub
Copilot CLI), the process emitting the session-end/session-switch event
cannot itself run "one more turn" — the hook fires as the process is already
tearing down or switching sessions, and the event handler runs synchronously
in that lifecycle, not as a resumable agent turn.

## Decision

Every adapter's session-end/periodic path spawns a **new, detached, headless
subprocess** (`omp -p ... --resume <session>`, `claude -p ... --resume
<session>`, etc.) against the transcript that just ended, rather than trying
to inject one more turn into the closing/switching process. The spawned
subprocess is marked with `AGENT_FLYWHEEL_PASS=1` so its own eventual
shutdown does not recursively spawn another reflection pass.

## Alternatives Considered

### Alternative 1: Block the closing hook until reflection completes
- **Pros**: no detached process to track; reflection guaranteed to run before the session is fully gone.
- **Cons**: every harness's hook model treats session-end as fire-and-forget or a fixed-timeout callback; blocking it risks the harness killing the hook process before an LLM call (which can take 30s+) completes.
- **Why not**: no harness studied exposes a documented "block shutdown until this async work finishes" contract; relying on undocumented behavior is fragile across harness versions.

### Alternative 2: Queue reflection for the *next* session's first turn
- **Pros**: runs inside a normal, resumable agent turn — no subprocess management at all.
- **Cons**: a project that isn't reopened soon (or ever) never gets reflected on; defeats the "close the loop reliably" goal.
- **Why not**: reflection value decays with delay — the whole point is capturing what just happened while it's still fresh in the transcript, not whenever the user happens to come back.

## Consequences

### Positive
- Works uniformly across every harness's hook model, since "spawn a detached process" is the lowest common denominator every harness supports (they all can exec a subprocess from a hook script).
- Reflection actually runs even if the user never reopens that project.

### Negative
- No adapter can observe or wait on the reflection pass's completion from the harness itself — visibility is external, via `~/.agent-flywheel/reflection.log`.
- A user closing their laptop immediately after `/exit` could kill the detached subprocess before it finishes (accepted risk — the alternative of blocking shutdown is worse per Alternative 1).

### Risks
- **Recursive spawning**: mitigated by the `AGENT_FLYWHEEL_PASS=1` guard checked at the top of every adapter's hook and the omp extension's handlers.
- **Silent failures**: mitigated by routing all child stdio to `~/.agent-flywheel/reflection.log` instead of `/dev/null` (see ADR-0003's sibling concern, though that ADR covers the memory files, not this log) and by `agent-flywheel doctor`'s `--print` dry-run check per detected harness.
