---
'rn-dev-agent-cdp': patch
'rn-dev-agent-plugin': patch
---

Observe UI: surface the idb install hint as a banner under the device pane header while mirroring runs on the ~6fps simctl fallback, instead of an ellipsized footer line that truncated the brew command. Error hints stay in the footer. The idb install command is corrected everywhere to include the required tap (`brew tap facebook/fb && brew install idb-companion`) — including the executed installs in `ensure-idb.sh` / `ensure-idb-companion.sh`, which previously failed on untapped machines. `/rn-dev-agent:setup` now diffs an already-injected CLAUDE.md template block against the plugin's current CLAUDE-MD-TEMPLATE.md and offers an in-place refresh when stale (new `<!-- rn-dev-agent:template-end -->` sentinel delimits the block; legacy blocks are upgraded on refresh).
