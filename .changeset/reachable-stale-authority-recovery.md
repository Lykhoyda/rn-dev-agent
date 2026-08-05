---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Stop a second supervisor for the same app root from misreading the live owner as a reused PID and stealing its single-instance lock, keep blocked contenders from opening operational children, rotate expired adoption handles so `status` never advertises a capability `adopt_stale` refuses, add a bounded capability-authenticated release for a proven-dead device or runner owner discovered after startup that transfers only the exact device cleanup obligations, and report whether recovery needs a transport restart, an attach, or an adoption.
