---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Bound the system-dialog fallback presence probe to a 15-second default (explicit caller timeouts through 120000ms remain accepted) so Android and session-less iOS calls with no dialog return typed DIALOG_NOT_FOUND promptly instead of appearing hung for two minutes, and teach the tool-docs generator to parse prettier-wrapped .describe() calls and wrapped zod chains so parameters such as timeoutMs and device_find.index are no longer published as undocumented unknowns.
