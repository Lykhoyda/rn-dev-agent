---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Make `device_fill` truthful: bind exactly one input (direct ref/testID or unique `${name}-pressable` wrapper mapping) before any mutation, resolve/focus/type in one exact native operation that never substitutes an ambient-focused field or blind-types app-wide, verify every attempt (JS, native, retype, Maestro, timeout recovery, `device_batch`) through a new required secret-free `verifyInput` read-back so `filled:true` always means a stable exact value, and hard-fail unverifiable outcomes as `NO_TEXT_INPUT_TARGET`/`TEXT_ENTRY_UNVERIFIED` with mutation dispositions instead of soft-accepting them.
