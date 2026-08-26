---
description: Flags stub/placeholder markers introduced by edit or write so they don't ship silently. Ported from oh-my-opencode's "Comment Checker" as a native TTSR scoped to edit/write tool streams.
condition: '(?i)\b(TODO|FIXME|XXX|not\s*implemented|placeholder|stub implementation)\b'
scope: "tool:edit(**), tool:write(**)"
interruptMode: tool-only
---
A stub/placeholder marker (TODO, FIXME, "not implemented", etc.) was just written to a file. Is this an explicitly agreed-upon deferred follow-up the user scoped out, or does it silently ship incomplete work? An unexplained stub is prohibited by default — finish the real implementation now unless the user explicitly approved deferring this piece.
