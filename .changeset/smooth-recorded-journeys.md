---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Normalize native recordings to 30 fps H.264 at their captured resolution while preserving captured timing, stage the conversion inside the private runtime directory, refuse symlinked PR-body destinations, and embed proof screenshots and demo GIFs at 400px width in the generated PR body.
