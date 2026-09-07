---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Let managed Metro resolve a `fingerprint` runtime version by admitting the canonical `expo-updates` CLI and the verified developer `git` in the Darwin sandbox profile and admitting `@expo/fingerprint`'s exact `git` probes in the Node spawn gate, so Expo dev-client manifests stop failing with `spawn EPERM` and Metro no longer stalls in `METRO_START_UNAVAILABLE`.
