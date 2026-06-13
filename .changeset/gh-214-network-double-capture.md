---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`cdp_network_log` no longer returns two entries per request (GH #214).

Root cause: setup sends `Network.enable` (mode `cdp`), then `probeNetworkDomain` fires a probe fetch and watches the buffer. On RN ≥ 0.83 the CDP Network domain *does* deliver events, but when they don't flush within the probe window — a false negative documented after platform switches / reloads (GH #59 #9) — the probe returns `none` and setup injects the fetch/XHR hook **without disabling the still-enabled Network domain**. Both paths then capture every request (CDP numeric-id entries + hook UUID-id entries), and the existing exact-id dedup can't collapse them because the two id schemes never collide.

Fix: when setup falls back to the hook, it now disables the CDP Network domain first, so the hook is the single capture source. This also makes `cdp_status`'s `networkDomain: false` truthful instead of a label over a still-running domain — the "capability flag out of sync" symptom in the report was the same root cause. Read-time fuzzy dedup was deliberately rejected: it would collapse legitimately-identical rapid requests (a real double-mutation) and hide bugs — the opposite of what the reporter needed.
