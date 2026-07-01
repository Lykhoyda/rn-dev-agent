# Epic: Maestro-parity reliability, performance & differentiation

**Status:** Proposed (2026-07-02)
**Source:** Comparative deep-dive of `github.com/mobile-dev-inc/maestro` (local checkout: `/Users/anton_personal/GitHub/Maestro`) vs this plugin — four structured code-level reports (iOS driver stack, core/Android orchestration, MCP server design, rn-dev-agent architecture map), synthesized 2026-07-01/02.

## Thesis

Maestro's reliability comes from a small number of composable mechanisms: bypass XCTest quiescence and own the settle logic, latch transport death separately from app errors, re-resolve elements live before every tap, compact everything sent to the LLM, and ship prebuilt runner artifacts so the driver never builds on a user machine. rn-dev-agent's differentiation — the CDP/JS white-box layer and the learned-actions lifecycle — sits *on top of* that reliability layer, so adopting Maestro's mechanics strengthens the moat rather than diluting it.

## Stories

| # | Story | Impact | Effort | Depends on |
|---|-------|--------|--------|-----------|
| [01](01-prebuilt-runner-artifacts.md) | Prebuilt runner artifacts (kill the 6-min cold build) | First-run UX, CI enabler | M | — |
| [02](02-runner-protocol-versioning.md) | Version the runner wire protocol + relocate `/tmp` state | Bug-class prevention | S | — |
| [03](03-quiescence-bypass.md) | Quiescence bypass in rn-fast-runner | Flake-class elimination (Reanimated/animations) | M | — |
| [04](04-settle-engine.md) | Shared two-tier settle engine + capability flags | Replace fixed sleeps with invariants | M | 02 |
| [05](05-self-healing-taps.md) | Self-healing taps: inline re-resolution + retry-if-no-change | Fewer STALE_REF round-trips | M | 04 |
| [06](06-native-runner-ci-and-evals.md) | Native runner tests in CI + LLM-behavior evals | Coverage for the riskiest layer | M | 01 (Phase B) |
| [07](07-native-first-replay.md) | Native-first action replay (Maestro YAML as interchange) | Unblocks iOS 26; removes WDA from critical path | L | 04, 05 |
| [08](08-token-efficient-outputs.md) | Compact snapshot format + screenshot downscaling | Token/latency win every session | M | — |
| [09](09-android-parity-shared-core.md) | Android runner parity + shared client core | Symmetry, dedup, port-contention fix | M | 02 |
| [10](10-text-input-reliability.md) | Text-input reliability recipes (both platforms) | Kills the worst remaining flake source | M | 04 |
| [11](11-failure-evidence-and-debt.md) | Failure evidence, structured refusal reasons, agent-device debt | Repair quality + maintainability | S–M | — |
| [12](12-tool-surface-consolidation.md) | MCP tool-surface consolidation + instructions budget | Agent ergonomics at 74 tools | L | 06 (Phase C) |

## Suggested sequencing

```
Wave 1 (independent, start anytime):  01, 02, 03, 08, 11
Wave 2 (builds on wave 1):            04 (needs 02 capabilities), 06 (needs 01), 09 (needs 02)
Wave 3:                               05 (needs 04), 10 (needs 04)
Wave 4 (the strategic ones):          07 (needs 04+05), 12 (needs 06 Phase C evals as the safety gate)
```

## Key Maestro references (for all stories)

- iOS runner: `maestro-ios-xctest-runner/` (FlyingFox HTTP server inside an XCTest that never returns; FBQuiescence/WebDriverAgent-lineage swizzles)
- Transport/lifecycle: `maestro-ios-driver/.../XCTestDriverClient.kt` (transport-death latch), `maestro-client/.../android/AdbSocketFactory.kt` (gRPC-over-adb), `AndroidDeviceConnection.kt` (4-way death taxonomy)
- Settle/flake logic: `maestro-client/.../Maestro.kt` (composed tap, hierarchy/screenshot settle), `maestro/utils/ScreenshotUtils.kt`
- Flow engine: `maestro-orchestra/.../Orchestra.kt` (timeouts, retry levels, evidence-in-exception)
- MCP: `maestro-cli/src/main/java/maestro/cli/mcp/` (8-tool surface, compact hierarchy JSON, 2KB instructions test, ViewerHint first-result injection)
