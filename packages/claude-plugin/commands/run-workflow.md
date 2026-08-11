---
command: run-workflow
description: Validate and establish the proven rn-dev-agent operating sequence before a real React Native journey — declared package manager and dependencies, read-only inventory, typed session recovery, one exclusive device, managed integration and Metro, only the requested proof, reverse-order cleanup.
argument-hint: [journey-description]
allowed-tools: Bash, Read, Grep, Glob, mcp__*cdp__*
---

Establish the proven operating sequence for this journey: $ARGUMENTS

Load the `rn-workflow` skill and execute its contract steps 0–7 in order, with
the journey description above as the scope for Step 5 ("run only the requested
proof"). If no description was given, ask for one before Step 5 — Steps 0–4
(validation and authority establishment) may proceed without it.

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
