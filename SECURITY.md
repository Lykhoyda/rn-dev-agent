# Lykhoyda/rn-dev-agent security

This checkout develops **QaReN**, a local React Native / Expo QA CLI with a
TypeScript screen child, host plugin, and packaged native runners. Build and
installation instructions live in the [CLI guide](packages/qaren-cli/README.md).
It is not a hosted SaaS and not a generic Node library.

## Local development limits

Run only against trusted development apps, never production builds, store-signed
apps, or apps holding real user data. Runtime introspection through CDP has access
to the component tree, store state, persistent storage and in-memory secrets;
it is not a sandbox. Treat the agent as a developer with shell access and trust
its prompts accordingly. The CLI's run and device ownership checks bind the
intended app and Metro; ambient discovery does not grant authority.

For company evidence and publication limits, follow the
[publication contract](packages/qaren-cli/README.md#test-a-pull-request).

## Report scope

**In scope:** vulnerabilities in the CLI, `qaren-core`, the host plugin, packaged
native runners, and local Observe UI as shipped from this repo.

**Out of scope:** a cloud backend (this repo has none) and operator-driven use of these local tools against an app the operator chose. Operator limits are described above.

## Support

Security updates ship only on the latest 1.0.x plugin/core version advertised on `main`. Published-but-not-advertised GitHub tags, earlier 1.0.x, and all 0.x are unsupported.

## Reporting

Submit with GitHub [private vulnerability reporting](https://github.com/Lykhoyda/rn-dev-agent/security/advisories/new) only. Do not open a public issue.
