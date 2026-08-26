# Prior art — what agent-flywheel borrows, and from where

agent-flywheel is not a new idea; it is a specific, harness-agnostic packaging
of well-established agent-memory and self-improvement patterns. This page maps
each influence to what this project adopts and what it deliberately leaves out,
so a reviewer can see the loop is grounded, not ad-hoc.

## Research lineage

| Source | Core idea | What agent-flywheel adopts | What it drops |
|---|---|---|---|
| **Reflexion** (Shinn et al. 2023, [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) | Verbal self-reflection on past episodes, stored as linguistic feedback, no weight updates | The whole reflect-and-store premise: `session-end.txt`'s SCAN→IDENTIFY is verbal reflection persisted for the next attempt | Task-specific reward/retry loop — we reflect for durable memory, not to retry one task |
| **CoALA** (Sumers et al. 2023, [arXiv:2309.02427](https://arxiv.org/abs/2309.02427)) | Episodic / semantic / procedural memory decomposition for language agents | The stage split: SCAN=episodic, MEMORY=semantic (`MEMORY.md`/memorix), SKILL=procedural (a skill) | The full cognitive-architecture runtime; we take only the memory taxonomy |
| **Generative Agents** (Park et al. 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) | Reflection + memory decay/consolidation over time | The DECAY step: a contradicted memory is corrected in place, not appended alongside | Importance-weighted retrieval scoring — flat files + memorix search cover recall |
| **Voyager** (Wang et al. 2023, [arXiv:2305.16291](https://arxiv.org/abs/2305.16291)) | An ever-growing **skill library** + an automatic **curriculum** proposing the next skill to learn | The skill library (CHECK-EXISTING→CREATE/UPDATE→COMPACT) AND the curriculum: `self-improve.txt` check 4 proposes the next skill that is 2/3 built | Simulator-specific self-play; our curriculum is driven by real recurrence in `MEMORY.md`/`LEARN.log` |
| **MemGPT / memory tiers** (Packer et al. 2023, [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)) | Tiered memory: fast in-context vs. paged durable store | The two-tier memory prerequisite: flat-file baseline always-on, memorix as the richer paged store when reachable (see [prerequisites.md](prerequisites.md)) | A paging controller inside one process; our tiers are files + an external store |

## Tooling lineage (harness ecosystems)

| Source | Core idea | agent-flywheel's stance |
|---|---|---|
| **Claude Code superpowers / skills** (`learn-from-session`, `skill-creator`, `skill-compactor`, `level-up-coach`, `task-observer`) | Dedicated skills for each stage of a self-improvement loop | **Cooperate, don't duplicate** — each is named as the *preferred* path for its stage when installed; the built-in fallback only runs when it's absent ([ADR-0002](decisions/0002-reimplement-not-bundle.md)). The bundled `flywheel-skill-lifecycle` skill is the self-contained fallback for the SKILL/COMPACT stage. |
| **omp advisor** (native second-model reviewer) | A model reviews sessions and flags issues | Kept as-is when present, and **auto-tuned**: `advisor-autotune.mjs` deterministically disables it if it never earns its cost over a real sample — a mechanical count, not an LLM instruction. |
| **Hermes-agent** (a personal AI-agent harness proposed internally) | One integrated harness that owns memory + habits + review | **Reimplement, don't bundle** — a hard dependency on one external tool's license/approval/release cadence contradicts "works with zero setup on any harness." The Slack thread that surfaced Hermes is exactly what motivated [ADR-0002](decisions/0002-reimplement-not-bundle.md). We take the *ambition* (one loop across every harness) and reject the *coupling*. |
| **Cursor/Windsurf rules, `.clinerules`, AGENTS.md** | Static first-turn instructions | Generalized into `maturity-nudge.txt`, injected via whatever first-turn mechanism each harness exposes, plus dynamic GUARDRAILS/LEVEL surfacing. |

## What's genuinely this project's own contribution

- **Harness-agnostic single source.** The same `core/prompts/*.txt` drive omp,
  Claude Code, Codex, Copilot, and any CLI — one behavior, not four drifting copies.
- **The improver improves itself.** `self-improve.txt` + the weekly-by-default,
  fully configurable meta cadence make the loop reflect on its OWN prompts,
  adapters, guardrail effectiveness, and level trend — auto-heal first, then
  propose or apply changes to its own machinery. Most systems above improve the
  agent; few improve the improvement loop.
- **Self-heal.** `doctor --heal` re-syncs and re-wires from the recorded source
  checkout, so drift in the loop's own wiring is repaired, not silently tolerated.
