---
command: rn-agent-health
description: Show Experience Engine health — telemetry size, heuristic stats, confidence distribution, candidate backlog, token usage.
allowed-tools: Bash, Read
---

# Experience Health Dashboard

Display the current state of the Experience Engine.

## Output Table

| Category | Metric | Description |
|----------|--------|-------------|
| **Telemetry** | Files | Number of JSONL session files |
| | Size | Total disk usage |
| | Events | Total recorded events |
| | Date range | Oldest → newest file |
| **Heuristics** | Total | Active heuristics loaded |
| | By source | seed / project / user / imported breakdown |
| | By type | failure_pattern / recovery_shortcut / platform_quirk / expo_gotcha |
| | Confidence | High (>=80) / Medium (50-79) / Low (20-49) |
| **Candidates** | Pending | Awaiting human review |
| | Oldest | Longest-waiting candidate |
| **Budget** | Tokens | Current / 2000 max |
| **Knowledge** | Families | Loaded failure families from seed |
| | Recoveries | Loaded recovery sequences |

## When to Use

- After `/rn-dev-agent:rn-agent-compact` to verify results
- To check if telemetry is growing too large
- To see how many candidates are waiting for review
- To monitor confidence distribution (too many "low" = stale experience)
