---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Add `rn_session` action `bind_source` so linked git worktrees can rebind the session source root explicitly: the successor session mints on the declared same-repo worktree instead of the harness startup cwd, source-consuming actions accept a `projectRoot` fence that refuses divergent roots with the new typed `SOURCE_ROOT_DIVERGENCE` naming both paths, the release hint now names the root the successor will actually bind, install-artifact content reads get a 180s budget (was 30s) so hashing a large APK over a tunneled remote-farm adb transport no longer times out, and an autostarted Observe binding yields the device axis on the first `bind_device` (GH #776).
