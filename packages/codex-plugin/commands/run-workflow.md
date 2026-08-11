---
command: run-workflow
description: Validate and establish the proven rn-dev-agent operating sequence before a real React Native journey — declared package manager and dependencies, read-only inventory, typed session recovery, one exclusive device, managed integration and Metro, only the requested proof, reverse-order cleanup.
argument-hint: [journey-description]
---

Treat all text after `$rn-dev-agent:run-workflow` as one conceptual journey
description. Preserve spaces/punctuation; it is never shell input. Require the
active `cdp` MCP tools; when they are absent, stop for read-only discovery
diagnosis instead of improvising raw commands.

Load the package-local `rn-workflow` skill
(`skills/rn-workflow/SKILL.md`, resolved from this package root) and execute
its contract steps 0–7 in order, with the journey description as the scope for
Step 5 ("run only the requested proof"). If no description was given, ask for
one before Step 5 — Steps 0–4 (validation and authority establishment) may
proceed without it.

Ground rules the skill enforces (do not restate or reinterpret them here):

- `rn_session(action="status")` is the sole classifier for a blocked session;
  follow only its `recoveryRequirement.nextAction`, re-read status after every
  recovery action, and stop after one bounded retry on an identical projection.
- Action discovery is read-only; replay only via `cdp_run_action` after
  device, Metro, and runner authority are proven.
- Success is re-read from authoritative tool state, never exit codes or prose.
- Cleanup runs in reverse order and is verified by the postflight checker.

Report the outcome as a short table: one row per contract step with its
readback evidence, plus the single actionable stop if the journey could not
proceed.
