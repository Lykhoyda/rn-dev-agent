---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Require pin-cache maestro-runner `>= 1.1.24`, keep SHA256 attestation for the 1.1.24 artifact this package installs as the default known-good, accept learned-action `enginePin` values at that floor or newer, and refuse PATH, ambient Maestro CLI, older runners, and unattested binaries without a Maestro CLI fallback.
