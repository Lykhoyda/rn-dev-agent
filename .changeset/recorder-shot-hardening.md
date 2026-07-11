---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Harden observe-recorder screenshot ingestion (GH #429): the recorder now only reads screenshot files the capture pipeline itself just wrote (single-use trust grants registered by `device_screenshot`), instead of any absolute image path named in a tool observation — closing an arbitrary local-file read surface on the observe server. The read itself is now TOCTOU-safe: one descriptor for the size check and the read, `O_NOFOLLOW` (no symlink following), and a hard byte cap enforced on the bytes actually read.
