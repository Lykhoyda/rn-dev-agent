# Design — Dev Client picker: on-demand dismiss tool + targeted launch wiring (#136 sub-3)

- **Date:** 2026-05-31
- **Issue:** [#136](https://github.com/Lykhoyda/rn-dev-agent/issues/136) sub-issue 3 (parent is a 3-part combined-feedback issue)
- **Status:** Approved design, pending implementation plan
- **Approach:** B — Tool + targeted launch wiring
- **Author:** brainstorming session (Anton + Claude)

## 1. Background & current state

Issue #136 bundles three friction points. Ground truth as of this spec:

| Sub-issue | State | Evidence |
|---|---|---|
| 1 — `device_screenshot` wrong-platform routing | ✅ Shipped | PRs #142, #174 (tracked on #60) |
| 2 — `cdp_status` ~33.5 s hang on the Dev Client picker | ✅ Shipped | PR #187 (`closes #184`): `PickerBlockingBundleError` + status-scoped bounded `probeReactReachable` in `cdp/connect.ts`, mapped to a fast fail in `tools/status.ts` |
| **3 — no on-demand picker dismiss / no launch auto-handler** | ⬜ **This spec** | See below |

The Expo Dev Client "Development servers" picker is a native (expo-dev-menu) screen that appears after deep links, app restarts, permission changes, and `clearState`. It blocks the JS bundle until the user taps a Metro server entry. The picker-handling logic already exists internally:

- `tools/dev-client-picker.ts`: `handleDevClientPicker()`, `dismissPicker()`, `isDevClientPickerShowing()`, `parseFirstServerEntry()`, `waitForBundle()`. Detection is `runAgentDevice(['find', 'Development servers'])`; selection is `parseFirstServerEntry()` over a snapshot; the tap is `runAgentDevice(['find', target, 'click'])`.
- Internal callers: `tools/status.ts` (pre-connect + catch), `tools/device-reset-state.ts`, `tools/startup-replay.ts`, `utils.ts` (`withConnection`).

Two gaps remain (both explicitly **Deferred** in `docs-site/src/content/docs/dev-client-coverage.md`):

1. **No MCP-exposed picker-dismiss tool** — the logic is internal-only; an agent that hits a stuck picker mid-flow cannot dismiss it on demand. The coverage doc names the proposed tool `cdp_dismiss_dev_client_picker`.
2. **No launch auto-handler for the picker after a deep link** — `tools/device-deeplink.ts` has no picker handling, even though the module comment in `dev-client-picker.ts` lists deep links as a trigger. (`device_reset_state` and `startup-replay` already dismiss; `cdp_restart hardReset` is iOS-only and out of scope here.)

### The core constraint — the existing handler is Android-shaped

`handleDevClientPicker()` uses `runAgentDevice(['find', …])`. In `runAgentDevice`, the iOS short-circuit only fires for commands in `RN_FAST_RUNNER_COMMANDS`, and **`find` is deliberately not in that set** (it is a pure-TS orchestrator on both platforms now). So on iOS the handler falls through to the **legacy `agent-device` CLI/daemon**, which respawns the upstream `AgentDeviceRunner` — the runner the project is retiring (D1219) and which fights `rn-fast-runner` for focus. `hasActiveSession()` is platform-agnostic (`activeSession !== null`), so on an iOS session the handler *runs* but dispatches down the wrong path.

## 2. Decisions

1. **Keep the Android handler as-is.** `handleDevClientPicker()` / `dismissPicker()` / `parseFirstServerEntry()` are unchanged. (User decision: "wrap existing Android handler as-is.")
2. **Guard iOS.** The new code path detects iOS and returns an actionable "select the Metro server manually" message **without** calling `handleDevClientPicker()`, so it never respawns the legacy `AgentDeviceRunner`. (User decision: "guard iOS.")
3. **Tool name:** `cdp_dismiss_dev_client_picker` — matches the name already published in the coverage doc and sits in the `cdp_status` / dev-client connection family. (User decision.)
4. **Scope = Approach B:** the MCP tool + best-effort auto-dismiss in `device_deeplink` + one shared guarded helper, routed through a single tested path.
5. **iOS cross-platform re-path is out of scope** and tracked as a follow-up (see §9).

### 2.1 Implementation principles (carry into the plan)

- **Reuse, don't duplicate.** `handleDevClientPicker()` / `dismissPicker()` / `parseFirstServerEntry()` already exist and are tested — wrap them, never re-implement picker detection or server-entry parsing. The new code is only: one guarded helper, one tool handler, one `device_deeplink` call site.
- **Verify the gap before adding.** Before implementing, re-confirm there is no existing MCP tool or call site that already exposes on-demand dismissal (grep `dismiss`/`picker` across `src` + `index.ts`). This spec's audit found none, but the plan should re-check at implementation time.
- **Testable seams.** Route everything through `clearDevClientPickerIfPresent()` so the iOS guard and timing have a single test target; rely on the existing `_setRunAgentDeviceForTest` / `_setHasSessionForTest` seams rather than booting a device.
- **Write tests, then verify them.** Implementation is not done until `node --test` is run and the new suite passes (not merely written). The "iOS never calls `runAgentDevice`" assertion is the load-bearing test.

## 3. Architecture & data flow

One guarded orchestrator that all new consumers funnel through:

```
cdp_dismiss_dev_client_picker (new MCP tool) ─┐
device_deeplink (after Android open) ─────────┼─► clearDevClientPickerIfPresent(platform?)
                                              │       │
                                              │       ├─ iOS  → skip (guard) → { skipped: true }
                                              │       └─ Android → handleDevClientPicker()   ← unchanged
                                              │                      (find "Development servers"
                                              │                       → snapshot → parseFirstServerEntry
                                              │                       → press entry → waitForBundle)
```

Putting the iOS guard and timing in one helper means every consumer upgrades at once when the iOS re-path eventually lands.

## 4. Components

### 4.1 Shared helper — `clearDevClientPickerIfPresent(platform?)`

New export in `tools/dev-client-picker.ts`.

- **Signature:** `clearDevClientPickerIfPresent(platform?: 'ios' | 'android'): Promise<PickerOutcome>`
- **Platform resolution:** `platform ?? getActiveSession()?.platform ?? (await detectPlatform())`.
- **iOS guard:** returns `{ dismissed: false, skipped: true, reason: 'iOS dev-client picker auto-dismiss is not supported yet (follow-up); select the Metro server manually on the simulator.' }` — does **not** call `handleDevClientPicker()`.
- **Android:** delegates to `handleDevClientPicker()` and passes its result through (`null` when no session, else `{ dismissed, reason }`).
- **No-device:** if no platform resolves, return `{ dismissed: false, reason: 'no device/session' }` (treated as benign no-op by callers).
- Wrapped in `createStepTimer` so callers can attach `meta.timings_ms` per the repo's tool-timing convention.

`PickerOutcome` type: `{ dismissed: boolean; reason: string; skipped?: boolean } | null`.

### 4.2 MCP tool — `cdp_dismiss_dev_client_picker`

- **Args (zod):** `platform?: z.enum(['ios','android']).optional()` — "Force platform; otherwise resolved from the active session or booted device."
- **Handler:** `createDismissDevClientPickerHandler()` (in `tools/dev-client-picker.ts`), calls `clearDevClientPickerIfPresent(args.platform)` and maps the outcome:

  | Helper outcome | Tool result | Code |
  |---|---|---|
  | `null` (no active session, Android) | `failResult` | `DEV_CLIENT_PICKER_NO_SESSION` — "Call device_snapshot action=open first." |
  | `{ skipped: true }` (iOS) | `warnResult` | actionable manual-select message |
  | `{ dismissed: true, reason }` | `okResult { dismissed: true, reason, platform }` | — |
  | `{ dismissed: false, 'not detected' }` | `okResult { dismissed: false, reason }` | benign — picker was not up |
  | `{ dismissed: false, 'could not find …' }` | `warnResult` | "select the Metro server manually" |

  All results carry `meta.timings_ms`.

- **Registration:** `trackedTool('cdp_dismiss_dev_client_picker', <desc>, <schema>, createDismissDevClientPickerHandler())` in `scripts/cdp-bridge/src/index.ts`. **Registered-tool count 75 → 76** on this branch's `origin/main` base (`5c4ca04`, which already includes the `observe` tool). CLAUDE.md states "75 tools (re-audited 2026-05-29)" and is accurate at this base (verified: `grep -c '^trackedTool(' = 75`), so bump it to **76** as part of this change.

### 4.3 `device_deeplink` wiring

In `tools/device-deeplink.ts`, after a **successful Android** `openAndroidDeeplink()`:

- call `clearDevClientPickerIfPresent('android')` (best-effort; never fails the deeplink),
- annotate the result: `meta.pickerDismissed: true|false` when a session was open, or `meta.pickerChecked: false` when session-less (helper returned `null`).

iOS deep links are unaffected (the guard skips). Session-less deeplinks are the common case and must remain a clean no-op.

## 5. Files touched

| File | Change |
|---|---|
| `scripts/cdp-bridge/src/tools/dev-client-picker.ts` | Add `clearDevClientPickerIfPresent()` + `createDismissDevClientPickerHandler()`; `PickerOutcome` type; import `getActiveSession`/`detectPlatform`/`createStepTimer` |
| `scripts/cdp-bridge/src/tools/device-deeplink.ts` | Best-effort `clearDevClientPickerIfPresent('android')` after a successful Android open + meta annotation |
| `scripts/cdp-bridge/src/index.ts` | Register `cdp_dismiss_dev_client_picker` via `trackedTool` |
| `scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js` | New unit tests (see §6) |
| `docs-site/src/content/docs/dev-client-coverage.md` | Move "No MCP-exposed picker-dismiss tool" from Deferred → Fixed; note the deep-link wiring |
| `docs-site/src/content/docs/troubleshooting.mdx`, `skills/rn-testing/SKILL.md`, `CLAUDE-MD-TEMPLATE.md` | Replace the racy `runFlow when: visible: "DEVELOPMENT SERVERS"` pattern with a `cdp_dismiss_dev_client_picker` call |
| `CLAUDE.md` | Bump tool count 75 → 76 (CLAUDE.md is accurate at 75 on this base); list the tool under device helpers |
| `.changeset/<slug>.md` | New changeset (see §7) |

No `plugin.json` change — MCP tools are server-registered, not enumerated in the manifest.

## 6. Tests

New `test/unit/gh-136-dismiss-picker-tool.test.js`, using the existing seams `_setRunAgentDeviceForTest` + `_setHasSessionForTest` (mirrors `gh-136-dev-client-picker.test.js`):

1. No session (Android) → `failResult` `DEV_CLIENT_PICKER_NO_SESSION`.
2. iOS → `warnResult` **and asserts `runAgentDevice` is never called** (proves no legacy-runner respawn). This is the key regression guard for the iOS decision.
3. Android, picker detected + server entry → `dismissed: true`.
4. Android, picker not detected → `dismissed: false` `okResult`.
5. Android, detected but no entry → `warnResult` (`dismissed: false`).
6. `device_deeplink` Android success with open session → helper invoked, `meta.pickerDismissed` present; session-less → helper not invoked, `meta.pickerChecked: false`.

All run under `node --test` (unit suite). No live device required — the tool wraps already-verified Android logic. An optional live Android dev-client smoke test is a nice-to-have, not a merge gate.

## 7. Version & release (honors "every main commit bumps version")

Versions are changesets-managed; the synthetic `rn-dev-agent-plugin` package is the plugin's source of truth, mirrored into `plugin.json` + `marketplace.json` by `sync-plugin-manifest.mjs`, then verified by `sync-versions.sh`. CI gates: `require-changeset` (shippable `src/` change without a changeset fails) + `version-sync`.

- **Add a changeset** `.changeset/devclient-picker-dismiss.md`:

  ```
  ---
  "rn-dev-agent-plugin": patch
  "rn-dev-agent-cdp": patch
  ---

  Add cdp_dismiss_dev_client_picker MCP tool (Android) + best-effort
  Dev Client picker dismissal after Android deep links (#136 sub-3).
  iOS is guarded with an actionable message pending the cross-platform re-path.
  ```

- **Bump on merge:** run `npm run version-packages` so the *installable* version actually moves — plugin `0.44.45 → 0.44.46`, cdp-bridge `0.38.40 → 0.38.41`. Without this step the marketplace install does not pick up the change.
- **Pre-existing debt to flag:** two changesets are already pending and unreleased (`ios-runner-self-build-and-gate-agent-device.md`, `observability-ui.md`); `version-packages` will consume them too, so the bump will reflect all three.

## 8. Definition of done

- `cdp_dismiss_dev_client_picker` registered and callable; iOS returns the guarded message; Android dismisses a live-or-mocked picker.
- `device_deeplink` Android path best-effort dismisses; session-less stays a clean no-op.
- Unit suite green, including the "iOS never calls `runAgentDevice`" assertion.
- Coverage doc + CLAUDE.md tool count + Maestro guidance updated.
- Changeset present; `npm run version-packages` run so versions move; `sync-versions.sh` passes.
- Per global rules: log to workspace `DECISIONS.md` / `ROADMAP.md`; run the consultant agent post-implementation.

## 9. Out of scope → follow-up issues

- **iOS cross-platform re-path** — rewrite the picker core to snapshot → match → press-by-`@ref` (reuse `device_find`'s orchestrator: `fetchSnapshotNodes` → `findInLatestSnapshot` → `rankSnapshotNodes` → `pressCandidate`). Carries a live-verify risk: whether XCUITest can see the expo-dev-menu picker surface.
- **Session-less dismissal** — let the helper detect/dismiss without an open device session (needed to make `device_deeplink` auto-dismiss useful in the common session-less case).
- **`cdp_restart` picker step** — add picker handling to the hardReset relaunch (and to the future Android hardReset branch).
- **Tutorial modal** detection/dismissal (relates to #173 sub-4) — no programmatic CDP/a11y signal today.
- **CI DC-Task 9** — now unblocked by PR #187; wire the asserting harness suites (picker Metro-DOWN, tutorial Metro-UP).
