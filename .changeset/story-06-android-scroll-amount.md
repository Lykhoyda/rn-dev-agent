---
'rn-dev-agent-plugin': patch
---

Nightly device-smoke Android lane: scroll the golden-set list at full amplitude (amount 1) so row 80 is reached within the 30-scroll budget. The earlier amount-0.5 guard (added for a local emulator's drag latency) fell ~5 rows short on CI, where all 30 drags run with zero RUNNER_TIMEOUT — the shorter drag bought nothing.
