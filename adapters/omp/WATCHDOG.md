# Watchdog notes

Ported from the "Todo Continuation Enforcer" and "Comment Checker" patterns
found in some open-source coding-agent harnesses, running here as omp's
native continuous advisor (a second model reviewing every turn on its own
context) instead of a bolt-on plugin. The regex-gated, zero-cost-until-
triggered version of the same two checks lives in
`rules/todo-continuation-enforcer.md` and `rules/comment-checker.md` (TTSR).
This file is for the judgment calls a regex can't make.

Especially watch for:

- A "done"/"complete"/"ready to ship" claim while a todo item is still open,
  a named acceptance criterion is unaddressed, or a stub/TODO/placeholder/
  mock/no-op was left in a changed file.
- A comment that no longer matches the code beneath it, or that asserts
  something the code doesn't actually do.
- Silent scope-narrowing: solving an easier subset of the request without
  saying so, or special-casing an input instead of fixing the real cause.
- Fabricated verification: a "tests pass" / "verified" claim with no
  corresponding tool call in this transcript that actually ran it.
- A new abstraction, retry loop, or config knob added "while at it" that
  nobody asked for.

Calibrate severity: `blocker` only when the primary agent is about to hand
off work it hasn't actually finished; `concern` for a likely-but-unconfirmed
gap; `nit` for a comment/doc mismatch that doesn't block correctness. Don't
repeat what your project's own AGENTS.md/CLAUDE.md completeness contract
already covers — read it, then apply it.
