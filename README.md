# agent-flywheel

A harness-agnostic **reflect → write → proceduralize** self-improvement loop
for AI coding agents. It makes the "remember what happened, learn from it,
turn repeated work into a reusable procedure" cycle automatic — at session
end, periodically mid-session, and at the very first turn — instead of
depending on a human, or the agent itself, remembering to trigger it.

Ships adapters for four harnesses today (**omp**, **Claude Code**, **Codex
CLI**, **GitHub Copilot CLI**), plus a plain-CLI fallback (`bin/agent-flywheel`)
that works with literally anything that can run a shell command — see
[`adapters/generic/README.md`](adapters/generic/README.md).

## Why this exists

Every AI coding harness eventually reinvents the same three things: a way to
persist what an agent learned past its context window, a way to nudge it
toward disciplined habits at the start of a task, and a way to keep doing
both without a human remembering to ask. Most harnesses ship none of this,
or ship it as one proprietary plugin tied to one tool. agent-flywheel is the
harness-agnostic version: the prompts and logic live in one place
(`core/`), and each harness gets a thin adapter that wires its own
hook/event system to the same shared files — so the behavior is identical
everywhere and never drifts into four slowly-diverging copies.

## Architecture

```
core/
  lib.sh                    shared bash helpers every adapter hook sources
  prompts/
    session-end.txt         reflection procedure run when a session ends
    periodic.txt            lightweight version run on an idle mid-session timer
    maturity-nudge.txt       first-turn habits nudge (spec-first, verify-gate, delegate)
scripts/
  advisor-autotune.mjs      deterministic auto-tune for omp's native advisor subsystem
  idle-gap.mjs              idle/rate-limit check for harnesses with no native timer
bin/
  agent-flywheel            universal CLI: nudge | prompt | periodic-check | periodic-mark | autotune
adapters/
  omp/                      extension (before_agent_start nudge, session hooks) + rules + config
  claude-code/               SessionStart/SessionEnd hooks + settings.json snippet
  codex/                     session-end hook + notes on what's verified vs not
  copilot/                   session-end hook + notes on what's verified vs not
  generic/                   wiring guide for anything else (Cursor, Windsurf, Aider, ...)
install.sh / uninstall.sh    idempotent installer/uninstaller for every detected harness
tests/                       node --test unit tests + install/uninstall idempotency smoke test
```

**Session-end reflection.** Every harness here is fire-and-forget at
session-end (no hook can force "one more turn" in a closing session), so
every adapter spawns a detached, headless subprocess that resumes the
transcript that just ended and runs the shared `session-end.txt` procedure
against it, guarded by an `AGENT_FLYWHEEL_PASS=1` env var so the spawned
reflection pass's own session-end doesn't spawn another one recursively.

