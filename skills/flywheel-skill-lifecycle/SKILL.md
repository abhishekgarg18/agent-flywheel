---
name: flywheel-skill-lifecycle
description: Turn a repeated workflow into a durable skill the right way — spec it, check for an existing one, create or update, then always compact. Use when creating, updating, or compacting a SKILL.md, when a workflow has recurred 3+ times, or on "make this a skill", "skill spec", "compact this skill".
---

The procedural-memory stage of the agent-flywheel loop, as an on-demand skill.
Run it whenever you turn a recurring workflow into a skill or edit any SKILL.md —
skipping the spec, or shipping without a compaction pass, is how skills rot.

Prefer the user's dedicated tools when installed (they do the richer work); this
skill is the self-contained fallback:
- `skill-creator` → CREATE.
- `skill-compactor` → COMPACT (mandatory, never skipped).
- neither → plugin reference docs + `agent-flywheel skill` CLI.

## 1. SPEC (before writing anything)
State, in one or two lines: the trigger phrases a future agent would actually
type to invoke this, the exact steps/commands, and the ONE non-obvious reason
each step exists. If you can't name distinct trigger phrases, it isn't a skill
yet — it's a memory bullet. A one-off is never a skill (needs 3+ recurrences).

## 2. CHECK-EXISTING (never build a duplicate)
Run `agent-flywheel skill list` (or read every root in
`${CLAUDE_PLUGIN_ROOT}/core/prompts/reference/skill-roots.txt`). Scan each
skill's `description` only. Material trigger-phrase overlap → go to UPDATE, do
not create a second copy. No overlap anywhere → CREATE.

## 3. CREATE or UPDATE
- CREATE: `agent-flywheel skill new <name> --root <path> --description "<text>"`
  (scaffolds the frontmatter contract + `references/`), or `skill-creator`.
  Pick the root matching where the workflow applies (project-local vs global).
- UPDATE: a small fix (wrong command, missing flag, one new trigger) → edit in
  place. A structural change → read the whole file first, preserve every still-
  valid behavior/trigger, never silently drop a capability another caller relies
  on. A skill that told you to do something wrong is an UPDATE, not a new memory.
Full contract: `${CLAUDE_PLUGIN_ROOT}/core/prompts/reference/skill-authoring.txt`.

## 4. COMPACT (mandatory, immediately — never deferred)
Re-read the whole file fresh. Cut restated context, redundant examples,
ceremony. Keep the trigger-phrase description, the exact steps, the one reason
each exists. Move verbose detail into `references/*.md` referenced by name
(progressive disclosure). Never change behavior while compacting — it's a
wording/structure pass. If `skill-compactor` is installed, invoke it instead of
doing this by hand. A skill past a few hundred lines with no reason to be = split.
