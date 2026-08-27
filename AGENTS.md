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
- **Claude reflection does NOT `--resume <session_id>`.** `claude -p --resume
  <uuid>` fails with "No conversation found" for a just-ended session and aborts
  the whole reflection — the live bug this replaced. Claude spawns run
  `claude -p "$PROMPT" --no-session-persistence`; the prompt carries the
  transcript path and reads it directly. Don't "restore" `--resume` for the
  claude-code adapter or `bin` claude branch. (omp/codex/copilot resume by their
  own key and are unaffected.) Also: the SessionEnd hook skips `reason=resume`
  (not a real end) and requires a transcript path; `REASON` is sanitized with
  `tr -cd` (delete, not replace) so jq's trailing newline can't become a `_`
  that breaks the exact-match reason skip.
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
- **memorix's own transport/hooks are outside agent-flywheel's control and can storm the CPU on their own — don't assume lean-MCP + the reflection rate-limit (5e14321) fully insulates the machine.** Confirmed 2026-08-26: memorix wired *stdio* (`{"command":"memorix","args":["serve","--mode","lite"]}`) in `~/.claude.json`/omp's `mcp.json` spawns a node process per session; separately, memorix's own `PostToolUse`/`UserPromptSubmit`/`PreCompact` hooks fire LLM-formation-per-tool-event through Ollama regardless of transport or agent-flywheel's rate-limit, and any harness with those hooks active (Claude, omp, Codex) drives the same load independently — trimming one harness's hooks doesn't stop another's. If a future session sees a resource storm again, check memorix's *own* config/hooks first (`~/.memorix/config.toml`, `memorix hook`'s registered events) before assuming it's an agent-flywheel regression. See `~/.agent-flywheel/{MEMORY,GUARDRAILS}.md` (G2/G5/G6) for the full trace; a clean "embeddings-only, no LLM formation" memorix toggle was still unresolved as of that session — check upstream memorix docs/repo before re-trimming per-harness hooks again.
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
  The meta pass's apply mode is a **config.env setting**
  (`AGENT_FLYWHEEL_SELF_IMPROVE_APPLY_MODE=propose|auto-apply`, default
  `propose`), not a hardcoded behavior — a fresh install gets the safe
  propose-only gate; a user opts into `auto-apply` explicitly in their own
  `config.env`. The hook computes which mode is active (`flywheel_lib.sh`'s
  `flywheel_self_improve_apply_note`, deterministic — not left for the LLM to
  "check config" itself, the same class of bug the GUARDRAILS detection fix
  addressed) and hands it to the prompt as a fact. In `auto-apply` mode the
  pass edits `core/prompts/*.txt` directly in the SOURCE checkout, runs
  `doctor` to verify wiring, and `git commit`s the change (no push) so a bad
  auto-edit is a `git revert`, not silent unrecoverable drift. Either mode
  only ever touches the source checkout, never the *installed*
  `~/.agent-flywheel` copy directly — `doctor --heal`/install.sh syncs that
  out to every harness. Enforced by prose in `self-improve.txt` + the config
  fact from `lib.sh`, not code that blocks the edit — keep it that way.
- **`flywheel_load_config` is a security boundary, not a convenience parser.**
  It runs at source time on every hook. The key is used in an indirect
  expansion, so it MUST stay eval-free with the strict `*[!A-Za-z0-9_]*`
  allowlist reject + `printf -v` assignment. Never reintroduce `eval` on
  file-derived content. Pinned by `tests/lib-safety.test.mjs`.
- **`.source-checkout` designates a script `doctor --heal` EXECUTES**, so heal
  gates it through `flywheel_path_trusted` (owner + not group/other-writable,
  GNU/BSD-stat aware). Any new "read a path from a state file then run it" code
  MUST go through the same gate.
- **Concurrency: three atomic mkdir locks.** `session-end.sh`'s per-session
  `watchers/<id>.reflect-lock` (so plugin + settings.json double-wiring can't
  double-spawn a reflection), `install.sh`'s `.install.lock` (so two installs /
  a heal can't race `rsync --delete`), and `cmd_self_improve`'s
  `.self-improve.lock` (so concurrent sessions can't both pass a stale cadence
  marker). All self-clear when stale. Don't remove a lock without replacing it.
- **Prompts never assume the CLI is on PATH.** The reflection subprocess doesn't
  inherit the harness PATH or `${CLAUDE_PLUGIN_ROOT}`, so every spawn site
  appends `flywheel_cli_note` (bash) / the equivalent (omp TS) and the prompts
  reference "the CLI path at the end of this prompt". `flywheel_cli_path`
  resolves relative to `lib.sh` so it's correct for BOTH install.sh and plugin
  channels. Keep that indirection when adding a prompt that calls the CLI.
- **Reflection routes lessons by LEVEL.** `reference/project-rules.txt` governs
  global (personal store / global rules file) vs project (the repo's own
  AGENTS.md/CLAUDE.md) — a project convention belongs in the repo so every
  contributor/harness inherits it, not only `~/.agent-flywheel`. When editing
  the MEMORY/PROJECT-RULE step, preserve the level decision.

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

**Testing install.sh: sandbox HOME, not just `--home`.** `--home`/`FLYWHEEL_HOME`
only redirects the synced tree; `wire_claude_code`/`wire_omp` always write to the
real `$HOME/.claude` / `$HOME/.omp`. A manual test run without `HOME=<tmp>` will
pollute your live config (`tests/install-idempotency.sh` sets a sandbox HOME —
mirror that: `HOME=$(mktemp -d) AGENT_FLYWHEEL_HOME=$HOME/.agent-flywheel ./install.sh`).

## Where decisions are recorded

Non-obvious architecture decisions (why detached-spawn instead of a
blocking call, why this reimplements rather than bundles Hermes/other
harness-memory tools, why flat files over a database, why Codex/Copilot
aren't auto-wired) are in [`docs/decisions/`](docs/decisions/) as ADRs.
Read the relevant one before reversing a decision that looks arbitrary —
it likely isn't.
