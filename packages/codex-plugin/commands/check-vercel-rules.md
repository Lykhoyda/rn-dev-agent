---
command: check-vercel-rules
description: Run the packaged Vercel Labs agent-skills rule audit on the current project.
argument-hint: "[--all | --ci | --baseline-snapshot] [--format hook|json|sarif]"
---

# Check Vercel rules

Treat the text after `$rn-dev-agent:check-vercel-rules` as a conceptual request
and parse it into an argv array. Never pass the raw request through a shell.

Resolve `<package-root>` from the invoking skill's exact `SKILL.md` path and run:

```text
node <package-root>/scripts/check-vercel-rules.mjs <validated argv...>
```

The checker is packaged and works in consumer projects. Do not require an
rn-dev-agent source checkout or cite missing `third_party/` files as the only
rule documentation; packaged rule metadata lives at
`<package-root>/skills/rn-best-practices/rules.index.json`.

## Accepted grammar

- Empty request: pass `--all` explicitly (never wait on stdin).
- One mode: `--changed [files...]`, `--all`, or `--ci`.
- `--baseline-snapshot`.
- `--format hook|json|sarif`.
- `--baseline <path>`, `--no-baseline`, `--max <positive integer>`, `--quiet`.
- `--` ends flags and makes following values changed-file paths.

Reject unknown flags, missing values, conflicting modes, invalid formats, and
non-positive `--max`. Preserve each changed path as one argv element, including
paths with spaces. Baseline snapshot is the workflow's deliberate project write;
show the destination before running it.

## Results

- No violations: report clean scope and mode.
- Violations: report rule ID, file/line, severity, and packaged rule metadata.
- `--ci`: preserve checker exit 1 on violations.
- Other valid modes: preserve their documented exit behavior.
- Exit 2 means invalid arguments; exit 3 means checker failure.

## Examples

```text
$rn-dev-agent:check-vercel-rules
$rn-dev-agent:check-vercel-rules --ci --format sarif
$rn-dev-agent:check-vercel-rules --changed "src/My Screen.tsx"
$rn-dev-agent:check-vercel-rules --baseline-snapshot
```
