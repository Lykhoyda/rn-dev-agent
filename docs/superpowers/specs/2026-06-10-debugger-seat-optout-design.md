# Debugger-seat opt-out + silent hook-mode network transport — Design

**Date:** 2026-06-10
**Status:** Approved
**Origin:** User feedback (external report): the rn-dev-agent CDP bridge evicts React Native
DevTools from the single debugger seat and re-grabs it on every reconnect; hook-mode network
capture spams `__RN_NET__:` lines into Metro logs and the user's DevTools console.

## Problem

React Native's dev-middleware allows exactly **one debugger frontend per Hermes target**. The
bridge and the visual React Native DevTools therefore evict each other. Two defects compound it:

1. **The bridge always wins the seat fight.** When the user opens RN DevTools, the bridge's
   WebSocket closes → `handleClose()` (`scripts/cdp-bridge/src/cdp/reconnection.ts`) starts an
   exponential-backoff reconnect whose attempt 0 has a **0ms delay**, instantly re-grabbing the
   seat and kicking the user's DevTools ("Disconnected due to opening a second DevTools window").
   Even after 30 failed attempts, `startBackgroundPoll()` re-attaches every 5s whenever Metro is
   reachable. There is no detection of "another frontend took the seat" and no off switch.

2. **Hook-mode network capture leaks into every console consumer.** On RN < 0.83 (or when
   `Network.enable` delivers no events), `cdp/setup.ts` defines
   `__RN_AGENT_NETWORK_CB__ = (type, data) => console.log('__RN_NET__:' + …)`. The bridge filters
   those lines from its own buffers (`cdp/event-handlers.ts`), but Metro logs and the user's
   DevTools console show the raw spam for every request/response.

## Decision summary (user-approved)

- **Default behavior unchanged**: the bridge keeps auto-reconnecting (agent-first posture).
- **Add an opt-out** with two surfaces: env var kill-switch + persisted `.rn-agent/` project
  config. No runtime toggle tool in this iteration.
- **Fix the `__RN_NET__` transport for everyone** (not gated behind the opt-out): replace
  `console.log` transport with an in-app ring buffer drained on demand.

## Part 1 — Connection-mode opt-out (`autoConnect`)

### Setting resolution

A resolved boolean `autoConnect` (default `true`), computed at bridge startup:

| Precedence | Source | Form |
|---|---|---|
| 1 (highest) | env var | `RN_CDP_AUTOCONNECT` — `'0'`/`'false'` = off (same parse convention as `RN_DEVICE_KILL_LEGACY`) |
| 2 | project config | `.rn-agent/config.json` → `{ "cdp": { "autoConnect": false } }` |
| 3 | default | `true` (today's behavior) |

`.rn-agent/config.json` does not exist yet — this design introduces it. `project-config.ts` gains
a reader for it. The file is optional; future bridge settings can live under other keys.

### Passive-mode semantics (`autoConnect: false`)

Disabled — exactly the **background** seat-grabbing paths:

1. `handleClose()` does **not** launch the reconnect loop. It resets state to `disconnected` and
   logs why it stayed down ("auto-reconnect disabled; will reconnect on next tool call") plus how
   to re-enable.
2. `startBackgroundPoll()` is a no-op (never re-attaches behind the user's back).
3. The Metro-detected reconnect that follows exhausted retry attempts never runs.

NOT disabled — on-demand connection. When the agent calls a CDP tool, the existing freshness
probe and on-demand connect still take the seat: that is a foreground, knowing action visible in
the user's terminal. Passive mode therefore means: *the bridge holds the seat only while the
agent is actively working; once the user's DevTools takes it, the bridge stays off it until the
next tool call.*

### Visibility

- `cdp_status` reports a top-level `autoConnect: { enabled: boolean, source: 'env' | 'config' | 'default' }`
  (the status payload has no `connection` envelope — fields like `reconnect` are top-level).
- Foreground recovery paths (`cdp_status` dev-false/isPaused `softReconnect`, `recoverWedge`,
  `recover-detached`) are NOT gated: they run only inside a tool call, which knowingly reclaims
  the seat. Passive mode stops background re-grabs only — documented in the troubleshooting entry.
- `/doctor` gains a row showing the resolved mode.
- Troubleshooting docs (CLAUDE-MD-TEMPLATE + docs-site) document the coexistence story: who owns
  the seat, how to yield it, how to take it back.

## Part 2 — `__RN_NET__` transport fix

Replace the console-log transport (`cdp/setup.ts`, hook-mode fallback path):

- `__RN_AGENT_NETWORK_CB__` pushes `{ type, data }` entries into a bounded in-app ring buffer
  `globalThis.__RN_AGENT_NET_BUF__` (cap ~100 entries, drop-oldest). No `console.log`.
- The bridge **drains on demand** via `cdp_evaluate` whenever a network-reading tool runs in hook
  mode: `cdp_network_log`, `cdp_wait_for_network`, and hook-mode `cdp_network_body`. Drained
  entries merge into the existing `DeviceBufferManager` so all downstream behavior (filtering,
  ring-buffer caps, sync semantics) is unchanged.
- The `__RN_NET__:` filter lines in `cdp/event-handlers.ts` remain for one release as a
  back-compat guard (a stale injected callback from an older bridge could still emit), then can
  be removed.

This is unconditional — every user gets a silent console, with or without the opt-out.

## Error handling

- Malformed / unreadable `.rn-agent/config.json` → ignore, log once, fall back to default.
  Config must never block a session (same fail-open philosophy as the device ownership lock).
- Env var parse mirrors `RN_DEVICE_KILL_LEGACY`.
- Drain `evaluate` failure (app reloaded, helpers stale) → return what the bridge already has
  buffered; never error a read tool because the drain failed.

## Testing

Unit (TDD, in the existing cdp-bridge vitest suite):
- Config precedence resolution (env > config file > default; malformed file ignored).
- `handleClose()` in passive mode: no reconnect loop launched, state `disconnected`.
- Background poll suppressed in passive mode.
- Net-buffer drain: entries merge into `DeviceBufferManager`; cap/drop-oldest respected; drain
  failure falls back gracefully.

Live gates (booted simulator):
- Passive mode on → open RN DevTools next to the bridge → DevTools keeps the seat (no eviction);
  next agent tool call reclaims it.
- New transport → Metro logs show **zero** `__RN_NET__` lines while `cdp_network_log` still
  returns entries in hook mode.

## Out of scope

- Runtime toggle tool (e.g. `cdp_disconnect({ release: true })`) — possible follow-up.
- Auto-yield default (detect eviction-by-frontend and back off) — explicitly rejected in favor of
  keeping the agent-first default.
- The "multiple React Native hosts" banner from the original report — app-side, not caused by
  this plugin.
