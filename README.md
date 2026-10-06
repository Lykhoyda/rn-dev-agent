# QaReN

QaReN checks Markdown QA plans against a running React Native app, replays saved
blocks, and records evidence with a PASS, FAIL or typed refusal. This checkout
is developing 2.0.0, with no backward compatibility with rn-dev-agent 1.x.

```text
Markdown plan ──► prepare app + Metro ──► walk or replay ──► evidence + cleanup
```

## Get started

Build from source using the [CLI build guide](packages/qaren-cli/README.md#build),
then follow [Check a plan](packages/qaren-cli/README.md#check-a-plan) to configure
an app and run its plan. That guide owns configuration, supported platforms,
plan grammar, privacy rules and refusal behavior.

- [Saved blocks and action inspection](packages/qaren-cli/README.md#saved-blocks)
- [Pull request runs and publication](packages/qaren-cli/README.md#test-a-pull-request)
- [Plugin runtime installation](packages/qaren-cli/README.md#plugin-runtime-installation)
- [Scenario-based preparation](packages/qaren-cli/README.md#preparation-verbs)

For contribution mechanics, package ownership and the required independent QA
and merge gates, read the [repository guide](AGENTS.md).

## Published rn-dev-agent 1.x

The [published documentation](https://lykhoyda.github.io/rn-dev-agent/)
retains the 1.x installation, MCP tools, host workflows and onboarding guides.
Those instructions do not apply to this QaReN checkout. See
[GitHub Releases](https://github.com/Lykhoyda/rn-dev-agent/releases) for release history.

[Report a bug](https://github.com/Lykhoyda/rn-dev-agent/issues/new) · [MIT license](LICENSE)
