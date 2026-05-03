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
| **Reusable actions** (`<test-app>/.rn-agent/actions/*.yaml`) | **Yes (default)** | **`appId` redacted to `com.example.<slug>`; `${VAR}` placeholders preserved** |
| **UI skeleton** (`<test-app>/.rn-agent/skeleton.yaml`) | **Yes (default)** | **`appId` redacted; testID strings preserved (they're already semantic)** |
| Raw telemetry | No | Never exported |
| Candidate files | No | Not included |

Flows + skeleton are bundled by default because they ARE the reusable
actions — the artifact-first protocol relies on them, so a fresh teammate
clone only gets the muscle memory if these travel with the heuristics.
Pass `--no-flows` / `--no-skeleton` to opt out for sensitive bundles.

## Output

Written to `~/.claude/rn-agent/exports/export-<timestamp>.yaml`.

Share this file with teammates or across projects. Import with `/rn-dev-agent:rn-agent-import <path>`.

## Privacy

- All summaries pass through the redaction module (secrets, PII, paths stripped)
- Environment versions coarsened to major.minor
- Flows: `appId:` line replaced with `com.example.<sanitized-slug>`; only
  the metadata header (`id`, `intent`, `tags`, `mutates`, `status`) and
  YAML body are kept. Long author-prose comments above the body are
  truncated to 200 chars.
- Skeleton: same `appId` redaction; testID list preserved verbatim.
- No raw telemetry, no project names, no file paths
