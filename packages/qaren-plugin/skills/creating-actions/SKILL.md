---
name: creating-actions
description: Use when a QA walk should become a saved block, an existing block should replay, or saved-block replay or persistence fails.
---

# Saved blocks

Before creating a flow, inspect the existing actions using the inventory commands
in [Saved blocks](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#saved-blocks). That section owns block format,
identity selection, replay, re-walk limits, persistence, and privacy withholding.
Follow it when designing a Markdown plan or diagnosing a saved-block failure.

For login recovery, read [Step recovery](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#step-recovery).
For branch writeback, read [Test a pull request](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#test-a-pull-request).
The [replay dialect](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/apps/docs-site/src/content/docs/actions/rn-flow-1.md)
owns the compiler and library interpreter contract; it is distinct from plan-block replay.
