---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

An explicitly present but empty M7 `# mutates:` or `# produces:` field is now treated as invalid (`?` / `metaInvalid`) instead of omitted (`-`), so inventory rendering matches the GH #525 present-vs-absent legend.
