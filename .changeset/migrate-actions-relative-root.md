---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

`maestro-runner-pin migrate-actions` and `diagnose-actions` now resolve a relative `--root` against the current directory, so `--root test-app` no longer refuses every action with "does not resolve to".
