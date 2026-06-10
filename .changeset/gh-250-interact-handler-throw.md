---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(#250): `cdp_interact` no longer reports success when the app's own handler throws. The injected interact dispatch caught handler exceptions (`onPress`/`onChangeText`/`setValue` raising — unmounted component, missing context, thrown validation) and returned `success: true, action_executed: true`, which the tool layer surfaced as a non-error warning — so agents proceeded against a screen that may be in an error state. The helper now reports `success: false` (keeping `action_executed: true` to distinguish "dispatched but handler threw" from "couldn't dispatch"), and the tool layer maps it to a structured error with `meta.actionExecuted`, `meta.handlerError`, and a check-`cdp_error_log` hint. HELPERS_VERSION bumped to 25 so connected sessions re-inject.
