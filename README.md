# QaReN

Plan-based QA for local React Native and Expo apps. QaReN uses a Rust CLI to
own the run, device lease, app preparation and Metro, with a TypeScript child
to read the screen and walk a Markdown plan. Jev resolves phrase targets and
semantic checks from observed evidence; incomplete or ambiguous evidence can
refuse a run rather than authorize a guessed action.

This branch is the in-development 2.0.0 migration. It is not an installable
replacement for the published rn-dev-agent 1.x MCP plugin yet. For the released
plugin, use the [1.x introduction and installation guide](https://github.com/Lykhoyda/rn-dev-agent/blob/main/README.md).
The retained host skills and most of the docs site still describe that release;
they do not describe the command surface available in this checkout.

## Build from source

From this repository root, with Node.js 24, Corepack and a Rust toolchain available:

```sh
corepack yarn install --immutable
corepack yarn build:core
cargo build --manifest-path packages/qaren-cli/Cargo.toml --locked
```

The binary is `packages/qaren-cli/target/debug/qaren`. The
[CLI guide](packages/qaren-cli/README.md) owns runtime configuration, prerequisites,
platform limits and preparation details.

## Check an app

Run the built binary from your app worktree, with `.qaren/config.yaml` and a
Markdown QA plan configured as described in the [check guide](packages/qaren-cli/README.md#check-a-plan):

```sh
/path/to/qaren check --plan-file plan.md --device <simulator-UUID> --json
```

```text
Markdown plan -> preflight -> leased app + Metro -> observed screen walk
              -> ledger + report -> owned-resource teardown -> receipt
```

Use the CLI guide for [presence and privacy limits](packages/qaren-cli/README.md#check-a-plan),
[iOS admission and retained-run recovery](packages/qaren-cli/README.md#ios-admission-and-cleanup),
and [scenario-based preparation](packages/qaren-cli/README.md#preparation-verbs).
Saved-action compilation has its own [rn-flow/1 contract](apps/docs-site/src/content/docs/actions/rn-flow-1.md);
a replay CLI command is not available yet.

## Security

Use local development apps with test data only. Do not target production or
store-signed apps, or apps holding real user data. Runtime introspection can
access component state, stores and in-memory secrets; trust the agent's prompts
as you would a developer with shell access. Privacy masking does not sandbox
runtime access. See [the security policy](SECURITY.md) for support and private
vulnerability reporting.

## Contributing

[AGENTS.md](AGENTS.md) owns the repository map, editing rules, validation commands
and release mechanics. [GitHub Issues](https://github.com/Lykhoyda/rn-dev-agent/issues)
tracks bugs. The project is [MIT licensed](LICENSE); the iOS runner retains its
[import attribution](packages/rn-fast-runner/IMPORT_NOTES.md).
