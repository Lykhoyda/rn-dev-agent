---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Regroup authority-profile bookkeeping around the four ownership groups (Session, Target, Runtime, Automation) with every tool's resolved facet set, live probes, and error codes unchanged, and verify profile exhaustiveness at worker startup so an unprofiled registered tool fails at boot instead of at first call.
