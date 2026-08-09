---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Recover the session after a plugin-initiated byte-identical reinstall (for example a runner-respawn recovery) by retrying a refused install-identity preflight once behind the existing artifact-digest proof, and make rn_session status and cdp_status report a truthful installIdentity verdict instead of claiming ready while gated tools refuse a foreign or unattestable artifact.
