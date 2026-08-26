# ADR-0004: Codex CLI and GitHub Copilot CLI adapters ship manual-wiring-only, not auto-wired

**Date**: 2026-08-26
**Status**: accepted
**Deciders**: agent-flywheel maintainers

## Context

`install.sh` auto-wires omp (extension + rules + `config.yml` merge) and
Claude Code (`settings.json` hooks via `jq`) because both harnesses'
session-start/session-end/`additionalContext` hook schemas were directly
confirmed while building this project. Codex CLI and GitHub Copilot CLI
were found on the building machine's `PATH` and both ship a working
`adapters/{codex,copilot}/hooks/session-end.sh` script, but neither CLI's
own hook-registration schema (where to declare the hook, what env vars it
receives, whether an interactive trust/approval step is required before a
newly wired hook runs) was verified against real, current CLI behavior.

## Decision

`install.sh` detects Codex/Copilot on `PATH` and prints manual wiring
instructions plus a pointer to the ready-to-use `hooks/session-end.sh`
script and each adapter's `notes.md`, but does **not** write to either
CLI's own config files. Auto-wiring is deferred until a contributor
confirms the actual hook contract (see "Not wired here" in each `notes.md`
for exactly what's unverified: a session-start/`additionalContext`
equivalent and a native periodic-checkpoint timer).

## Alternatives Considered

### Alternative 1: Auto-wire based on the omp/Claude Code schema, assumed similar
- **Pros**: consistent "just run install.sh" experience across all four harnesses.
- **Cons**: if the assumed schema is wrong, `install.sh` silently writes invalid config to a file the user didn't ask to have mutated, potentially breaking Codex/Copilot's own hook system in a way that's hard to diagnose (a bad auto-wire is worse than no auto-wire).
- **Why not**: this project's own installer guarantee ("re-running install.sh after a git pull is always safe," "only two config files are ever mutated, and only inside markers") depends on every write being confirmed-safe; an unverified schema breaks that guarantee for exactly the files it would touch.

### Alternative 2: Don't ship Codex/Copilot adapters at all until verified
- **Pros**: no unverified code shipped, no ambiguity about wiring status.
- **Cons**: the `hooks/session-end.sh` scripts themselves are correct and immediately useful for a user willing to wire them by hand; withholding them entirely delays real-world usage and feedback that would help verify the schema faster.
- **Why not**: shipping the working script with honest "manual wiring, schema unverified" documentation gives users an immediate, correct manual option while being transparent about exactly what's not automated yet — strictly better than shipping nothing.

## Consequences

### Positive
- `install.sh`'s safety guarantee ("only two config files are ever mutated") stays true and auditable — it's not a general claim resting on unverified assumptions about two more CLIs.
- Codex/Copilot users still get a correct, ready-to-use hook script immediately, with explicit next steps.

### Negative
- Codex/Copilot users have a strictly worse onboarding experience than omp/Claude Code users today (manual wiring vs. one command).
- The gap between "adapter exists" and "adapter is auto-wired" needs its own tracking so it isn't forgotten — currently: `docs/decisions/0004-...md` (this ADR) plus the "Contributing" section of `README.md`.

### Risks
- **This becomes permanent by default** — mitigated by explicitly documenting it as a solicited contribution ("PRs that confirm the real schema and close that gap are welcome") rather than a silent limitation.
