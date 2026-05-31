---
"rn-dev-agent-plugin": patch
"rn-dev-agent-cdp": patch
---

Add `cdp_dismiss_dev_client_picker` MCP tool (Android) and best-effort Dev
Client picker dismissal after Android deep links (#136 sub-3). Routed through a
single guarded `clearDevClientPickerIfPresent()` helper; iOS returns an
actionable manual-select message instead of touching the legacy agent-device
path. Cross-platform iOS support tracked as a follow-up.
