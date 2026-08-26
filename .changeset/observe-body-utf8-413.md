---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Fix Observe HTTP request-body handling by preserving multi-byte UTF-8 code points split across TCP chunks and draining oversized bodies while returning parseable JSON 413 responses over usable keep-alive connections.
