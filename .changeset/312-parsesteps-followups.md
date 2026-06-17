---
"rn-dev-agent-plugin": patch
---

Fix #312: harden the Maestro step-line parser (`maestro-step-parser.ts`), which structures `maestro_run` results from the runner's untrusted combined stdout+stderr.

- **B211** — cap the `verb` field to `MAX_FIELD`; previously only `name` was bounded, so a step-shaped line with a multi-KB first token could bloat the MCP response across up to 1000 steps.
- **B212** — anchor `parseSteps` on the runner's leading indentation (horizontal-whitespace-only `^[ \t]+`, matched against the un-trimmed line) so an unindented (column-0) app-log line shaped like `✓/✗ … (N.Ns)` can no longer be mistaken for a step and poison `lastStep`/`failedStep`/the failure headline. `\r`/`\v`/`\f`/NBSP-prefixed lines are rejected too (JS `\s` would have re-admitted them). `parseTapLatencies` (#263) inherits the same hardening.
- A new `combineRunnerOutput(stdout, stderr)` helper joins the streams for parsing without the blanket `.trim()` that would strip the first step line's indent (dropping `launchApp` from `meta.steps`); it uses native `.trimEnd()` to stay linear on multi-MB output.
- Stripped stale review-provenance comments per the repo's no-unnecessary-comments convention.
