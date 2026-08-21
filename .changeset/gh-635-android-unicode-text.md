---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Preserve arbitrary Unicode text in Android runner commands by declaring the JSON request body as UTF-8 before NanoHTTPD decodes it.
