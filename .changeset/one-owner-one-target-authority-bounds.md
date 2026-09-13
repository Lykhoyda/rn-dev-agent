---
"rn-dev-agent-plugin": patch
---

Document the one-source-owner-per-copy and one-exact-device-target-per-session authority bounds in the workflow skill, with pointers from the CLAUDE.md template (GH #1026). A session holds one `(platform, deviceId, appId)` target at a time and replaces it after runner, proof, and any explicitly started Observe are released and no incompatible install receipt is bound. Authoritative cross-target `cross_platform_verify` is currently unsupported.
