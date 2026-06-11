# GH #262 — APP_NOT_INSTALLED detection in recovery paths + bundleId fallback (design)

**Issue:** [#262](https://github.com/Lykhoyda/rn-dev-agent/issues/262) — `cdp_status` APP_DETACHED recovery doesn't detect "app not installed"
**Absorbed residual:** #194 BUG 2 — `cdp_restart hardReset=true` loses its bundleId when the bridge process is fresh
**Kano class:** must-be (diagnostic truthfulness) · effort: s
**Date:** 2026-06-11 · **Status:** approved

## Problem

Two recovery paths give advice that cannot work:

1. **APP_DETACHED auto-relaunch** (`cdp/recover-detached.ts`, GH #208/RC3): when the app bundle is not installed at all (e.g. the user erased the simulator), `simctl launch` fails with the raw `FBSOpenApplicationServiceErrorDomain code=4` error and the tool tells the agent to "relaunch manually or call cdp_restart(hardReset=true)" — advice that can never succeed. The agent burns recovery attempts and has to discover not-installed via a manual `get_app_container` probe.
2. **hardReset bundleId resolution** (`tools/restart.ts:128`): the chain is `explicit arg > connectedTarget > in-memory lastSeenBundleId`. A fresh bridge process (or a #264 supervisor worker respawn) has no cache, so hardReset silently degrades to a soft reset (`skip-simctl:no-bundleId-on-connectedTarget-or-cache`) exactly when the hard path is needed.

Theme (shared with the rest of the #262 family): **recovery must resolve the app's identity and report its true install state** — never loop on advice that cannot work.

## Decisions

- **Scope: detect + advise with snapshot hint** (option B). No auto-reinstall: silently resurrecting a possibly stale build right after a deliberate simulator erase violates the no-surprising-side-effects theme. The advice names the snapshot so the fix is one copy-paste away.
- **Detection: probe on launch failure** (approach 1). Ground truth (`simctl get_app_container` existence) over error-string parsing; cost lands only on the already-failed path. Preflight probing (every attempt pays ~100–150 ms) and `FBSOpenApplicationServiceErrorDomain code=4` string-matching (brittle across Xcode versions, ambiguous) were rejected.

## Design

### 1. `cdp/recover-detached.ts`

- New injectable dep `isAppInstalled(udid: string, appId: string): Promise<boolean | null>` — default impl runs `xcrun simctl get_app_container <udid> <appId> app` (timeout ~5 s). Returns `true` when the container resolves; `false` **only on the known app-missing signal** (stderr matching `NSPOSIXErrorDomain` + `code=2` / `No such file or directory` — the signal issue #262 documents); `null` for **every other** failure shape (device-level errors, unrecognized stderr, timeout). Allowlist classification: unknown failures must never be reported as not-installed.
- When `relaunchApp` throws: run the probe. On `false` → **short-circuit** (skip the 1.2 s settle, reconnect, and liveness probe — they cannot succeed) and return:
  - `DetachedReason` union gains `'app-not-installed'`.
  - `DetachedRecoveryResult` gains optional `snapshotHint?: { path: string; ageMinutes: number }`.
  - The original launch error stays in `error`.
- On `true`/`null` → existing behavior unchanged (`still-detached` + raw error). **Fail open: never claim not-installed without proof.**
- Budget: the attempt that discovers not-installed counts (its side effects happened). No change to reset semantics.

### 2. `tools/resolve-ios-app-file.ts` — `findSnapshotForBundleId(bundleId)`

Scans `$TMPDIR/rn-appfile-snapshots/*.app` (the GH #201 bounded snapshot dir this file owns), matches `CFBundleIdentifier` via `plutil -extract CFBundleIdentifier raw <app>/Info.plist`, returns the newest match as `{ path, mtimeMs }` or `null`. Best-effort with an explicit budget: ≤ 10 candidates scanned, ~2 s timeout per `plutil` read, ~3 s total; any error or budget overrun → `null`. The hint never blocks or delays the error report. Deps (fs scan, plist read) injectable for tests.

### 3. `tools/status.ts` — mapping

`recovery.reason === 'app-not-installed'` → `failResult` with new code `APP_NOT_INSTALLED`:

> App `<bundleId>` is not installed on simulator `<udid>` — rebuild and install (`npx expo run:ios` / `pnpm ios`).
> *(when hint present)* Or reinstall the snapshot taken at the last clearState, N min ago (may be stale): `xcrun simctl install <udid> '<path>'`.

The embedded `udid` and snapshot `path` are **shell-quoted** (single-quoted with internal `'` escaped) before interpolation — `.app` names can contain spaces/metacharacters, and the advice is designed to be copy-pasted into a shell.

### 4. `tools/restart.ts` — two touches

- Resolution chain gains a final fallback: `args.bundleId ?? observedBundleId ?? lastSeenBundleId ?? resolveBundleId(targetPlatform)` (`project-config.ts:42`, app.json). Closes #194 BUG 2 with no disk persistence.
- On `simctl launch` failure inside hardReset: same `isAppInstalled` probe; on `false` the step string becomes `simctl launch:err(APP_NOT_INSTALLED — app not installed on simulator; rebuild or simctl install <snapshot>)`.

### 5. `types.ts`

Add `APP_NOT_INSTALLED` to the tool error-code union.

## Error handling

| Situation | Behavior |
|---|---|
| Probe says container exists | `still-detached` + raw launch error (unchanged) |
| Probe fails with device-level stderr / times out | `still-detached` + raw launch error (**fail open**) |
| Probe says app missing | `app-not-installed`, short-circuit, snapshot hint best-effort |
| Snapshot lookup errors | Hint omitted; error report unaffected |

## Testing (TDD, existing injectable-deps pattern)

- **recover-detached:** launch fails + probe `false` → `'app-not-installed'`, reconnect/liveness skipped, hint attached when finder matches; probe `null`/`true` → `'still-detached'` fail-open; budget consumption unchanged.
- **findSnapshotForBundleId:** match, no match, unreadable/missing Info.plist, multiple snapshots → newest wins.
- **status.ts:** `'app-not-installed'` → `APP_NOT_INSTALLED` code; advice includes `simctl install` line iff hint present.
- **restart.ts:** chain falls back to `resolveBundleId()` when connectedTarget+cache are empty (the #194 BUG 2 repro); `launch:err` step classified on probe `false`.

## Out of scope

- Android — `recoverDetached` is iOS-only by design (GH #208 review).
- Auto-reinstall from snapshot (rejected option C).
- Persisting `lastSeenBundleId` to disk — the app.json fallback makes it unnecessary.
- `device_*` open-path not-installed detection — different surface, file separately if observed.
