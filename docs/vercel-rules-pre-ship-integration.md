# Pre-ship-checker integration — Vercel rules

How to gate ship-readiness on the Vercel rule audit using the
[claude-code-guide](https://github.com/Lykhoyda/ask-llm) plugin's
`pre-ship-checker` agent.

## TL;DR

Add this single command to your project's pre-ship checklist (or run it
manually before opening a PR):

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PWD}/scripts/check-vercel-rules.mjs" --ci --format hook
```

Exit code 0 = pass. Exit code 1 = at least one CRITICAL or HIGH violation
outside the baseline → ship blocked.

## What this gives you

- **Full-project audit** of every `.tsx/.jsx/.ts/.js` file (max 200) against
  the v1.0 grep checker subset (`no-touchable-new-code`,
  `no-inline-renderitem-literals`, `no-falsy-jsx-and`).
- **Baseline-aware**: pre-existing violations recorded in
  `.rn-agent/vercel-rules-baseline.json` (via
  `node scripts/check-vercel-rules.mjs --baseline-snapshot`) are skipped.
  Only NEW violations introduced by the current change set fail the check.
- **Same checker** as the PostToolUse audit hook + `/check-vercel-rules`
  slash command. No drift between local-edit feedback and ship-gate
  enforcement.

## Wiring into pre-ship-checker

The `pre-ship-checker` agent (from `claude-code-guide` plugin) accepts
project-specific gate commands. Add the Vercel check to its gate list:

```yaml
# Example invocation pattern (pseudo-config; consult pre-ship-checker
# docs in your installed plugin for the exact format):
gates:
  - name: typecheck
    command: tsc --noEmit
  - name: lint
    command: eslint .
  - name: tests
    command: npm test
  - name: vercel-rules
    command: node scripts/check-vercel-rules.mjs --ci
    description: Vercel agent-skills rule audit (3 grep checkers in v1.0)
```

If `pre-ship-checker` doesn't expose a config surface, invoke it manually
in the Phase 7 (Pre-Ship) step of your feature pipeline.

## SARIF for GitHub code-scanning

To upload findings to the GitHub Code Scanning API (e.g., from a GitHub
Action):

```yaml
- name: Vercel rules audit
  run: |
    node scripts/check-vercel-rules.mjs --all --format sarif > vercel-rules.sarif
- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: vercel-rules.sarif
```

Findings appear in the repository's Code Scanning tab, annotated inline
on PRs.

## When to run baseline snapshot

Run once on your main branch when first adopting the audit:

```bash
node scripts/check-vercel-rules.mjs --baseline-snapshot
git add .rn-agent/vercel-rules-baseline.json
git commit -m "chore: snapshot Vercel rule baseline"
```

After that, the snapshot is the floor — every new violation appears in CI
output and blocks the merge gate. Re-run the snapshot only when you
intentionally clear pre-existing debt or after large legacy refactors.

## Limits in v1.0

The v1.0 checker uses 3 grep-pattern rules; semantic rules in the full
118-rule corpus are caught by LLM review (`rn-code-reviewer` agent), not
the deterministic check. v1.1 will ship `eslint-plugin-rn-dev-agent`
extending coverage to 5-8 AST-grade checks.

## Reference

- Spec: `docs/superpowers/specs/2026-05-07-vercel-skills-integration-design.md`
- Checker: `scripts/check-vercel-rules.mjs`
- Hook: `hooks/vercel-rules-audit.sh` (PostToolUse — runs per edit)
- Slash command: `/rn-dev-agent:check-vercel-rules` (manual full-project audit)
- Rule index: `skills/rn-best-practices/rules.index.json` (118 rules)
- Upstream: https://github.com/vercel-labs/agent-skills
