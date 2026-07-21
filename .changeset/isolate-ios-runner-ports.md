---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Let each iOS XCTest runner request an OS-assigned listener port so parallel simulators cannot collide on port 22088, and make listener startup failures fail XCTest instead of producing a misleading passing result.
