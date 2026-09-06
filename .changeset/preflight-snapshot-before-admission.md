---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Deliver the attested command snapshot to the managed-Metro sandbox preflight shim before signaling admission, so a shell-shim command no longer intermittently sources an empty snapshot and degrades enforcement to reported-v1.
