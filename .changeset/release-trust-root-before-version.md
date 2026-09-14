---
'rn-dev-agent-plugin': patch
---

Publish each release's runner zips and bundled runner trust root before the Version Packages merge advertises the plugin version, so a fresh install never verifies against a stale runner-manifest.json.
