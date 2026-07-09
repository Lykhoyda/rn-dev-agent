---
command: rn-feature-dev
description: Guided feature development for React Native — explore codebase, design architecture, implement, verify live on device, and review quality.
argument-hint: [feature-description]
---

# React Native Feature Development

Initial request: $ARGUMENTS

Invoke the **`rn-feature-development`** skill and execute the full 8-phase pipeline
against the user's feature request above.

The skill contains the complete process:
- Phase 1 (Discovery) through Phase 8 (E2E Proof)
- Core principles, safety constraints, and recovery procedures
- Common Rationalizations, Red Flags, Boundaries, Verification gates

Do not improvise the process. Follow every phase in the skill. Create a todo
list at Phase 1 with all 9 phases (1, 2, 3, 4, 5, 5.5, 6, 7, 8) and mark each
complete as you progress.

**Critical reminders:**
- NEVER skip phases — speed comes from parallel agents, not phase elimination
- Gate Phase 5 on explicit user approval of the architecture (from Phase 4)
- Phase 5.5 verification table MUST have concrete Evidence in every row
- Phase 8 executes the architect's E2E Proof Flow mechanically, step by step
