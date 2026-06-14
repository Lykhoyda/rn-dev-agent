# GH #206 — Live device panels for `/observe` (interaction-triggered)

**Status:** Approved (2026-06-14)
**Issue:** [#206](https://github.com/Lykhoyda/rn-dev-agent/issues/206) — `/observe` device section: screenshot not refreshing and route out of sync (`kano:performance`, `effort:m`)

## Problem

`/observe`'s device section drifts from the real device:
1. The live screenshot shows stale frames and lags the simulator during an active session.
2. The displayed route does not match the app's real route — `cdp_navigation_state` reports the correct active route while `/observe` shows an older one.

## Root cause

The observability layer is a **passive recorder of tool observations**, fully decoupled from the CDP client and the device session — there is no live device poller:

- **Screenshot** (`recorder.ts:56`, `captureScreenshot`) is captured *only* when `ev.tool === 'device_screenshot'`. The web UI (`main.tsx:132`) shows the latest such frame. Driving the app via `cdp_navigate` / `cdp_interact` (the reporter's flow) captures **zero** frames, so the panel freezes at the last explicit screenshot.
- **Route** (`main.tsx:129/137`) is derived only from navigation-family tools (`cdp_navigation_state`, `cdp_nav_graph`, `cdp_navigate`; `events.ts:45`). A `cdp_interact` tap changes the on-device route but emits an *interaction* event, so the panel lags the true route.

There is no poll interval to "tighten" (the issue's suggested fix presupposes a poller that does not exist). The fix is to **add** a refresh mechanism, and to give the decoupled observability layer access to the device UDID (screenshots) and CDP client (route) it needs.

## Approach (chosen)

**Interaction-triggered capture.** After each *state-mutating* agent tool call, capture a fresh screenshot + route and deliver them to `/observe`. Refreshes exactly when state changes; zero idle device load; no timers; naturally rate-limited by agent activity.

Rejected alternatives:
- **Timer-based live poll** (background interval while a tab is connected) — true near-real-time even when idle, but continuous device/CPU load + CDP contention + heavier gating. Overkill for "watch the agent."
- **Hybrid** (on-action + slow heartbeat) — more moving parts; both interference profiles. Deferred; can layer a heartbeat later if async/animated changes between actions prove to matter.

## Architecture

```
trackedTool wrapper (index.ts)
  └─ after handler resolves, fire-and-forget →  maybeCaptureLiveFrame()   [observability/live-device.ts]
                                                   ├─ screenshot: tryRawScreenshot(platform, tmpPath)   (simctl/adb, OS-level)
                                                   ├─ route:      navigation-state read via CDP client  (skipped if CDP down / flow active)
                                                   └─ recorder.pushLive({ shot?, route? })               [recorder.ts]
                                                                      └─ SSE: { type: 'live', … }        [server.ts]
                                                                                 └─ web UI device + route panels prefer live channel [main.tsx]
```

### Components

**`observability/live-device.ts` (new).** Exports `maybeCaptureLiveFrame(deps)`. Pure orchestration with injectable deps so it is unit-testable with fakes (mirrors the codebase's existing seam pattern):
- `captureScreenshot(platform, path) → { ok, path } | { ok:false }` (inject `tryRawScreenshot`)
- `readRoute() → payload | null` (inject the navigation-state handler / CDP eval)
- `getSession() → { platform, udid } | null`, `isFlowActive() → boolean`, `hasObservers() → boolean`
- `recorder` sink
- A module-level **single-flight with trailing-coalesce** guard (two booleans: `inFlight`, `pending`). If no capture is running, start one. If one is in flight, set `pending = true` and return immediately. When the in-flight capture finishes, if `pending` was set, clear it and run exactly one more. This guarantees the **final** post-burst state is captured (a pure drop would freeze `/observe` on the *first* frame of a rapid `device_batch`), while never running more than one trailing capture regardless of how many triggers arrived during the burst. Never throws; all errors swallowed.

**`recorder.ts` (extend).** Add `pushLive({ shotBuf?, contentType?, route? })`. Because live frames deliberately carry **no** timeline event (no event seq), they are stored in a **dedicated `liveShot` slot** (latest only) plus a `liveRoute` field — NOT the `shots` map and NOT the event ring buffer. A monotonic `liveSeq` increments per live frame for cache-busting. `pushLive` notifies subscribers with a `{ type: 'live', shotSeq?: liveSeq, route? }` event (`shotSeq` present only when a new frame was captured; `route` present only when a fresh route was read). The live frame is size-capped like existing shots and cleared by `clear()`.

**`server.ts` (extend).** The SSE `attach` path already relays recorder events; the `{type:'live'}` event flows through unchanged. Add a dedicated `GET /api/live-screenshot/<liveSeq>` handler, parallel to the existing `/api/screenshot/<seq>`. Contract (single, unambiguous): the `<liveSeq>` segment is **only a cache-busting key** — the handler always serves the **current** `liveShot` and never compares the seq. It returns **404 only when no `liveShot` exists yet** (none captured this session), otherwise 200 with the latest bytes and `Cache-Control: no-store`. The UI only ever requests the latest `liveSeq`, so serving-current is correct; a stale URL simply returns the current frame, which is harmless for a live monitor.

**`web/src/main.tsx` (extend, small).** Handle the `live` SSE event: keep `liveShotSeq` + `liveRoute` in state. When `liveShotSeq` is set, the device `<img>` src is `/api/live-screenshot/${liveShotSeq}` (preferred over the event-derived `/api/screenshot/${shotEv.seq}`); the route shown in the statusbar/route panel prefers `liveRoute` over `routeOf(navEv)`. Both fall back to today's event-derived values when no live data has arrived. Timeline is untouched (no synthetic rows). Bundle rebuilt; web-bundle freshness gate covers it.

**`index.ts` (wire).** In `trackedTool`, after the wrapped handler resolves, if the tool is **state-mutating** (see predicate below), schedule `void maybeCaptureLiveFrame(deps)` — deps closed over `getClient()`, `getActiveSession()`, `arbiter.flowActive || foreignFlowGate.lastActive`, `recorder`, and the SSE-observer count. Guarded by `RN_OBSERVE_LIVE !== '0'`.

### Trigger set — one explicit predicate

`isStateMutating(tool) = classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate'`.

This is the single source of truth (no hand-maintained second list). It is derived from `events.ts`, so it automatically covers **all 14** current `INTERACTION` tools — `cdp_interact`, `device_press`, `device_fill`, `device_swipe`, `device_scroll`, `device_longpress`, `device_pinch`, `device_back`, `device_batch`, `device_scrollintoview`, `device_focus_next`, `device_pick_date`, `device_pick_value`, `device_deeplink` — plus `cdp_navigate`. It deliberately **excludes** the two read-only `NAVIGATION`-family tools `cdp_navigation_state` and `cdp_nav_graph` (reads change nothing, so capturing after them is wasteful) and all introspection / lifecycle / testing tools. A unit test pins the predicate against `events.ts` so a future family change can't silently drop a mutator or admit a read.

## Safety / interference

- **Fire-and-forget:** the capture is scheduled with `void` after the handler returns its result to the caller — it never extends the triggering tool's latency or throws into the tool path.
- **Single-flight:** at most one live capture in flight; rapid `device_batch` taps coalesce.
- **Flow-aware:** skipped entirely while a Maestro flow owns the device (`arbiter.flowActive` / `foreignFlowGate.lastActive`) — the flow contends for CDP and the agent isn't driving via these tools then anyway.
- **Observer-gated:** no capture unless ≥1 SSE client is connected (zero cost when nobody is watching `/observe`).
- **CDP-route best-effort:** the route read is attempted only when CDP is connected; failure leaves the route on its last value (no error surfaced).
- **simctl/adb screenshot** is OS-level and cannot conflict with CDP or a foreign runner (same rationale as `device_screenshot`'s simctl fallback).

## Error handling

Every layer is best-effort and swallows errors, consistent with the recorder's existing "never throw into the tool path" contract. A failed screenshot or route read simply leaves that panel on its previous value. The `/observe` server already tolerates missing screenshots (404 → "no screenshot yet").

## Testing

- **`live-device.test.js`** (unit, with fakes): triggers a capture on an interaction-family tool; skips on introspection; skips when no observers; skips when flow active; single-flight (a second trigger while one is in flight does not start a concurrent capture); screenshot-fail and route-fail are swallowed and don't block; route read skipped when CDP down.
- **`recorder` test:** `pushLive` stores the latest frame/route, emits a `{type:'live'}` subscriber event, does NOT add a timeline event, and is cleared by `clear()`.
- **Predicate test:** `isStateMutating` returns true for every `INTERACTION`-family tool + `cdp_navigate`, and false for `cdp_navigation_state` / `cdp_nav_graph` and all introspection/lifecycle/testing tools — asserted against `events.ts` so a family change can't silently drop a mutator or admit a read.
- **Single-flight test:** a trigger during an in-flight capture sets `pending` and runs exactly one trailing capture (not zero, not two) after the first completes; the final captured frame reflects the last trigger.
- **Live device gate:** verify on the running simulator that driving via `cdp_interact`/`cdp_navigate` refreshes the `/observe` screenshot + route within one action, and that the route matches `cdp_navigation_state`.

## Opt-out

`RN_OBSERVE_LIVE=0` disables live capture; panels revert to today's on-tool-call behavior. Default on when `/observe` is running.

## Out of scope

- Timer/heartbeat polling for async/animated changes between actions (deferred; can layer on later).
- Any change to the timeline, event families, or non-device panels (store/tree tabs).
- Android-specific tuning beyond the existing `adb` screenshot path.

## Refs

Root cause in `scripts/cdp-bridge/src/observability/{recorder,server}.ts`, `web/src/main.tsx`, `events.ts`; reuses `tools/device-screenshot-raw.ts` (`tryRawScreenshot`), `agent-device-wrapper.ts` (`getActiveSession`), `lifecycle/device-arbiter.ts` (`flowActive`). Issue #206.
