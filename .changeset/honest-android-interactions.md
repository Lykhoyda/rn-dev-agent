---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Scope Android element matching to the owned app by default, actuate exact accessibility targets without trusting snapshot coordinates, and fail Android taps whose effect cannot be proven (including when `retryIfNoChange: false` or `RN_SELF_HEAL=0` skips the retry).
