---
"rn-dev-agent-plugin": patch
---

`/send-feedback` no longer presents weeks-old telemetry as "recent" (GH #266).

Root cause: the per-tool-call telemetry writer was removed with the Experience Engine (GH #200, v0.49 era), but `collect-feedback.sh` kept reading the orphaned `~/.claude/rn-agent/telemetry/*.jsonl` files and shipped their tail as "Recent Tool Activity" in filed issues. The collector now cross-checks the newest event's age: fresh events (<24h, legacy plugin versions still writing) ship as before with `telemetry_status: "ok"`; otherwise events are omitted and `telemetry_status` reports `stale (last event N days ago — …)` or `none` explicitly. The `/send-feedback` issue template renders the status line instead of an empty/misleading activity table, and the empty-telemetry edge no longer emits a single bogus `{}` event.
