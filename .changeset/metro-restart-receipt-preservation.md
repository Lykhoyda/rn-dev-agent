---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Preserve the signed install receipt's buildGeneration across an authenticated managed-Metro restart when the installed artifact re-proves byte-identical on-device, so `rn_session pin_dev_client force=true` recovers coherent authority without a ceremonial full rebuild while changed, missing, foreign, stale, or unattestable installs still fall back to the bumped generation and refuse fail-closed.
