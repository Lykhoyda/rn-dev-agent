---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Refuse a build with exit code 2 and the supported `restore_integration` repair command when package integration is installed but no live session owns the worktree, instead of silently re-running the project's raw build script and leaving an unmanaged bundler holding the foreground forever, and bound every stdio-capturing session-CLI wait in the generated adapter so a wedged CLI fails typed rather than reading as a truncated success. Projects integrated by an earlier version keep their on-disk adapter copy until integration is re-applied.
