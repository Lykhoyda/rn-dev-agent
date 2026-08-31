---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Recognize a modal-hosted testID as frontmost when its React return chain threads through the modal host fiber's alternate, instead of refusing it as behind the active modal.
