# Architecture Decision Records

Non-obvious architectural decisions for agent-flywheel — read the relevant
one before reversing a decision that looks arbitrary; it likely isn't.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-detached-background-spawn.md) | Detached background spawn for reflection, not a blocking in-session call | accepted | 2026-08-26 |
| [0002](0002-reimplement-not-bundle.md) | Reimplement a self-contained fallback, don't bundle third-party memory/skill tools | accepted | 2026-08-26 |
| [0003](0003-flat-file-memory-store.md) | Flat append-only text files for MEMORY/GUARDRAILS/LEVEL/LEARN, not a database | accepted | 2026-08-26 |
| [0004](0004-codex-copilot-manual-wiring.md) | Codex CLI and GitHub Copilot CLI adapters ship manual-wiring-only, not auto-wired | accepted | 2026-08-26 |
