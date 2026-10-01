# Lykhoyda/rn-dev-agent security

This repository contains the in-development **QaReN** CLI and its TypeScript
screen core, native runners and host package. The latest release on `main`
remains the rn-dev-agent 1.x MCP plugin. Both run locally on the operator's
machine; this is not a hosted SaaS or a generic Node library.

See the [product introduction](README.md) for this checkout and the
[CLI guide](packages/qaren-cli/README.md) for its supported run paths.

## Report scope

**In scope:** vulnerabilities in the CLI, screen core, host package, packaged native runners and local Observe UI in this repository, including the released 1.x plugin.

**Out of scope:** a cloud backend (this repo has none) and operator-driven use of these local tools against an app the operator chose. Operator limits for runtime introspection are in [README Security](README.md#security).

## Support

Security updates ship only on the latest 1.0.x plugin/core version advertised on `main`. Published-but-not-advertised GitHub tags, earlier 1.0.x, and all 0.x are unsupported.

## Reporting

Submit with GitHub [private vulnerability reporting](https://github.com/Lykhoyda/rn-dev-agent/security/advisories/new) only. Do not open a public issue.
