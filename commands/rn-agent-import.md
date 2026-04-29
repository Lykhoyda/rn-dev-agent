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

1. **Validates** the bundle format (version, heuristics array, optional flows + skeleton sections)
2. **Checks** for duplicates against existing experience (by summary text)
3. **Adds** new heuristics with **70% of original confidence** (imported knowledge is less trusted)
4. **Marks** imported entries with source attribution and original date
5. **Skips** heuristics below 20% effective confidence
6. **Imports flows + skeleton** (default ON) into `<test-app>/.maestro/flows/`
   and `<test-app>/.ui-skeleton.yaml`. Existing flows with the same `id:`
   are NOT overwritten — they land at `<id>.imported.yaml` so you can diff
   and merge manually. Pass `--no-flows` / `--no-skeleton` to skip these.

## Import Rules

- Imported heuristics are marked with `RS-I*` or `FP-I*` prefix
- Duplicates (same summary text) are silently skipped
- Confidence is reduced to 70% of the exported value
- No heuristics are auto-promoted — all stay in experience.md for review
- Imported flows keep their metadata header but `status:` is forced to
  `experimental` until you replay them locally and bump it to `active`.
- The bundled `appId: com.example.<slug>` line is rewritten to your
  project's actual `appId` (read from `app.json` / `Info.plist`) on
  import. If the bundle's `${VAR}` placeholders reference variables
  unknown to your test-app, the flow lands at `*.needs-review.yaml`.
