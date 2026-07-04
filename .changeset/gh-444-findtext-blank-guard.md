---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

rn-android-runner `findText` refuses missing/blank `text` with a typed
`INVALID_ARGUMENT` error (#444). Previously `optString("text")` silently
defaulted to `""`, falling through to `By.textContains("")` — which matches an
arbitrary node — so a malformed request reported `found: true` for whatever
element UIAutomator visited first instead of surfacing an argument error. The
guard runs in the dispatch when-branch before any selector is constructed;
a source-sync test (gh-418 style) enforces it in CI without an emulator.
