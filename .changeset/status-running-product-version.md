---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

`rn_session` status and `cdp_status` now report the running product on the envelope: `product.coreVersion` is the core package the live session process loaded, and `product.pluginVersion` is included when the host plugin manifest differs (GH #1025).
