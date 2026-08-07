---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Report a stale-device release that already committed as a success naming the lost fence, instead of failing the whole call with `AUTHORITY_LOST_DURING_OPERATION` when the authority generation moves on after the commit.
