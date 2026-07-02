# Observe UI overhaul + autostart — design spec

**Date:** 2026-07-02
**Status:** awaiting user review
**Scope:** `scripts/cdp-bridge` (observe tool, observability server/web UI, project config), `hooks/detect-rn-project.sh`, `commands/observe.md`

## Problem

1. The observability web UI must be started manually (`/observe`), its port is random each
   session, and most users never discover it.
2. The UI itself is a raw dev tool: weak visual hierarchy, an unfilterable event stream, no
   session overview, and a Regression view that cannot run parameterized actions.
3. There is no way to opt out of (or into) observe behavior persistently — the only knobs are
   per-call tool actions and one env var (`RN_AGENT_OBSERVE_PORT`).

## Decisions

Decisions marked ⚑ were made autonomously (user AFK during clarification) and need explicit
confirmation at review.

| # | Decision | Choice |
|---|----------|--------|
| D1 | Autostart trigger | Worker MCP boot (`index.ts`), gated on RN project detection via `findProjectRoot()` |
| D2 | Autostart default | **On** (`observe.autoStart` default `true`) |
| D3 ⚑ | Default port | Fixed **7333**; `EADDRINUSE` → ephemeral fallback (existing behavior) |
| D4 ⚑ | Browser auto-open | **No** — URL is printed, never auto-opened |
| D5 | Config surface | Extend existing `.rn-agent/config.json` with an `observe` block (same file/pattern as `cdp.autoConnect`) |
| D6 | Precedence | env > config > default, mirroring `resolveAutoConnect` |
| D7 | Command fate | Keep a single `/observe` command as the control surface (status/stop/restart); no separate start command needed since autostart covers the common path |
| D8 | Stop semantics | `stop` is session-scoped; persistent opt-out is `observe.autoStart: false` |
| D9 | UI approach | Overhaul within existing architecture (React + Vite, no new runtime deps, no new server APIs); split `main.tsx` into modules |
| D10 | URL discovery | Actual URL written to a hardened per-project state file (`secure-state-file.ts`, GH #383 pattern); SessionStart hook prints the expected URL optimistically |

## Design

### 1. Autostart

In `index.ts`, after tool registration:

```
if (findProjectRoot() && resolveObserveAutostart().enabled) {
  try { await startObserveServer(); writeObserveStateFile(url); }
  catch (e) { logger.warn('OBSERVE', `autostart failed: ${e}`); }
}
```

- `startObserveServer()` reuses the module-global server instance in `tools/observe.ts` so a
  later `observe status/stop` sees the autostarted server (extract the shared start logic from
  `observeHandler` rather than duplicating it).
- Autostart failure is non-fatal and logged once.
- The supervisor process stays socket-free (its documented invariant); only the worker listens.

### 2. Port & URL resolution

- `resolveObservePort()`: `RN_AGENT_OBSERVE_PORT` env > `observe.port` config > `7333`.
  Invalid values fall through to the next source (reuse `parsePinnedPort` semantics).
- `ObservabilityServer.start(pinned)` already falls back to an ephemeral port on
  `EADDRINUSE` — unchanged. Second concurrent session therefore still works; its true URL
  comes from `observe status` / the state file.
- On successful start, write `{ url, port, pid, projectRoot, startedAt }` to
  `getStateDir()/observe/<sanitized-project-key>.json` via `writeJsonStateFileAtomic`.
  Delete it on `stop` and via the existing graceful-shutdown path.

### 3. Config (`.rn-agent/config.json`)

```json
{
  "cdp":     { "autoConnect": true },
  "observe": { "autoStart": true, "port": 7333 }
}
```

- Extend `RnAgentConfig` in `project-config.ts`:
  `observe?: { autoStart?: boolean; port?: number }`.
- Add `resolveObserveAutostart(deps?)` and `resolveObservePort(deps?)` with the same
  `{ env, readConfig }` test seams and `source: 'env' | 'config' | 'default'` result shape as
  `resolveAutoConnect`.
- Unreadable config keeps the existing warn-once-and-ignore behavior.

### 4. Observe tool: `restart` action

- Schema becomes `enum(['start', 'stop', 'restart', 'status'])`.
- `restart` = `stop()` then `start(resolvedPort)` on a fresh `ObservabilityServer`. The
  recorder is module-global, so the event timeline survives; SSE clients receive the existing
  `shutdown` sentinel and the browser tab shows the reconnect state.
- `start`/`restart` use `resolveObservePort()` (today `start` only reads the env var).

### 5. `/observe` command + SessionStart hook

- `commands/observe.md` rewritten: the default action reports status + URL; if the server is
  down (autostart disabled or previously stopped), an explicit `/observe` starts it — invoking
  the command is an explicit request to see the UI. `stop` and `restart` map to the tool
  actions; the doc mentions `observe.autoStart: false` in `.rn-agent/config.json` for
  permanent opt-out.
- `hooks/detect-rn-project.sh`: when an RN project is detected and autostart resolves
  enabled (cheap check: env var, else `node -e` one-liner reading `.rn-agent/config.json`),
  append one line of additional context:
  `Observe UI: http://127.0.0.1:<port> — /observe to stop/restart`.
  If config parsing fails, stay silent (never block session start).

### 6. Web UI overhaul

File split under `src/observability/web/src/`:

```
main.tsx            — mount + top-level App state only
theme.ts            — design tokens (colors, spacing, type scale) + global CSS string
types.ts            — AgentEvent, ActionSummary, E2e* interfaces
hooks/useEventStream.ts — SSE wiring, event merge, live frame + e2e progress state
components/Header.tsx        — title, connection dot, app id, route chip, session clock, call/error counters
components/FilterBar.tsx     — family chips (color + count), search input, errors-only toggle
components/Timeline.tsx      — rows, expand-on-click detail, follow/pause autoscroll + "↓ latest"
components/DevicePane.tsx    — framed screenshot hero, route overlay, guided empty state
components/StatePane.tsx     — route/store/tree tabs
components/RegressionView.tsx — e2e runner, results, expandable history (loads /api/e2e/runs/:id)
components/ActionsPanel.tsx  — actions table, inline param inputs, expandable run output
```

Behavioral changes:

- **Filtering** is client-side over the in-memory buffer: family toggles, substring search on
  `tool` + `summary`, errors-only. Filters compose (AND).
- **Autoscroll** follows the tail only while the user is at (or near) the bottom; scrolling up
  pauses following and shows a "↓ latest (N new)" affordance.
- **Timestamps** render as `HH:MM:SS` with slow-call emphasis (duration > 2s highlighted).
- **Session stats** derive from the event buffer (first event ts → clock; counts per family;
  error count). No new endpoints.
- **Actions with params** get inline text inputs (from `ActionSummary.params`) posted as
  `params` to `/api/e2e/actions/run` — fixing the current dead-end `missingParams` failure.
- **Run history drill-down** fetches `/api/e2e/runs/:id` on row expand and renders per-flow
  results (endpoint already exists, currently unused by the UI).
- Same dark palette (Tokyo Night), no light theme (localhost dev dashboard; YAGNI).
- No new runtime dependencies; bundle stays React + inlined CSS.

### 7. Out of scope

- Auto-opening the browser.
- New server/API endpoints; auth changes (localhost + host/sec-fetch-site guard + CSRF token
  stay as-is).
- Light theme, mobile layout.
- A user-visible daemon beyond the MCP worker lifetime (UI dies with the session, as today).

## Error handling

- Autostart: try/catch → single `logger.warn`; MCP boot unaffected.
- Config: existing warn-once for unparseable JSON; invalid `observe.port` values ignored
  (fall through to default).
- State file: write failures swallowed (best-effort discovery aid); stale files are
  overwritten on next start and removed on graceful shutdown.
- UI: SSE `shutdown`/`error` states already handled; new fetches (`runs/:id`) render inline
  error text, never crash the app shell.

## Testing

Unit (vitest, existing patterns in `test/unit/`):

- `resolveObserveAutostart` / `resolveObservePort` precedence: env beats config beats default;
  malformed values skip to next source.
- Autostart gating: no project root → no listen; `autoStart: false` → no listen; failure →
  warn, boot continues.
- `restart`: recorder buffer preserved; old SSE clients get `shutdown`; new server listens.
- State file: written atomically on start, removed on stop.

Build/manual:

- `npm run build:web` gates the SPA changes; live verification of both views (Live +
  Regression) against a running simulator before ship.

## Delivery

Two sequential PRs off this spec:

1. **Lifecycle**: config resolvers, autostart, `restart` action, state file, hook + command
   docs. (Pure TS, fully unit-testable.)
2. **UI overhaul**: web/src split + redesign. (Isolated to the SPA; no bridge changes.)
