---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Observe UI test confidence (#438, audit P1-A): the web SPA and the
observability server now share one wire-types module, the UI carries stable
`data-testid` selectors, and a Playwright e2e suite exercises the real server
against the committed bundle on every PR.

- `src/observability/wire-types.ts` (pure types, zero Node imports) is the
  single source for `AgentEvent`/`AgentEventFamily`, the e2e run shapes
  (`E2eFlowResult`, `E2eRunRecord`, `E2eRunIndexEntry`, verdict/classification
  unions), `ActionSummary`, and the action-run result. The server modules
  re-export it and `web/src/types.ts` re-exports it too — the hand-copied
  twins are gone, and the web-bundle CI gate now runs `tsc --noEmit` on the
  SPA so server↔UI drift is a compile error (previously `vite build` only
  transpiled, so nothing checked).
- 27 `data-testid` attributes across Header, FilterBar, Timeline, DevicePane,
  StatePane, ActionsPanel, and E2ePanel.
- 10 Playwright specs (headless chromium) boot the real `ObservabilityServer`
  with a seeded `Recorder` + stub e2e deps on an ephemeral port: timeline
  render + family/errors/search filters, event detail, device hero
  screenshot, SSE live update, regression history + drill-down, and the
  CSRF-guarded suite/action run round-trips (including a 403 negative).
- Server hardening from review: oversized `POST /api/e2e/*` bodies now return
  a bounded 413 instead of becoming an unhandled rejection, and the CSRF
  token is injected via `JSON.stringify` + `<` escaping so it can never
  break out of the inline bootstrap script.
