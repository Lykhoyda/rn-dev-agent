---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Allow the managed-Metro Darwin sandbox to look up the FSEvents service so Metro's native file watcher works on app-scale trees under enforcement instead of exhausting descriptors, without adding any executable, file, or network permission.
