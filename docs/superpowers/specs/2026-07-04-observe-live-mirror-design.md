# Observe UI: Live Device Mirroring — Design

**Date:** 2026-07-04
**Status:** Approved pending user spec review
**Prior art studied:** Maestro MCP viewer (`~/GitHub/Maestro/maestro-cli/src/main/java/maestro/cli/mcp/viewer/`, `maestro-cli/mcp-viewer/`)

## Problem

The observe web UI's DevicePane shows a device screenshot that refreshes only after a
state-mutating MCP tool call (GH #206). When the agent is idle, when the user drives the
simulator by hand, or during animations/scrolling, the pane is frozen. Maestro Studio and
Maestro's MCP viewer show a continuously mirrored device screen; we want the same UX.

## What Maestro does (verified in local repo)

- Viewer frontend renders the mirror as `<img src={streamUrl}>` — an MJPEG
  (`multipart/x-mixed-replace`) HTTP stream decoded natively by the browser
  (`maestro-cli/mcp-viewer/src/main.tsx:802`).
- Frames are produced by `simulator-server`, a **prebuilt closed-source binary** downloaded
  from `mobile-dev-inc/simulator-server-releases` at build time (`maestro-cli/build.gradle.kts:239`).
  No capture source code exists in the repo; we cannot reuse it (licensing + distribution).
- The Ktor viewer server spawns the binary, waits for a `stream_ready <url>` stdout
  handshake, and proxies input over stdin. Device state is published over a second SSE channel.

## Decisions (with user)

1. **Display-only.** No tap/swipe/keyboard forwarding from the browser. (Interaction can be
   layered on later without changing the streaming design.)
2. **Video-like target: 15–30 fps** where achievable; MJPEG streaming architecture.
3. **Device scope:** iOS simulators, Android emulators, physical Android devices.
   Physical iOS explicitly out of scope.
4. **iOS pipeline policy:** use `idb` (20–30 fps) when installed; otherwise fall back to a
   sequential `simctl screenshot` loop (~6 fps, measured 173 ms/shot on an M-series host) and
   show an "install idb for smoother mirroring" hint.
5. **Simplification filter: performance must be equal or better.** Consequences:
   - `idb` fast path ships in v1 (deferring it would regress iOS to ~6 fps for idb users).
   - No Android `screencap` polling fallback (with ffmpeg present — which
     `ensure-ffmpeg.sh` already guarantees for proof recordings — performance is identical;
     the fallback only served a state the plugin auto-repairs).
   - All Maestro machinery we drop (device picker, child HTTP server, second SSE channel,
     input/overlay layers, cross-OS binaries) is orchestration, not capture path: zero fps impact.

## Architecture

```
capture source (child process)      MirrorManager (in observe server)     browser
──────────────────────────────      ─────────────────────────────────     ───────
iOS:  idb video-stream mjpeg ─┐
iOS:  simctl screenshot loop ─┼─▶ JPEG frame parser ─▶ latest-frame ─▶ GET /api/device/mirror
Andr: adb screenrecord h264 ──┘     (SOI/EOI scan)      broadcast       multipart/x-mixed-replace
      │ pipe                                                            rendered via <img src=…>
      └▶ ffmpeg → mjpeg (stdout)
```

Everything runs in-process in the CDP bridge's observe server. Sources are dumb child
processes writing JPEG (or H.264, transcoded by a piped ffmpeg) to stdout. No child HTTP
server, no handshake protocol, no port allocation — deliberate simplifications vs Maestro,
possible because we are display-only and already own a local HTTP server.

### Components

New module `scripts/cdp-bridge/src/observability/mirror.ts` (split into `mirror/` directory
with `manager.ts` / `sources.ts` / `jpeg-stream.ts` if it exceeds ~400 lines):

1. **JPEG frame parser** — incremental scanner over stdout chunks; emits complete frames on
   SOI (`FF D8`) / EOI (`FF D9`) boundaries. Handles frames split across chunk boundaries,
   garbage prefixes, and partial tails. Shared by all sources. (Safe because idb mjpeg and
   ffmpeg `-f mjpeg` output contain no nested-JPEG EXIF thumbnails.)

2. **Sources** (selected per platform, first available wins):
   - `IosIdbSource` — `idb video-stream --udid <U> --fps <fps> --format mjpeg` (exact flags
     confirmed at implementation time against installed idb). Requires `idb` client;
     detection via `command -v idb`. 20–30 fps.
   - `IosSimctlLoopSource` — sequential `xcrun simctl io <U> screenshot --type=jpeg -`;
     next capture starts when the previous completes (natural ~6 fps pacing, no pileup).
     Zero dependencies beyond Xcode. Emits `hint: "install idb for smoother mirroring"`.
   - `AndroidScreenrecordSource` — `adb -s <serial> exec-out screenrecord
     --output-format=h264 --time-limit=179 -` piped into
     `ffmpeg -fflags nobuffer -f h264 -i pipe:0 -q:v 7 -f mjpeg pipe:1`.
     Auto-restart loop absorbs the 180 s screenrecord cap (sub-second hiccup every ~3 min).
     3 failures within 10 s → terminal error state for this attach cycle.
     Works identically for emulators and physical devices. If ffmpeg is missing:
     error status + hint referencing ensure-ffmpeg; no slow fallback source.

3. **MirrorManager** — refcounted lifecycle + broadcast:
   - First `<img>` client on `GET /api/device/mirror` resolves the target and starts the
     source; last disconnect stops it after a ~5 s grace (survives tab refresh).
     **No browser tab open → no capture processes, zero cost.**
   - Latest-frame broadcast: each frame is written to every connected client as a multipart
     part (`--boundary`, `Content-Type: image/jpeg`, `Content-Length`). Backpressured
     clients (socket `write()` returns false) skip frames until `drain` — newest frame
     always wins, no buffering.
   - Target resolution follows the active session: platform from
     `getActiveSession()?.platform` else CDP `connectedTarget.platform` (same chain as
     `live-device.ts` `buildLiveDeps`); deviceId via the existing resolution helpers used by
     `device_screenshot` / `device_record`, including the multi-device ambiguity refusal
     (GH #422 lineage). No device-picker UI or start/stop API (Maestro needs one; we don't).
   - Status events pushed through the existing recorder SSE stream (no second channel):
     `{ type: 'mirror', status: 'starting'|'streaming'|'error'|'idle',
        platform?, deviceId?, pipeline?: 'idb'|'simctl'|'screenrecord',
        fps?: number, hint?: string, reason?: string }`.

### Server changes (`server.ts`)

- One new route: `GET /api/device/mirror` → `MirrorManager.attach(res)`. Same `guard()`
  (host allowlist + `Sec-Fetch-Site`) as all existing routes; `Cache-Control: no-store`.
- `stop()` also detaches mirror clients and tears down the pipeline.

### Frontend changes (`src/observability/web/`)

- `useEventStream` — handle `mirror` events; expose `mirror` state.
- `DevicePane` — when mirror status is `starting` or `streaming`, render
  `<img src="/api/device/mirror?t=<attach-nonce>">`; on `error`/`idle`, keep today's
  live-screenshot behavior. Show a one-line status/hint (pipeline + fps + upgrade hint).
  On `<img>` `onerror`, retry with a fresh cache-busting nonce after a short delay.
- Per-event screenshot thumbnails in the timeline are untouched.

### Interaction with existing behavior

- **GH #206 live capture stays** as the fallback path. While the mirror is `streaming`,
  `maybeCaptureLiveFrame` skips its screenshot (route read still runs) — saves the
  ~200–500 ms screenshot cost on every interaction tool call.
- **`device_record` coexists** — no interlock in v1. Concurrent `screenrecord` instances are
  supported on Android API ≥ 24-ish; iOS `simctl recordVideo` and our sources use
  independent capture paths. Known limitation: very old Android devices may fail the second
  screenrecord; the mirror errors and falls back without affecting `device_record`.
- **Config:** `.rn-agent/config.json` → `observe.mirror.enabled` (default `true`),
  `observe.mirror.fps` (default `20`, clamped 5–30, applies to idb; screenrecord fps is
  whatever the device emits). Env override `RN_AGENT_OBSERVE_MIRROR=0` disables, matching
  the existing `RN_AGENT_OBSERVE_*` pattern.

## Error handling

Every failure degrades to today's behavior, never below it:

| Failure | Behavior |
|---|---|
| No booted/connected device | `mirror: error` + reason; DevicePane keeps GH #206 behavior |
| Ambiguous device (2+ booted) | error + reason naming the refusal (mirrors GH #422 policy) |
| idb absent | silent downgrade to simctl loop + hint |
| ffmpeg absent (Android) | error + ensure-ffmpeg hint |
| Source dies mid-stream | auto-restart; 3 failures / 10 s → error until next client attach |
| Server shutdown | multipart response ended; `<img>` onerror fires; UI reverts |

Retry trigger: next `<img>` attach (page refresh or auto-retry nonce). No unbounded respawn.

## Security

- Endpoint is GET-only, display-only, bound to `127.0.0.1`, behind the existing host +
  `Sec-Fetch-Site` guard. No input surface is added.
- Mirror frames are served only while a same-origin page holds the stream open; frames are
  never written to disk (contrast: GH #422's screenshot path).

## Testing

Unit (fake child processes / fake sockets, existing test style in `test/unit/`):
- JPEG parser: frames split across chunks, garbage prefix, partial tail, back-to-back frames.
- MirrorManager: start on first attach, grace-stop after last detach, re-attach within grace
  reuses pipeline, refcount correctness with 2 clients.
- Screenrecord restart loop: clean exit at time-limit → restart; 3 rapid failures → error.
- Source selection: idb present/absent branch; ambiguous-device refusal.
- Status events: emitted into recorder stream in lifecycle order.
- Live-capture short-circuit: `maybeCaptureLiveFrame` skips screenshot while streaming.
- Slow client: backpressured socket skips frames, resumes on drain, never buffers.

Integration (`test/integration/`): two HTTP clients on `/api/device/mirror` fed by a fake
source receive well-formed multipart frames; disconnect of one does not stall the other.

Manual verification: booted iPhone 16 Pro simulator (idb and simctl paths), Android
emulator, physical Android device; confirm idle-tab teardown (`ps` shows no capture
processes when no browser tab is open).

## Out of scope (explicit)

- Physical iOS mirroring.
- Input forwarding (taps/swipes/keys) from the browser.
- Windows/Linux host support beyond what adb+ffmpeg incidentally provide.
- WebSocket/WebCodecs H.264 transport (localhost MJPEG is sufficient; revisit only if
  remote observe becomes a requirement).

## Performance expectations vs Maestro

| Scenario | Ours | Maestro |
|---|---|---|
| iOS sim, idb installed | 20–30 fps | 20–30 fps (same framebuffer tech lineage) |
| iOS sim, no idb | ~6 fps + hint | 20–30 fps (bundled binary) |
| Android emu/physical | 20–30 fps | 20–30 fps |
| CPU when no tab open | zero (no processes) | n/a (viewer-driven too) |
