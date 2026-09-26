---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

An unreadable authority registry (SQLite corrupt, I/O or not-a-database errors) now returns a typed `AUTHORITY_STORE_UNAVAILABLE` refusal from `rn_session status`, `cdp_status` and every gated tool instead of a bare `database disk image is malformed` error.
