---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Fix Observe HTTP request-body handling (GH #818): decode bodies with a streaming StringDecoder so a multi-byte UTF-8 code point split across TCP chunks survives intact instead of becoming replacement characters, and stop destroying the request socket when the 64 KiB byte limit is exceeded — oversized bodies are now drained to completion so callers receive the parseable JSON 413 over a usable keep-alive connection without the action/run handlers being invoked. Adds raw-socket regressions for both affected e2e endpoints.
