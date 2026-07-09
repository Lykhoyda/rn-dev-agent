---
'rn-dev-agent-plugin': patch
---

Nightly device-smoke: retry the fixture launch (two ~30s attempts) instead of a single 20s deadline. A reused-but-cold CI simulator/emulator can take longer than one short window to foreground the fixture app; the old single 20s deadline occasionally tripped ("fixture did not start within 20s"). The re-launch is idempotent.
