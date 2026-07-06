# Observe UI: idb install hint banner in device pane header

**Date:** 2026-07-06
**Status:** Approved

## Problem

When idb is not installed, iOS mirroring falls back to the `simctl` screenshot
loop (~6fps). The backend already attaches the remediation hint —
`install idb for smoother mirroring (brew install idb-companion && pipx install fb-idb)`
(`SIMCTL_HINT`, `src/observability/mirror/sources.ts`) — to the `streaming`
mirror status (`src/observability/mirror/manager.ts`). But the web UI renders it
in `.mirror-footer`, which is a single ellipsized 11px line in a 280–400px pane:
the brew command is truncated away, so the hint is not actionable.

## Design

Presentational change only; no backend or type changes.

### Banner (DevicePane.tsx)

- Render a `.mirror-banner` div directly below `.pane-head` containing the full
  `mirror.hint` text.
- Condition: `mirror.status === 'streaming' && mirror.hint` — the backend only
  attaches a hint to a streaming status for the `simctl` pipeline, so this is
  exactly "iOS mirror running without idb". No banner for Android, the idb
  pipeline, idle, error, or missing mirror state.
- While streaming, the footer shows only the status line
  (`mirror: simctl ~6fps`) — the hint is no longer duplicated there.
- The **error** path is unchanged: failure hints (idb spawn failure, ffmpeg
  missing) keep rendering in the footer as `mirror off: <reason> — <hint>`.

### Style (theme.ts)

`.mirror-banner`: amber text `#e0af68` (matches `.mirror-hint`), 11px,
`padding: 5px 12px`, `background: #1a1b26`, `border-bottom: 1px solid #2a2b3d`,
normal wrapping (no ellipsis) so the brew command stays fully readable and
copyable at narrow pane widths.

## Verification

- Unit suite stays green (backend untouched).
- Rebuild web bundle (`npm run build:web`).
- Mock observe server pushing `{status:'streaming', pipeline:'simctl', hint:…}`:
  banner visible and wrapping at 1440×900 and at narrow center-pane width;
  footer shows status line only.
- Error status push: hint still renders in the footer, no banner.

## Ship

Patch changeset for `rn-dev-agent-cdp` + `rn-dev-agent-plugin`; PR from
`feat/observe-idb-hint-header`.
