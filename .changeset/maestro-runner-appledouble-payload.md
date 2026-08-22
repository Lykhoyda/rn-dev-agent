---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Ignore AppleDouble, `._*`, and PaxHeader archive members when attesting the pin-cache payload so a checksum-matching maestro-runner 1.1.24 can spawn on Darwin extract layouts.
