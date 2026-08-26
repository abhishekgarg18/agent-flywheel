# Prerequisites

agent-flywheel is designed to run with **zero required prerequisites** beyond
`bash`, `node`, and (for the Claude Code adapter) `jq`. Everything below is
either already-satisfied by that baseline or an *optional, recommended*
upgrade — the loop works standalone without any of it. This file exists so the
one prerequisite people actually ask about — **durable memory** — is wired and
documented clearly instead of buried in a prompt file.

## Hard requirements (must be present)

| Tool | Why | Check |
|---|---|---|
| `bash` (3.2+, stock macOS `/bin/bash` is fine) | every adapter hook + `bin/agent-flywheel` | `bash --version` |
| `node` (18+) | `scripts/*.mjs` (idle-gap, skill-scaffold, advisor-autotune) | `node --version` |
| `jq` | Claude Code adapter only (parses hook JSON, merges `settings.json`) | `jq --version` |

`agent-flywheel doctor` verifies all three plus a per-harness `reflect --print`
dry-run. Run it after `./install.sh`.

## The memory prerequisite (recommended, not required)

The reflection loop's MEMORY stage needs somewhere durable to write what it
learns. agent-flywheel supports two tiers, and **always writes the baseline**:

1. **Flat-file baseline — always active, zero setup.**
   `~/.agent-flywheel/MEMORY.md` (+ `GUARDRAILS.md`, `LEVEL.md`, `LEARN.log`),
   plain append-only text. This is the load-bearing guarantee: the loop
   produces real, working, portable memory on any machine, any harness, any
   project, even with nothing else installed. It is never skipped — see
   [ADR-0003](decisions/0003-flat-file-memory-store.md).

2. **memorix (or claude-mem) — the recommended primary store when reachable.**
   A harness-agnostic memory backend that persists across Claude Code, omp,
   Codex, and Copilot and is searchable across sessions and projects. When its
   tools are reachable in a session, every reflection prompt treats it as the
   **primary** semantic store *and still also appends the same insight to
   `MEMORY.md`* — so upgrading to memorix never costs you the portable
   baseline, and removing memorix later never loses the loop.

### Why memorix specifically

memorix is the memory layer this project is built to cooperate with because it
is itself harness-agnostic — the same store is reachable from every harness
agent-flywheel adapts, which is exactly the property the flywheel needs so a
lesson learned in a Claude session is available in the next omp session. The
loop is not coupled to memorix's internals; any tool exposing a store/search
memory interface reachable from the session works, and `claude-mem` is
detected the same way.

### Making memorix reachable (per harness)

memorix is reachable when **either** a `memorix` CLI is on `PATH` **or** a
memorix MCP server is configured for the session. Pick whichever your harness
uses:

- **Claude Code / Codex / Copilot (MCP):** add the memorix MCP server to the
  harness's MCP config (`~/.claude.json`, project `.mcp.json`, or
  `.claude/settings.json`). The reflection pass calls its `memory_store` /
  `memory_search` tools directly — no shell command needed.
- **omp:** register memorix as an MCP server / tool provider in
  `~/.omp/agent/config.yml` per your omp setup.
- **Any harness (CLI):** install the `memorix` (or `claude-mem`) CLI so it is on
  `PATH`; the reflection pass shells out to it.

### Verifying which backend is active

```bash
agent-flywheel memory --status
```

prints the reachable backends richest-first; the first line is the one the
reflection pass will use as primary. `agent-flywheel doctor` prints the same
primary as an informational line. If the only line is `flat-file`, memorix is
not reachable and the loop is running on the baseline — which is fine, just not
cross-session-searchable.

## Optional per-stage skills (used when present, fallback otherwise)

The reflection prompts prefer a dedicated skill for a stage when it is installed
and degrade to a built-in fallback otherwise — none are required:

| Stage | Preferred skill | Built-in fallback |
|---|---|---|
| SCAN | `task-observer` | reread the transcript inline |
| MEMORY | `memorix` / `claude-mem` | `MEMORY.md` (always also written) |
| GUARDRAILS | `learn-from-session` | `GUARDRAILS.md` + `reference/guardrails-format.txt` |
| SKILL create | `skill-creator` | `agent-flywheel skill new` |
| SKILL compact | `skill-compactor` | `reference/skill-authoring.txt` COMPACT section |
| LEVEL | `level-up-coach` | `reference/level-rubric.txt` |

See [ADR-0002](decisions/0002-reimplement-not-bundle.md) for why these are
cooperated-with, not bundled or required.
