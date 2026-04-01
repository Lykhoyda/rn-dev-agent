---
command: rn-agent-export
description: Export anonymized experience bundle for sharing across projects or team members. Strips paths, secrets, PII. Outputs YAML to ~/.claude/rn-agent/exports/.
allowed-tools: Bash, Read
---

# Experience Export

Export your accumulated experience as an anonymized YAML bundle.

## What Gets Exported

| Data | Included | Anonymized |
|------|----------|------------|
| Heuristic summaries | Yes | Paths/secrets redacted |
| Confidence scores | Yes | As-is |
| Environment fingerprint | Yes | Coarsened (major.minor only) |
| Failure statistics | Yes | Normalized errors only |
| Raw telemetry | No | Never exported |
| Candidate files | No | Not included |

## Output

Written to `~/.claude/rn-agent/exports/export-<timestamp>.yaml`.

Share this file with teammates or across projects. Import with `/rn-dev-agent:rn-agent-import <path>`.

## Privacy

- All summaries pass through the redaction module (secrets, PII, paths stripped)
- Environment versions coarsened to major.minor
- No raw telemetry, no project names, no file paths
