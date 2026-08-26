# Configuration

Everything here has a working default — agent-flywheel runs with zero config.
This page is for when you want to tune *when* the loop fires and *where* it
keeps its memory.

## Where the loop keeps its state (it's central, not per-project)

All durable state lives in **one central directory, independent of your current
working directory** — so it doesn't matter how often you `cd` between projects:

```
$AGENT_FLYWHEEL_HOME   (default: ~/.agent-flywheel)
├── MEMORY.md          durable semantic memory (one dated bullet per insight)
├── GUARDRAILS.md      binding corrections ledger (G1, G2, …)
├── LEVEL.md           self-scored level trend, one line per session
├── LEARN.log          human-visible audit trail of every reflection pass
├── SELF-IMPROVE.md    the meta pass's own health ledger
├── config.env         your config (this file's knobs); seeded on install
├── reflection.log     stdout/stderr of every detached reflection subprocess
└── .last-*            cadence markers (periodic / self-improve)
```

Because this is a fixed path under `$HOME`, a lesson learned in
`~/work/project-a` is the same `MEMORY.md` read in `~/work/project-b` — the loop
is machine-global by design, never scoped to a repo you happened to be in.

**Relocating it.** Set `AGENT_FLYWHEEL_HOME` to an absolute path. This is the one
setting that must be a **shell-profile env var** (e.g. in `~/.bash_profile`),
not a `config.env` line — `config.env` lives *inside* `AGENT_FLYWHEEL_HOME`, so
the location can't be read from a file inside the location it points to:

```bash
# ~/.bash_profile
export AGENT_FLYWHEEL_HOME="$HOME/Dropbox/agent-flywheel"   # e.g. a synced dir
```

Then `./install.sh` installs there and every harness adapter reads it. Point it
at a synced folder (Dropbox/iCloud/git) to share one memory across machines
without memorix.

**The higher tier: memorix.** When memorix (or claude-mem) is reachable, it is
the *primary* semantic store and is inherently central + cross-project +
searchable, while `MEMORY.md` remains the always-written portable baseline.
That is the recommended setup for a durable, queryable memory that outlives any
single machine — see [prerequisites.md](prerequisites.md). Verify which store is
active with `agent-flywheel memory --status`.

## Tuning when the loop fires

Edit `~/.agent-flywheel/config.env` (seeded from
[`config.env.example`](../config.env.example), never overwritten on re-install).
Precedence, highest first: a shell env var of the same name → `config.env` → the
built-in default.

### The meta self-improvement pass (the loop improving itself)

| Key | Values | Default | Effect |
|---|---|---|---|
| `AGENT_FLYWHEEL_SELF_IMPROVE_MODE` | `every-session` / `gap` / `days` / `off` | `gap` | how often the meta pass may auto-run |
| `AGENT_FLYWHEEL_SELF_IMPROVE_GAP_DAYS` | integer | `7` | for `mode=gap`: min days between passes |
| `AGENT_FLYWHEEL_SELF_IMPROVE_DAYS` | `Mon…Sun` or `1…7`, comma list | `Sat` | for `mode=days`: which weekdays |
| `AGENT_FLYWHEEL_SELF_IMPROVE_TRIGGER` | `session-end` / `mid-session` / `both` | `session-end` | which point may run it |

Examples:
- Run it **every session** at close-out: `MODE=every-session`.
- Run it **only on weekends**: `MODE=days`, `DAYS=Sat,Sun`.
- Run it **mid-session too, at most weekly**: `MODE=gap`, `TRIGGER=both`.
- **Never** auto-run (manual `agent-flywheel self-improve` only): `MODE=off`.
- **Fixed real-clock time** (e.g. 9am daily): the loop only acts on session
  events, so for a true wall-clock schedule, set `MODE=off` and add a cron/launchd
  job: `0 9 * * * ~/.agent-flywheel/bin/agent-flywheel self-improve --mark | <your-harness-headless-invocation>`.

### Session-start primers (resume context injected with the nudge)

So agent-flywheel can fully replace a hand-rolled session-start hook, the
first-turn nudge can also surface resume context. Both default ON when the
resource is present:

| Key | Default | Effect |
|---|---|---|
| `AGENT_FLYWHEEL_NUDGE_HANDOFF` | `1` | surface the newest `*.md` handoff to resume from |
| `AGENT_FLYWHEEL_HANDOFFS_DIR` | `~/.claude/handoffs` | where handoffs live |
| `AGENT_FLYWHEEL_NUDGE_MEMORIX` | `1` | inject the memorix Workset (per-project brief: start-here files, reliable memories, cautions, git facts) when the `memorix` CLI is present |

Set either to `0` to suppress. The memorix Workset is the same
`memorix context … --brief-json` bundle a manual session-start hook would emit.

### The periodic mid-session checkpoint (lightweight reflection while idle)

| Key | Default | Effect |
|---|---|---|
| `AGENT_FLYWHEEL_PERIODIC_CHECK_SECONDS` | `900` | how often the idle check runs |
| `AGENT_FLYWHEEL_IDLE_SECONDS` | `300` | transcript must be idle this long |
| `AGENT_FLYWHEEL_MIN_PERIODIC_GAP_SECONDS` | `7200` | floor between actual passes, shared across harnesses |

Read by both the Claude Code periodic-watcher and the omp extension, so one
setting applies everywhere. (The close-out reflection always runs on every
session end — that is not gated here.)

## Verifying config took effect

```bash
agent-flywheel self-improve --gate --trigger session-end; echo "due? exit=$?"  # 0=due now, 1=not due
agent-flywheel memory --status                                                  # active memory backend
agent-flywheel doctor                                                           # wiring + primary memory
```
