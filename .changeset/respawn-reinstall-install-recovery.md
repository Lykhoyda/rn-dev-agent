---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Recover the session after a plugin-initiated byte-identical reinstall (for example a runner-respawn recovery) by retrying a refused install-identity preflight once behind the existing artifact-digest proof, except while a strict proof run is bound where the reinstall stays a hard stop and status projects the new install_identity_reissue_blocked state naming proof_capture discard as the way out, so rn_session status and cdp_status always report a truthful installIdentity verdict instead of claiming ready while gated tools refuse.
