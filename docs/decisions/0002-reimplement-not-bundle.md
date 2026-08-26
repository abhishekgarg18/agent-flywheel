# ADR-0002: Reimplement a self-contained fallback, don't bundle third-party memory/skill tools

**Date**: 2026-08-26
**Status**: accepted
**Deciders**: agent-flywheel maintainers

## Context

Several existing tools already cover individual stages of a reflect → write
→ proceduralize loop: `memorix`/`claude-mem` for durable memory,
`skill-creator` for scaffolding skills, `learn-from-session` for guardrail
ledgers, `level-up-coach` for self-scoring. Slack discussion around adopting
a third-party "personal AI agent harness" (e.g. `hermes-agent`) surfaced the
same underlying question for this project: reuse an existing tool wholesale,
or build a thinner, install-anywhere layer that cooperates with whatever the
user already has.

## Decision

`core/prompts/session-end.txt` and `periodic.txt` name each dedicated tool
as the **preferred** path for its stage when installed and reachable, but
every stage also has a **zero-dependency fallback baked into this project**
(flat files for MEMORY/GUARDRAILS/LEVEL, `scripts/skill-scaffold.mjs` for
skill scaffolding, `core/prompts/reference/*.txt` for the format contracts
those dedicated tools would otherwise encode). agent-flywheel never vendors,
forks, or requires installing a third-party tool — it reimplements the
minimum viable version of each stage and defers to a better implementation
only when one is already present.

## Alternatives Considered

### Alternative 1: Bundle/vendor a third-party tool (e.g. adopt `hermes-agent`'s approach wholesale)
- **Pros**: less code to maintain in this project; reuse a more mature implementation.
- **Cons**: ties this project's install story to a specific external tool's license, release cadence, and approval status (see the Slack thread that motivated this ADR — `hermes-agent`'s own path to internal approval was rejected quickly, unlike a small, auditable, MIT-licensed, self-authored script).
- **Why not**: agent-flywheel's core value proposition is "works with zero setup, on any harness, on any machine" — a hard dependency on one more external tool's approval/installation status directly contradicts that.

### Alternative 2: Require the dedicated tools (memorix, skill-creator, etc.) as hard prerequisites
- **Pros**: simpler prompts — one path per stage, no fallback logic to maintain.
- **Cons**: breaks on a fresh machine or a project without those tools installed; the whole "runs the same everywhere" premise fails.
- **Why not**: this project's own README states zero runtime dependencies beyond bash/node (and jq for one adapter) as a load-bearing constraint — a hard dependency on other skills violates that.

## Consequences

### Positive
- Works identically on a brand-new machine and on one with every AI tool already installed.
- Never duplicates a stage's logic in two places long-term: the fallback stays intentionally minimal (flat files, a small scaffolder script), while the dedicated tool — when present — does the richer work.

### Negative
- Two implementations of similar functionality can exist in a user's environment simultaneously (e.g. `MEMORY.md` and memorix's own store) — the DECAY step's instruction to keep both in sync, not contradicting, is a manual discipline point, not automated.
- The fallback docs (`core/prompts/reference/*.txt`) must be kept roughly accurate to what the dedicated tools would do, or the fallback experience degrades relative to the "real" tool.

### Risks
- **Drift between the fallback and the "real" tool's conventions** — mitigated by naming the dedicated tool explicitly in the prompt text and treating the fallback as a last resort, not the primary design target.