**Periodic mid-session checkpoint.** A session left open and idle for hours
would otherwise never get a reflection pass until it finally closes.
Harnesses with a native background-timer primitive (omp's extension API)
arm it directly; harnesses without one get `scripts/idle-gap.mjs`, a small
dependency-free Node script wired into the harness's own hook system on a
poll interval, rate-limited across every running harness on the machine by
one shared marker file so leaving many terminals open doesn't multiply cost.

**First-turn maturity nudge.** `core/prompts/maturity-nudge.txt` — spec
first for ambiguous/multi-file work, delegate genuinely reusable sub-work,
verify before claiming done, prefer the boring existing pattern — injected
once per session via whatever first-turn/system-prompt mechanism the
harness exposes (omp: `before_agent_start`; Claude Code: `SessionStart`
`additionalContext`; anything else: `bin/agent-flywheel nudge`).

**Advisor auto-tune (omp only).** `scripts/advisor-autotune.mjs`
deterministically disables omp's native second-model advisor subsystem if
it has reviewed a real sample of sessions (default: 8) and never once
raised anything above a "nit" — i.e., it isn't earning its own API cost.
This is a mechanical count, not an LLM instruction, on purpose: a config
flip that depends on a model "remembering" to check a condition is exactly
the kind of thing that should be code instead.

## Research grounding

The reflect → write → proceduralize procedure in `core/prompts/*.txt` is
the standard reflection-agent pattern from the agent-memory literature, not
ad-hoc summarizing:

- **Reflexion** (Shinn et al., 2023, [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) — verbal self-reflection on
  past episodes, stored and reused as linguistic feedback for future
  attempts, without any weight updates.
- **CoALA: Cognitive Architectures for Language Agents** (Sumers et al.,
  2023, [arXiv:2309.02427](https://arxiv.org/abs/2309.02427)) — the
  episodic / semantic / procedural memory decomposition this project's
  SCAN → REFLECT → WRITE → PROCEDURALIZE steps map onto directly: episodic
  (what happened this session), semantic (durable facts/preferences,
  written to `~/.agent-flywheel/MEMORY.md`), procedural (repeated
  multi-step workflows turned into a skill/script).
- **Generative Agents** (Park et al., 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) —
  memory decay/consolidation informing this project's DECAY step: a
  stale, contradicted memory is actively corrected in place, not left to
  accumulate alongside a newer contradicting entry.

## Install

```bash
git clone https://github.com/abhishekgarg18/agent-flywheel.git
cd agent-flywheel
./install.sh              # detect + wire every harness found on this machine
./install.sh --dry-run     # see what it would do first, without touching anything
```

`install.sh` syncs this repo to `~/.agent-flywheel` and then, for each
harness it detects:

| Harness | What gets wired automatically |
|---|---|
| **omp** | Extension + rules copied into `~/.omp/agent/`; `WATCHDOG.md`/`WATCHDOG.yml` seeded only if absent (never overwrites your customization); `config.yml`'s `advisor:` block merged in idempotently via marker comments |
| **Claude Code** | `SessionStart`/`SessionEnd` hooks merged into `~/.claude/settings.json` via `jq` (idempotent — re-running updates, never duplicates) |
| **Codex CLI** | Not auto-wired — printed manual instructions. Codex's `additionalContext`/background-timer hook schema was never confirmed while building this, so this project doesn't ship an unverified auto-wire step. See [`adapters/codex/notes.md`](adapters/codex/notes.md). |
| **GitHub Copilot CLI** | Same as Codex — manual instructions only. See [`adapters/copilot/notes.md`](adapters/copilot/notes.md). |
| **Anything else** | `bin/agent-flywheel nudge` / `prompt` / `periodic-check` are plain CLI primitives with zero harness assumptions. See [`adapters/generic/README.md`](adapters/generic/README.md). |

Only two config files are ever mutated, and only inside markers or via a
scoped `jq` filter targeting exact command strings — nothing else in either
file is touched, and re-running `install.sh` after a `git pull` is always
safe.

```bash
./uninstall.sh              # unwire from every harness, keep ~/.agent-flywheel (logs/markers)
./uninstall.sh --purge      # also delete ~/.agent-flywheel entirely
```

## Testing

```bash
node --test                        # unit tests for advisor-autotune.mjs + idle-gap.mjs
./tests/install-idempotency.sh     # sandboxed install/uninstall smoke test (never touches your real config)
shellcheck adapters/*/hooks/*.sh core/lib.sh install.sh uninstall.sh bin/agent-flywheel
```

All three run in CI on every push/PR — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Contributing

The Codex and Copilot adapters ship only what was verified against each
CLI's actual documented hook behavior while building this project — see the
"Not wired here" section of each adapter's `notes.md` for exactly what's
still missing (a session-start/`additionalContext` equivalent and a native
periodic-checkpoint hook) and why it's a deliberate omission, not an
oversight. PRs that confirm the real schema and close that gap are welcome.

## License

MIT — see [LICENSE](LICENSE).
