---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Allow successful action replays to append runtime telemetry when only the tracked YAML mtime baseline is stale, while retaining sidecar CAS conflict detection and strict guards for every YAML-mutating promotion or repair.
