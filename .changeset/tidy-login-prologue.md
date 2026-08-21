---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

The login prologue now requires the exact user-login action to produce a fresh passing RunRecord, terminally gates session mutations on failure, and records auditable replay timings and supervisor overrides.
