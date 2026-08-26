# AGENTS.md — agent-flywheel

This file is the AI-native context doc for working *on* agent-flywheel
itself (not the docs it installs into other projects). If you're an agent
resuming work in this repo, read this before exploring — it's the fast path
to "how is this structured, what are the load-bearing invariants, what
breaks if I get sloppy."

## What this repo is

A harness-agnostic reflect → write → proceduralize self-improvement loop
for AI coding agents (omp, Claude Code, Codex CLI, GitHub Copilot CLI, or
anything with a shell). Full architecture, research grounding, and the
Invocation Reference table live in [README.md](README.md) — read that
first for the "what" and "why." This file is the "how to change it safely."

## Single source of truth

`core/lib.sh` + `core/prompts/*.txt` are the ONLY place the reflection
logic and prompt text live. Every adapter under `adapters/<harness>/` is a
thin wiring layer that sources `lib.sh` and reads the shared prompt files —
it must never duplicate logic or fork its own copy of prompt text. If you
find yourself editing the same behavior in two adapters, you are fixing
the wrong file; fix `core/` once and let every adapter pick it up.

`bin/agent-flywheel` (bash) and `adapters/omp/extensions/self-improvement-loop.ts`
(TypeScript) are two independent implementations of the same
`spawn_harness_resume` / `flywheel_render_nudge` contract — one because omp
extensions must be TS, not because TS is preferred. When you change the
dispatch format (what argv `omp`/`claude`/`codex`/`copilot` receive) or the
nudge-rendering logic (guardrails/level appended to the nudge text) in
one, mirror it in the other. `tests/reflect-dispatch.test.mjs` only covers
the bash side; there is no automated parity test between the two — verify
by inspection when touching either.

## Load-bearing constraints (do not "simplify" these away)

- **bash 3.2 compatibility.** macOS ships bash 3.2 as `/bin/bash` with no
  `mapfile`/`readarray`. `spawn_harness_resume()` in `bin/agent-flywheel`
  is four plain `case` branches for exactly this reason — resist turning
  it into a generic argv-array abstraction.
- **Detached spawn, not a blocking call.** No harness's session-end/switch
  hook can force "one more turn" in the process that is closing. Every
  adapter spawns a *new*, detached, headless subprocess against the
  transcript that just ended, guarded by `AGENT_FLYWHEEL_PASS=1` so that
  subprocess's own eventual exit does not recursively spawn another pass.
- **Never redirect child stdio to `/dev/null`.** Every detached spawn
  (bash adapters and the omp extension) redirects to
  `~/.agent-flywheel/reflection.log` (`flywheel_reflection_log` /
  `REFLECTION_LOG`) so a silently-failing reflection pass is still
  visible via `agent-flywheel log`.
- **`--print` must stay byte-identical to the real spawn.** `spawn_harness_resume`
  shares its `case` branches between the `--print` (shell-quoted via
  `printf %q`) and real-spawn paths so they can never drift apart — don't
  add a second code path for "just showing the command."
- **Flat-file-only fallback.** `~/.agent-flywheel/MEMORY.md`,
  `GUARDRAILS.md`, `LEVEL.md`, `LEARN.log` are plain append-only text, zero
  dependencies. `memorix`/`claude-mem` are preferred *when reachable*, but
  the flat files must always work standalone — never make a feature
  depend on memorix being installed.
