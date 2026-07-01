---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(record): `device_record stop` no longer crashes on macOS with `adb_args[@]: unbound variable` (#374). In `record_proof.sh` the Android stop branch expanded an empty `adb_args` array unguarded (`"${adb_args[@]}"`); under `set -euo pipefail` on bash 3.2 (the macOS default `/bin/bash`) that is an unbound-variable error, aborting the stop before the pull/convert — so recording finalize (and, via a leftover Android `.pid`, even iOS stops) failed. All three expansions now use the `+`-default guard already present elsewhere in the file. Regression-guarded by a static invariant test (effective on bash 5.x CI) plus a behavioral reproduction gated to bash < 4.4.
