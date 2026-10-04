# QaReN

QaReN checks Markdown QA plans against React Native development apps, replays
saved blocks, and persists passing walks. The Rust CLI owns the device lease,
app preparation, Metro, evidence, and cleanup; its TypeScript child reads and
walks the screen.

```text
Markdown plan ──► qaren check ──► screen walk ──► verdict + local evidence
                       │
                       └── saved blocks replay first; eligible passing blocks persist

Pull request ──► qaren pr ──► pinned candidate + recorded walk
                                      │
                                      └── qaren publish ──► review + eligible blocks
```

This checkout develops QaReN 2.0.0, with no backward compatibility with
rn-dev-agent 1.x. It is still in development; see the
[release and acceptance policy](AGENTS.md#branches-ci-and-release).

## Get started

Use the [CLI guide](packages/qaren-cli/README.md) for source builds and verified
runtime installation. From your app checkout, follow its
[plan and configuration instructions](packages/qaren-cli/README.md#check-a-plan).
The guide also owns the contracts for
[saved blocks](packages/qaren-cli/README.md#saved-blocks),
[pull-request testing and publication](packages/qaren-cli/README.md#test-a-pull-request),
and [scenario-based preparation](packages/qaren-cli/README.md#preparation-verbs).

## Security

Read the [local development and reporting policy](SECURITY.md) before running
against an app. The CLI guide owns
[input masking and capture limits](packages/qaren-cli/README.md#input-value-masking)
and [publication privacy limits](packages/qaren-cli/README.md#test-a-pull-request).

## Contributing

Read the [repository guide](AGENTS.md) for package ownership, contribution
checks, changesets, and release mechanics. Release history is in
[GitHub Releases](https://github.com/Lykhoyda/rn-dev-agent/releases) and the
[core changelog](packages/qaren-core/CHANGELOG.md).

The [published rn-dev-agent documentation](https://lykhoyda.github.io/rn-dev-agent/)
describes the 1.x plugin; its MCP commands and installation workflows do not
apply to this QaReN checkout.
