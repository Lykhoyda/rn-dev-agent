---
"rn-dev-agent-plugin": patch
---

On Python 3.14 with an installed-but-crashing fb-idb, ensure-idb reports the interpreter incompatibility and recommends reinstalling fb-idb under Python 3.13, and stops retrying once the incompatible-Python verdict is reached.
