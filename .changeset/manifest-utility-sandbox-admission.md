---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Admit the canonical `expo-updates` runtime-version CLI and the verified developer `git` it shells out to in the Darwin managed-Metro sandbox profile, so Expo dev-client manifests under a `fingerprint` runtime-version policy stop failing with `spawn EPERM`.
