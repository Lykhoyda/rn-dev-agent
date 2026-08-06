---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Re-issue the install receipt after a Maestro `clearState` reinstall of the session's own artifact — proven by re-hashing the installed bytes against the bound artifact digest, with any other or unattestable artifact still refused as `APP_INSTALL_IDENTITY_CHANGED` — and accept an `appFile` on `cdp_run_action` that otherwise resolves from that same receipt.
