---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Fold the initial stale-device transfer into `bind_device` with `confirmed: true`: a proven-dead device owner is released inline through the same journaled cleanup engine with death re-proven from durable state and no capability token minted, an interrupted journal resumes token-lessly via a bare `bind_device` of the same target, and `release_stale_device` stays as a token-less compatibility alias that accepts `confirmed: true` (or a previously minted legacy handle) while live, unproven, split, foreign-worker, and mismatched-journal cases keep refusing without mutation.
