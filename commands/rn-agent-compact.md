---
command: rn-agent-compact
description: Compact the Experience Engine — scan telemetry, generate candidates, auto-promote ghost recoveries, decay stale heuristics. Run periodically or after a batch of feature development sessions.
allowed-tools: Bash, Read, Write
---

# Experience Engine Compaction

Run the compaction cycle for the rn-dev-agent Experience Engine.

## What This Does

1. **Scans** all telemetry JSONL files in `~/.claude/rn-agent/telemetry/`
2. **Groups** failures by (tool + normalized error signature)
3. **Generates candidates** for patterns seen >= 3 times with >= 67% recovery success
4. **Auto-promotes** ghost recovery shortcuts to `~/.claude/rn-agent/experience.md`
   (only machine-verifiable recoveries — ghost successes with high success rate)
5. **Writes candidates** for human review to `~/.claude/rn-agent/candidates/`
6. **Decays** stale heuristics in experience.md (not triggered in 20+ runs → -20% confidence)
7. **Removes** dead heuristics (confidence < 30%)

## How to Run

This command is invoked programmatically via the MCP server's `runCompactionCycle()` function.
To run manually, use the MCP tools to call the compaction endpoint.

## Promotion Rules

| Destination | Gate | Criteria |
|-------------|------|----------|
| `~/.claude/rn-agent/experience.md` | **Auto** | Ghost recovery with >= 67% success rate over >= 3 occurrences |
| `~/.claude/rn-agent/candidates/*.md` | **Human review** | All other patterns — failure patterns, non-ghost recoveries |
| `<project>/.rn-agent-experience.md` | **Manual** | User copies from candidates after review |

## Output

Reports a summary table:

| Metric | Value |
|--------|-------|
| Telemetry files scanned | N |
| Events processed | N |
| Failure groups found | N |
| Candidates generated | N |
| Auto-promoted | N |
| Heuristics decayed | N |
| Heuristics removed | N |
| Experience token usage | N / 2000 |

## When to Run

- After completing a batch of `rn-feature-dev` sessions (5-10 runs)
- When `~/.claude/rn-agent/telemetry/` grows large
- Before sharing project experience (to get latest patterns)
- Periodically (weekly or biweekly)

## Files Affected

- **Reads:** `~/.claude/rn-agent/telemetry/*.jsonl`
- **Reads/Writes:** `~/.claude/rn-agent/experience.md`
- **Writes:** `~/.claude/rn-agent/candidates/*.md`
