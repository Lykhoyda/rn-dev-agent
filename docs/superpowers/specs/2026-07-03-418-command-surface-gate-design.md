# #418 — Typed UNSUPPORTED_COMMAND + command-surface gate (B235)

**Date:** 2026-07-03
**Issue:** [#418](https://github.com/Lykhoyda/rn-dev-agent/issues/418) · Bug: workspace B235
**Depends on:** #383 (protocol gate, shipped), #384/PR #406 (dynamic /health capabilities, shipped)

## Problem

A prebuilt runner artifact that predates a command-enum addition passes the #383
health gate — protocol versions bump on wire-shape changes, not enum additions —
and then rejects the newer verb at dispatch time. On iOS the failure is a raw
Swift decode error deep inside a batch:

```
dataCorrupted … Cannot initialize CommandType from invalid String value dismissKeyboard
```

Root cause of the gate blind spot: **neither existing health signal fingerprints
the build artifact's command surface.**

- `protocolVersion` tracks the wire shape (asserted by humans, bumped rarely).
- `runnerVersion` is injected at **spawn time** (`TEST_RUNNER_RN_PLUGIN_VERSION`
  env from the spawning bridge), so version-skew catches a runner spawned by an
  old bridge — but a reap+respawn "fixes" the skew while the same stale binary
  keeps running. It never sees the artifact.

Three concrete ways a stale artifact is admitted today:

1. Artifact built earlier in the **same release cycle**, before a new verb landed
   — same version string, missing command (the B235 scenario).
2. The documented manual pre-build (`xcodebuild build-for-testing`) doesn't
   inject `RN_PLUGIN_VERSION` → `runnerVersion` absent → skew check skipped
   (fail-open by design).
3. Unreadable plugin manifest → `pluginVersion` null → skew check disabled.

Android already returns a typed `UNSUPPORTED_COMMAND` error
(`CommandDispatcher.kt` `else` branch); its gate has the same blind spot
(`/health.capabilities` is always `[]`). iOS has neither the typed error nor the
enumeration.

## Design principle

Derive state from the artifact, don't assert it. `CommandType.allCases` is a
fact extracted from the compiled binary; enumerating it in `/health` gives the
gate a signal that cannot drift from the truth. (Same principle as #384's
dynamic capabilities.)

## Decisions (brainstorm 2026-07-03)

- **Scope: both platforms** in one increment (iOS typed error + enumeration;
  Android enumeration; shared gate).
- **Strict on absence + auto-invalidate at open**: a runner not advertising
  `commands` (every pre-fix artifact) is classified stale; remediation happens
  at `device_snapshot action=open` where cold builds are already accepted.
  Mid-flow tools never trigger a silent multi-minute build (#210 rule).
- **Approach: `/health.commands` enumeration** over `cmd:*` capability entries
  (display pollution, semantic collision with feature flags) and over a
  human-bumped `commandSetVersion` int (reintroduces the #383 drift failure
  mode; no missing-verb diagnostics).

## Design

### 1. Wire change (additive — no protocol bump)

`/health` on both runners gains a `commands: string[]` field alongside
`ok/protocolVersion/runnerVersion/capabilities`.

- **iOS** (`RnFastRunnerTests+Models.swift`, `+Transport.swift`):
  `CommandType` adopts `CaseIterable`; the health response includes
  `CommandType.allCases.map(\.rawValue)`. `Response` gains an optional
  `commands: [String]?` (nil-omitted, backwards-compatible).
- **Android** (`CommandServer.kt`, `CommandDispatcher.kt`): a
  `SUPPORTED_COMMANDS` list declared adjacent to the dispatcher's `when`,
  emitted from `/health`.
- **Sync test**: extend the `gh-383-protocol-sync.test.js` source-parsing
  pattern — one Node test asserts (a) Kotlin `SUPPORTED_COMMANDS` ==
  the dispatcher's `when` labels, (b) Swift `CommandType` cases ⊇
  `REQUIRED_IOS_COMMANDS`, (c) Kotlin list ⊇ `REQUIRED_ANDROID_COMMANDS`.

`capabilities` keeps its current meaning (feature flags like
`QUIESCENCE_BYPASS`); commands do NOT go there.

### 2. Gate (TS — `scripts/cdp-bridge/src/runners/protocol.ts`)

- New per-platform constants: `REQUIRED_IOS_COMMANDS` /
  `REQUIRED_ANDROID_COMMANDS` — exactly the verbs each client dispatches.
  Tied to the existing client command union types via `satisfies` so adding a
  verb to the union without updating the list is a compile error.
- `classifyRunnerCompatibility` gains an optional commands input and a new
  `RunnerIncompatibilityReason: 'missing-commands'`; the result carries
  `missing: string[]` (for absence, `missing` = the full required list).
- **Strict on absence**: `commands === undefined` → `missing-commands`.
- Check order: legacy → protocol-older/newer → version-skew →
  missing-commands (most fundamental mismatch wins).
- Both platform probes (`defaultHttpProbe` in `rn-fast-runner-client.ts`,
  the Android info fetch in `rn-android-runner-client.ts`) parse `commands`;
  liveness detail gains `commands?: string[]` and the new stale reason flows
  through existing plumbing.

### 3. Remediation — two tiers

`missing-commands` joins `PROTOCOL_STALE_REASONS` (reap + respawn + re-verify),
but because respawn reuses the same binary, artifact staleness needs its own
tier:

- **At `device_snapshot action=open`**: when the probe (before or after
  respawn) classifies `missing-commands`, invalidate the artifact —
  iOS: stop the runner and delete the **plugin-owned** DerivedData
  (`derivedDataPathForRunner()` only; never a user path), then let the
  existing self-build-on-first-use path cold-build; Android: force the #309
  self-install rebuild/reinstall. Result carries
  `meta.note: "runner artifact stale (missing commands: <list>) — rebuilt"`.
- **Mid-flow tools** (`device_find`/`press`/`fill` auto-spawn via
  `ensureRunnerForCommand`): if still `missing-commands` after the standard
  reap+respawn, return a structured error with new
  `ToolErrorCode: 'RUNNER_COMMANDS_STALE'` naming the missing verbs and
  pointing at `device_snapshot action=open` (which now self-heals). No silent
  cold build mid-flow, ever.

### 4. Typed error on iOS `/command` (defense-in-depth)

`handleRequestBody` pre-decodes `{command: String}`; if
`CommandType(rawValue:)` is nil it returns
`ok:false, error:{code:"UNSUPPORTED_COMMAND", message:"Unsupported iOS runner
command: <verb> — runner artifact predates it; re-open the device session
(device_snapshot action=open) to rebuild"}` — mirroring Android's existing
shape. `ErrorPayload` gains an optional `code` field if absent. Any other
decode failure keeps today's behavior.

TS `runIOS` maps `code === 'UNSUPPORTED_COMMAND'` to a clean `failResult`
with the same hint. **No auto-retry** — the gate owns the proactive path;
this branch only catches mid-session hot-swaps.

### 5. Observability

- `cdp_status.deviceSession.runnerProtocol` gains `missingCommands: string[]`
  when the runner is stale for this reason.
- `runnerCapabilities` display rule from #384 (omit empty; feature flags only)
  is unchanged.

## Testing

- **TS unit (hermetic, deps-injected)**: classify matrix (present / absent /
  subset-missing / ordering vs protocol+skew reasons); probe parsing of
  `commands` on both clients; `ensureRunnerForCommand` respawn note + terminal
  `RUNNER_COMMANDS_STALE`; open-path artifact invalidation (fake fs/build
  deps); `runIOS` mapping of `UNSUPPORTED_COMMAND`.
- **Tri-file sync test** extension (section 1).
- **Swift unit**: `CommandType.allCases` contains every dispatched verb
  (e.g. `keyboardDismiss`); unknown-verb request → typed
  `UNSUPPORTED_COMMAND` response.
- **Device verification**: temporarily add a fake verb to
  `REQUIRED_IOS_COMMANDS` in a local build → gate classifies live runner
  stale → open-path rebuild loop proven end-to-end on the simulator; Android
  equivalent with the emulator. Normal pass afterwards (no fake verb) proves
  zero-regression happy path.

## Non-goals

- No protocol version bump (the change is additive).
- No auto-retry after an `UNSUPPORTED_COMMAND` reply.
- No enumeration of `device_batch`-internal sub-verbs beyond what the clients
  already dispatch as `/command` verbs.
- No change to `capabilities` semantics.

## Risks / mitigations

- **Upgrade friction**: every existing DerivedData prebuild is classified
  stale once → one announced cold rebuild at next session open. Accepted in
  brainstorm (matches the #383 'legacy' precedent; the alternative leaves
  B235 unfixed for exactly those artifacts).
- **REQUIRED list under-maintenance**: a future verb added to the enum but not
  the REQUIRED list is fail-soft — the gate won't protect it, but the typed
  `UNSUPPORTED_COMMAND` error still names it. The `satisfies` tie to the
  client command unions plus the sync test make the miss unlikely.
- **DerivedData deletion safety**: deletion is scoped to
  `derivedDataPathForRunner()` (in-tree `scripts/rn-fast-runner/build/`),
  never a user-configurable path.
