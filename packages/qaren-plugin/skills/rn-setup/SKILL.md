---
name: rn-setup
description: Use for QaReN runtime installation, app configuration, or diagnosing an unavailable runtime before QA.
---

# QaReN setup

For a source checkout, follow [Build](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#build). For an installed plugin,
follow [Plugin runtime installation](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#plugin-runtime-installation),
including verification and interrupted-install recovery.

Once the runtime is available, follow [Check a plan](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#check-a-plan)
for app configuration and preflight. Read the returned receipt before treating
setup as ready. Configuration validation is owned by
[`config.rs`](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/src/config.rs).

For iOS build compatibility, consult [CLI-owned iOS build routes](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#cli-owned-ios-build-routes).
For scenario-based Android or USB preparation, consult [Preparation verbs](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#preparation-verbs).
