# Live proof — PR #788 (issue #525 recovery, supersedes PR #785)

- **Date:** 2026-08-17
- **PR head (exact):** `ac19be1936dfe0d0be361002ab73485dbd9ef55a` (branch `fm/issue-525-pr785-recovery`, clean worktree)
- **Runtime under test:** the PR head's own shipped host bundle
  `packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js`, driven over stdio
  MCP (JSON-RPC) — every `rn_session`/`cdp_*`/`device_*` call in the transcript
  ran inside that exact-head build.
- **Device:** dedicated local-Mac rn-qa simulator `rn-qa-525-recovery-iPhone17Pro`
  (iPhone 17 Pro, iOS 26.4, UDID C776CB69-141E-414A-937E-8E811DABB939), created
  for this run. The shared USB phone was never touched.
- **App:** `rn-dev-agent-workspace/test-app` (`com.rndevagent.testapp`), managed
  build via the integrated `pnpm run ios` launcher, managed Metro on the
  session's port 8252, bundle handshake bound (`state: ready`), runner bound
  with `originAuthority: proven`.

## Flow (video: `flow-ios-labeled.mp4`, ~49s)

| Step | Screenshot | Action (exact-head tool call) | Verification |
|---|---|---|---|
| 1 | `01-tasks-start.png` | start state | `cdp_component_state task-sort-label` → `Sort: Default` |
| 2 | `02-after-walkup-priority.png` | `cdp_interact {action:"press", testID:"task-sort-label", walkUp:true}` | result `walkedUpFrom:"CssInterop.Text", walkUpLevels:4`; label → `Sort: Priority`; list re-sorted High→Low on camera |
| 3 | `03-after-walkup-default.png` | same walkUp press again | label → `Sort: Default` (start state restored) |
| 4 | `04-after-reload-recovered.png` | `cdp_reload` | `reloaded:true, reconnected:true`; nav state resolves normally after remount |

Device-bound evidence: all four screenshots, the video, and every `cdp_*`
result above (native iOS simulator, live Hermes runtime).

## Key exact-head evidence (transcript-excerpts.txt)

- **Legacy default preserved** (call 32): press WITHOUT `walkUp` on the
  non-pressable `task-sort-label` still refuses with
  `Interact failed: Component has no onPress handler`.
- **walkUp live** (calls 33/112/115): `walkUpLevels: 4` through the NativeWind
  `CssInterop.Text` wrapper to the parent `Pressable` — the accepted GH #525
  behavior at the recovered head.
- **Review finding r3798017292 proven live** (calls 40/41, evaluated in the
  app's real Hermes/Metro runtime):
  - `require('@react-navigation/native')` → **`THROWS: Property 'require'
    doesn't exist`** — the PR #785 string-require detection path is
    structurally impossible in evaluated code.
  - Metro dev registry probe → **170 `@react-navigation` modules of 5481
    total**, verboseNames of the pnpm form
    `node_modules/.pnpm/.../node_modules/@react-navigation/native/...` — the
    registry evidence this PR's `navDetectBundledFramework()` reads, matched by
    its `node_modules/@react-navigation/` substring check, well inside the
    20 000-module scan bound.

## Deviations (stated per Verification Discipline)

- **Maestro inexpressibility:** the feature under proof is `cdp_interact`'s
  JS-handler `walkUp` ancestor walk. A Maestro `tapOn` routes through the
  native responder chain (the parent Pressable absorbs the tap), so no Maestro
  primitive can exercise the walk. Per the capturing-proof carve-out, the
  on-camera artifact is the rehearsed `cdp_*` replay (rehearsed clean off
  camera first; the on-camera take repeats exactly those calls). Additionally,
  the plugin's own blind probe marks the Maestro engine `at-risk: ios26` on
  this runtime.
- **Mid-mount live window not on camera:** through the exact-head fenced tools,
  `cdp_reload`/`cdp_restart` block until reconnection and the warm dev-client
  remounts in under ~1.5s, so no fenced `cdp_navigation_state` call can land
  mid-mount (the serialized session fence refuses concurrent calls —
  `OPERATION_ALREADY_IN_PROGRESS`). The mid-mount guidance branches are instead
  proven by (a) the live runtime-evidence probes above (old path impossible,
  new evidence present), and (b) the 12-case sandbox suite in
  `gh-525-nav-state-mounting.test.ts` that replicates the exact runtime
  semantics (no string `require`, `__r.getModules()` registry) and fails on
  PR #785's head `d91e3d88`.
- **Learned-actions M7 rendering** (finding r3798017301) is device-free
  behavior, covered by the `gh-525-learned-actions-meta.test.ts` regressions at
  this head (mixed valid/malformed `produces` → `?`, empty `{}` → `-`); not a
  device artifact.

## Session authority chain

Transcript excerpts carry per-call `authorityReceipt`s (session
`b48d3f7e-114…`, axes C/S/I/M/B/D/R) issued by the exact-head supervisor;
`device_snapshot action=open` reported `originAuthority: proven`.
