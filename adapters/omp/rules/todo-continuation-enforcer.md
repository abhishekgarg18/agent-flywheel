---
description: Blocks premature completion claims while a todo item, named acceptance criterion, or stub is still unresolved. Ported from oh-my-opencode's "Todo Continuation Enforcer" as a native TTSR (zero cost until the phrase actually appears).
condition: '(?i)\b(task is (?:now |fully )?(?:complete|done|finished)|all (?:tests|acceptance criteria) pass(?:ed)?|ready to (?:merge|ship)|everything (?:is )?working|nothing (?:left|more) to do)\b'
scope: text
interruptMode: prose-only
---
Before this completion claim goes out: are every todo item marked done (not just abandoned in `in_progress`), every acceptance criterion named earlier in this conversation satisfied, and no stub/TODO/placeholder/mock left in a changed file? If any of those isn't true yet, say so explicitly and keep working — don't let the claim stand uncorrected.
