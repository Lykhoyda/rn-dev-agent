---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Golden wire-contract tests from captured runner payloads + named CI gate (#437, audit P0-B).

The biggest escaped-bug cluster (#396, #353, #418) was host↔runner wire-contract
drift where hand-written fixtures encoded the wrong shape, so green tests
certified broken behavior. This closes that hole:

- `test/contract/capture-goldens.ts` records REAL `/health`, raw
  `POST /command snapshot`, error-envelope, and bridge `device_snapshot`
  payloads from live rn-fast-runner / rn-android-runner sessions into committed
  fixtures under `test/fixtures/goldens/<platform>/`, each stamped with capture
  provenance (device, OS, runner version, date). Goldens are captured, never
  hand-written.
- `gh-437-golden-contract.test.ts` pins the TS parsing layer
  (`classifyRunnerCompatibility`, `findRefByTestID`, the ref-map oracle +
  snapshot verdict) against those captured payloads for both platforms, and
  pins the captured `v` stamp to `RUNNER_PROTOCOL_VERSION` — a protocol bump
  fails CI until goldens are re-captured against the new runner (refresh
  cadence, enforced).
- New named CI step "Runner wire-contract gate" runs the #418 tri-surface
  command-enum sync, the #383 protocol-version sync, and the golden contract
  tests via `yarn workspace rn-dev-agent-core test:contract`, so wire-contract
  drift fails a visible gate instead of hiding in the unit blob.
