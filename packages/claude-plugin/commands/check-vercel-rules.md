---
command: check-vercel-rules
description: Run the Vercel Labs agent-skills rule audit on the current project. Default scans changed files; pass --all for full project, --ci for CI-mode (exits 1 on violations).
argument-hint: "[--all | --ci | --baseline-snapshot] [--format hook|json|sarif]"
allowed-tools: Bash, Read
---

Run the Vercel rule audit: $ARGUMENTS

## Why this command exists

The PostToolUse audit hook (`hooks/vercel-rules-audit.sh`) checks rules on
single-file edits during a session. This command runs the same checker
across a broader scope — the whole project, just changed files, or for
CI/pre-ship gating — and emits the chosen output format.

It wraps `scripts/check-vercel-rules.mjs`. Same checker, three call sites:
- PostToolUse hook (per edit, automatic)
- This slash command (manual, project-scoped)
- pre-ship-checker integration (CI, blocks on violations)

## Modes

| Argument | Behavior |
|---|---|
| (none) | `--all` walk of cwd; reports violations; exit 0 |
| `--changed [files...]` | Check only specified files (or stdin one-per-line) |
| `--all` | Walk cwd for `.tsx/.jsx/.ts/.js`; max 200 files |
| `--ci` | Same as `--all` but exits 1 on any violation (use in pre-commit/CI) |
| `--baseline-snapshot` | Write current violations to baseline path; exit 0 |
| `--format hook\|json\|sarif` | Output shape (default `hook`) |

## Run

```bash
# Default: --all on cwd, hook-format output
if [[ -z "$ARGUMENTS" ]]; then
  node "${CLAUDE_PLUGIN_ROOT}/scripts/check-vercel-rules.mjs" --all
else
  node "${CLAUDE_PLUGIN_ROOT}/scripts/check-vercel-rules.mjs" $ARGUMENTS
fi
```

## After the run

- **No violations** → no output. The repo is clean against the v1.0
  grep-checker subset.
- **Violations reported** → each line cites a rule ID and points to the
  upstream rule file under `third_party/vercel-labs/agent-skills/skills/...`
  for the full explanation + fix.
- **Want to suppress legacy violations?** Run
  `/rn-dev-agent:check-vercel-rules --baseline-snapshot` to snapshot the
  current set; subsequent runs (and the PostToolUse hook) will only report
  NEW violations. Critical for retrofit on existing codebases.
- **Want SARIF for GitHub code-scanning?** Use `--format sarif`; the output
  conforms to SARIF 2.1.0 and uploads cleanly to the Code Scanning API.

## Reference

- Spec: `docs/superpowers/specs/2026-05-07-vercel-skills-integration-design.md`
- v1.0 checker scope (3 grep rules): `skills/rn-best-practices/SKILL.md` §
  Verification surface
- Full rule corpus: `skills/rn-best-practices/rules.index.json` (118 rules)
- Upstream content: `third_party/vercel-labs/agent-skills/`
