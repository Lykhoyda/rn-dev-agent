---
"rn-dev-agent-plugin": minor
---

Agent model upgrades + skill efficiency pass.

**Agents**: all agents now run on `opus` (rn-tester, rn-code-explorer, rn-code-reviewer up from sonnet; rn-debugger unchanged); `rn-code-architect` moves to `fable` — the top model tier for the pipeline's single deep-reasoning blueprint step. Model-tier prose synced in the router skill and docs-site.

**Skills** (token efficiency + correctness, verified by a confined-subagent retrieval test):

- `rn-feature-development` 5,076 → ~3,960 words (−22%): Phase 8 no longer duplicates the proof protocol — `commands/proof-capture.md` is the single source of truth, with pipeline deltas (architect's flow table as source, persist-as-action via creating-actions Steps 3–6, `cdp_run_action` smoke-test, Deviations section) listed on top; 8 repeated per-phase evaluator lines collapsed into one core principle; description rewritten trigger-only (a workflow-summarizing description makes the body get skipped).
- `using-rn-dev-agent` (always loaded at session start) 2,065 → ~1,825 words: HELPERS_NOT_INJECTED recovery protocol moved to `rn-debugging` (its natural home) with a routing pointer left behind; stale surface counts fixed (76 MCP tools / 14 commands).
- `rn-testing`: M7 header section slimmed to a 5-key table + creating-actions pointer (the full glossary lives there) — same heading kept for existing citations.
- `rn-best-practices` / `rn-setup`: descriptions rewritten trigger-only (dropped the rot-prone rule-count inventory; added concrete failure-phrase triggers).
- Stale claims fixed everywhere: `maestro_run`/`cdp_run_action` DO forward `params` since #272 (proof-capture + feature-dev said otherwise); broken section citation in `run-action.md`; dangling "Step 1.4" cross-references from the old inline Phase 8; smoke-test now consistently `cdp_run_action` (RunRecord + auto-promotion) with plain `maestro_run` reserved for the on-camera replay.
