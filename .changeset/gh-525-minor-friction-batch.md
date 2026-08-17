---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Make `cdp_navigation_state` report truthful mid-mount retry guidance instead of questioning the router install right after a reload, add an opt-in bounded `walkUp` pressable-ancestor press to `cdp_interact`, render learned-action metadata absence as `-`/`pre-M7` with `?` reserved for parse failures, and describe the Claude feedback-collector surface in the packaged sending-feedback skill.
