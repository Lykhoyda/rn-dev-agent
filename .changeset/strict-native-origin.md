---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Separate exact native device control from managed source-origin evidence. Raw snapshot, screenshot, press, fill, batch, and equivalent runner operations now use exact controller/source/install/device/runner authority, explicitly report `originAuthority`, and keep origin-unproven captures out of strict proof, cross-platform verdicts, and learned-action evidence.