- **Codex/Copilot adapters are intentionally manual-wiring-only.** Their
  hook schemas were never confirmed against real, current CLI behavior.
  Don't add an auto-wire step to `install.sh` for them without first
  verifying the actual hook contract (see `adapters/codex/notes.md` /
  `adapters/copilot/notes.md` for exactly what's unverified).
- **Never `--delete` user state on re-sync.** `install.sh`'s `sync_repo`
  syncs the repo INTO `FLYWHEEL_HOME`, the same dir that holds the user's
  accumulated `MEMORY.md`/`GUARDRAILS.md`/`LEVEL.md`/`LEARN.log`/
  `SELF-IMPROVE.md`/`config.env`/cadence markers/`watchers/`. The `protect`
  array in `sync_repo` excludes every one of these from both the rsync
  `--delete` and the tar-fallback wipe — a re-install that removed them would
  destroy the whole point of the loop. **Any new runtime-state file MUST be
  added to that `protect` list** (and it's pinned by
  `tests/install-preserves-state.test.mjs`).
- **Cadence has one source of truth: `flywheel_self_improve_due` (core/lib.sh).**
  The session-end/periodic prompts decide "is the meta pass due now" by calling
  `agent-flywheel self-improve --gate --trigger <pt>`, never by hardcoding a
  schedule in prompt text. Config precedence is env var > `config.env` >
  built-in default (`flywheel_load_config` only sets a key the environment
  hasn't already set). New config keys read via `${VAR:-default}` getters.
- **The Claude Code plugin mirrors, never forks.** `.claude-plugin/`,
  `hooks/hooks.json`, `commands/*.md`, and `skills/` reference the same
  `core/` prompts and `adapters/claude-code/hooks/*.sh` via
  `${CLAUDE_PLUGIN_ROOT}` — exactly the single-source rule the adapters follow.
  A command that copied prompt text instead of `@${CLAUDE_PLUGIN_ROOT}/core/...`
  would be a second drifting copy; fix `core/` once.
- **`usage()` slices dynamically** (line 2 → the line before the first `set -`),
  so adding/removing a subcommand's header doc block can't desync `help`. Keep
  each subcommand's doc block in that header comment, not a separate string.
- **The meta layer is `core/prompts/self-improve.txt` + `doctor --heal`.** The
  loop reflects on itself (its own prompts/adapters/effectiveness) and repairs
  its own wiring from the recorded `.source-checkout`. `doctor --heal` re-runs
  `install.sh` from that checkout when run out of the installed home (where its
  own `ROOT_DIR == FLYWHEEL_HOME` and thus has nothing to re-sync from itself).

## Conventions

- **Tests:** `node --test` auto-discovers every `tests/*.test.mjs` — no
  registration needed. Follow the existing pattern (see
  `tests/idle-gap.test.mjs`, `tests/skill-scaffold.test.mjs`,
  `tests/reflect-dispatch.test.mjs`): export testable helpers from the
  `.mjs` script itself, then add a thin CLI-integration test via
  `execFileSync` for the exit-code/stdout contract. Never test bash CLI
  output by string-matching bash's `printf %q` quoting scheme directly —
  round-trip it (see `reflect-dispatch.test.mjs`'s `capturedArgv` helper,
  which shadows the target binary with a bash function that dumps argv).
- **Shellcheck:** run with the exact flags in `.github/workflows/ci.yml`
  (`--shell=bash --exclude=SC1091`) — SC1091 fires on every dynamically
  resolved `source "$CORE_DIR/lib.sh"` and is expected noise, not a real
  finding.
- **`core/prompts/*.txt` is prose the agent reads, not code.** Changes
  here are a wording/structure pass, not a rewrite of what the agent is
  told to do. `core/prompts/reference/*.txt` are the CHECK-EXISTING
  fallback docs used only when the user's own dedicated skill
  (skill-creator, learn-from-session, level-up-coach, memorix) isn't
  installed — keep them accurate to what those skills would otherwise do.
- **`bin/agent-flywheel help`** (the `usage()` function) is generated by
  `sed`-slicing this file's own header comment block (lines 2-64) — if you
  add or change a subcommand, update that header comment, not a separate
  usage string, or `help` output silently goes stale.

## Verifying a change

```bash
node --test                                              # unit + CLI-integration tests
./tests/install-idempotency.sh                           # sandboxed install/uninstall + doctor/reflect smoke test
shellcheck adapters/*/hooks/*.sh core/lib.sh install.sh uninstall.sh bin/agent-flywheel --exclude=SC1091
find . -name "*.sh" -not -path "./.git/*" -print0 | xargs -0 -n1 bash -n && bash -n bin/agent-flywheel
```

All four run in CI (`.github/workflows/ci.yml`) on every push/PR — run them
locally before claiming a change is done.

## Where decisions are recorded

Non-obvious architecture decisions (why detached-spawn instead of a
blocking call, why this reimplements rather than bundles Hermes/other
harness-memory tools, why flat files over a database, why Codex/Copilot
aren't auto-wired) are in [`docs/decisions/`](docs/decisions/) as ADRs.
Read the relevant one before reversing a decision that looks arbitrary —
it likely isn't.
