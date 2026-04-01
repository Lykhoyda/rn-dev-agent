---
command: rn-agent-import
description: Import an experience bundle from a teammate or another project. Validates format, checks for contradictions, adds heuristics at 70% confidence.
allowed-tools: Bash, Read, Write
---

# Experience Import

Import an exported experience bundle into your local experience store.

## Usage

Provide the path to an export YAML file:

```
/rn-dev-agent:rn-agent-import ~/.claude/rn-agent/exports/export-2026-03-31.yaml
```

## What Happens

1. **Validates** the bundle format (version, heuristics array)
2. **Checks** for duplicates against existing experience (by summary text)
3. **Adds** new heuristics with **70% of original confidence** (imported knowledge is less trusted)
4. **Marks** imported entries with source attribution and original date
5. **Skips** heuristics below 20% effective confidence

## Import Rules

- Imported heuristics are marked with `RS-I*` or `FP-I*` prefix
- Duplicates (same summary text) are silently skipped
- Confidence is reduced to 70% of the exported value
- No heuristics are auto-promoted — all stay in experience.md for review
