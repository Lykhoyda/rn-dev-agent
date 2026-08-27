---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Delete the login prologue authority latch so `cdp_login_prologue` runs the exact `user-login` action and passes or fails like any other replay, and no tool is disabled because of the login result.
