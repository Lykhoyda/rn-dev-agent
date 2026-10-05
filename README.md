# QaReN

QaReN checks Markdown QA plans against a running React Native app, replays
saved blocks, and retains evidence tied to the tested candidate. The Rust CLI
owns the run, device lease, app preparation and cleanup; its TypeScript child
reads the screen and walks the plan.

```text
Markdown plan -> preflight -> leased iOS simulator -> walk or replay
                                                   -> evidence -> cleanup
```

This checkout develops QaReN 2.0.0. It has no backward compatibility with
rn-dev-agent 1.x and is not yet a completed release.

## Get started

The [CLI guide](packages/qaren-cli/README.md) owns build instructions,
configuration, plan grammar and runtime installation. Start with
[Check a plan](packages/qaren-cli/README.md#check-a-plan) to test the current app
worktree, then [Saved blocks](packages/qaren-cli/README.md#saved-blocks) for
replay and [Test a pull request](packages/qaren-cli/README.md#test-a-pull-request)
for testing an immutable PR head and publishing eligible reviewer evidence.

Plan-based checks and PR runs currently support iOS simulators. The CLI guide
also documents the separate scenario-based preparation experiments.

## Safety and evidence

Use local development apps you control, never production or store-signed apps
holding real user data. Review plans and treat retained run evidence as private.
The [capture and masking contract](packages/qaren-cli/README.md#input-value-masking)
and [publication contract](packages/qaren-cli/README.md#test-a-pull-request)
describe evidence protection and publication eligibility; redaction alone does
not authorize publishing company material.

## Development and release

Read the [repository guide](AGENTS.md) for package ownership, contribution
mechanics, validation and release rules. Hermetic tests and green CI do not
establish exact-head device acceptance; the release gate is owned by
[Branches, CI And Release](AGENTS.md#branches-ci-and-release).

## Published rn-dev-agent 1.x

The [published documentation](https://lykhoyda.github.io/rn-dev-agent/)
contains the historical MCP product's installation, host workflows,
troubleshooting, security guidance and benchmarks. Those instructions do not
apply to this QaReN checkout. The docs site and retained plugin skills await
their QaReN rewrite; use the CLI guide above for current behavior.

[Releases](https://github.com/Lykhoyda/rn-dev-agent/releases) ·
[Report a bug](https://github.com/Lykhoyda/rn-dev-agent/issues/new) ·
[MIT license](LICENSE)
