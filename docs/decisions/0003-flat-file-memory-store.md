# ADR-0003: Flat append-only text files for MEMORY/GUARDRAILS/LEVEL/LEARN, not a database

**Date**: 2026-08-26
**Status**: accepted
**Deciders**: agent-flywheel maintainers

## Context

The reflection loop needs somewhere durable to write what it learns:
semantic memory (`MEMORY.md`), binding corrections (`GUARDRAILS.md`), a
self-scoring trend (`LEVEL.md`), and a human-visible audit trail
(`LEARN.log`). This project targets zero runtime dependencies beyond bash
and node, and must work identically whether it's the only tool installed
or one of many on a fully-loaded developer machine.

## Decision

`~/.agent-flywheel/{MEMORY.md,GUARDRAILS.md,LEVEL.md,LEARN.log}` are plain
append-only text files, read and written with `cat`/`grep`/`tail`/simple
appends — no SQLite, no embedded database, no schema migration story.
`memorix`/`claude-mem` (or an equivalent semantic store) is preferred when
reachable, per ADR-0002, but the flat files are always written to as well,
regardless — they are the zero-dependency baseline this project guarantees.

## Alternatives Considered

### Alternative 1: A local SQLite database
- **Pros**: queryable, structured, easier to build tooling (e.g. a `agent-flywheel guardrails --search`) on top of later.
- **Cons**: adds a dependency (or requires bundling a driver) on every one of the four harness runtimes (bash script, Node script, TypeScript extension) doing schema-aware reads/writes; a corrupted DB file is opaque to a human trying to `cat` it during an incident.
- **Why not**: the entire value of this project is "works everywhere, no setup" — a database dependency (even an embedded one) contradicts that, and every consumer (bash `grep`, Node `readFileSync`, a human `tail -f`) already works today with zero added tooling.

### Alternative 2: One structured JSON/YAML file instead of several flat text files
- **Pros**: single file, easier to validate a schema against.
- **Cons**: concurrent appends from multiple harnesses/processes risk corrupting a single JSON document (a truncated write mid-append is unrecoverable); plain `.md`/`.log` files are trivially append-only and human-readable without tooling.
- **Why not**: `LEARN.log`'s own contract ("append exactly one line... never overwrite prior lines") depends on the file being line-append-safe under concurrent writers — a single JSON blob does not have that property without a lock file this project doesn't want to build.

## Consequences

### Positive
- Zero new dependencies; every existing tool (`cat`, `grep`, `tail -f`, a text editor) already works on these files.
- Append-only writes from multiple concurrent harness processes are safe by construction (each process appends a line; no read-modify-write race on the whole file).
- A human `tail -f ~/.agent-flywheel/LEARN.log` (or `agent-flywheel log`) is a complete, zero-setup observability story.

### Negative
- No structured querying (`agent-flywheel guardrails --search "foo"` would have to grep, not query) — acceptable given the bounded size of these files (a ledger of guardrails/levels, not a general-purpose datastore).
- Growth is unbounded — these files are never rotated or pruned by this project today. A future ADR would be needed if that becomes a real problem (currently out of scope, no evidence it is one).

### Risks
- **Unbounded growth**: not yet mitigated; deferred until it's an observed problem rather than a speculative one.
