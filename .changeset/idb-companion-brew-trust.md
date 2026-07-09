---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Fix idb-companion installation on current Homebrew: brew now refuses formulas from untrusted taps, so `brew tap facebook/fb && brew install idb-companion` fails with "Refusing to load formula … from untrusted tap" — the plugin's auto-installers (`ensure-idb.sh`, `ensure-idb-companion.sh`) silently failed every session while pipx still installed the (Python-3.14-broken) client, leaving the worst combination: broken client on PATH, no companion (B269). The install commands now run `brew trust facebook/fb` first (tolerant no-op on older Homebrew without the `trust` subcommand), and all ~10 user-facing hint surfaces (doctor, rn-setup skill, mirror hints in `sources.ts`, SessionStart warning, physical-device probe) show the trusted three-step command.
