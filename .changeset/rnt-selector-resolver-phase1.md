---
"rn-dev-agent-cdp": minor
---

Add an RNTL-style discovery resolver to the injected helpers. `resolveLadder` finds elements by `byRole(+name)` / `byText` / `byPlaceholder` — ported from React Native Testing Library (matcher + normalizer, accessible-name, role, hidden, host-kind) — with fail-closed truncation and fail-closed multiplicity (never silently picks the wrong element), hidden-element exclusion by default, and a selector bundle (`testID` / `text` / `accessibleName` / `role` / `placeholder` / `anchors`). `interact()` routes `role`/`name`/`text`/`placeholder` selectors through the ladder. Includes RNTL `matchDeepestOnly` so a composite+host fiber pair (e.g. `Text`+`RCTText`) resolves to a single on-device element instead of fail-closing as ambiguous.
