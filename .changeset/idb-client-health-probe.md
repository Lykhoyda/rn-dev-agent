---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

B269 (remaining half): treat idb client health, not PATH presence, as the source of truth. fb-idb installed under an incompatible Python (e.g. 3.14) crashes on every invocation; previously it counted as "present" everywhere, so the auto-installer never repaired it and the observe mirror selected the doomed idb tier and died ("idb video-stream keeps exiting", B263) instead of using the working simctl fallback.

- `detectIdb()` (mirror tier selection) now probes a real `idb --help` invocation — ENOENT, a crash, or a hang all resolve to the simctl tier.
- `ensure-idb.sh`'s foreground check health-probes the client and flags a present-but-broken one; the background worker replaces it (uninstall → reinstall → re-probe) and, if the reinstalled client still crashes, **uninstalls it and marks the attempt failed** — a crash-on-invocation client is never left on PATH, and the 24h backoff retries when a fixed fb-idb release ships.
- `/doctor`'s idb row now scores the client by the health probe instead of PATH presence.
