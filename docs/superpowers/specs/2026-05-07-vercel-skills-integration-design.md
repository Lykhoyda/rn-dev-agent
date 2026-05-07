# Vercel Labs agent-skills integration — design

**Status:** Draft (awaiting user review)
**Date:** 2026-05-07
**Plugin baseline:** v0.44.26 (post-hotfix #131 merged)
**Author of this spec:** Claude (Opus 4.7) via `superpowers:brainstorming` flow with multi-LLM brainstorm input from Codex; Gemini failed twice (HTTP 429 quota)

---

## 1. Problem

The plugin currently ships a curated `skills/rn-best-practices/` skill that mixes 43 rules vendored once from [`vercel-labs/agent-skills`](https://github.com/vercel-labs/agent-skills) (MIT) with 4 rn-dev-agent custom rules. Vendored content has never been refreshed, the upstream has evolved, and the integration has three structural problems:

1. **Mixed authorship in one folder** — sync is impossible without losing the 4 custom rules.
2. **Reference-only consumption** — Claude can read the skill but is not required to consult it before writing code.
3. **No verification surface** — there is no deterministic check that produced code complies with the rules; LLM review is recall, not enforcement.

The user's directive: make the three Vercel skills (`react-best-practices`, `composition-patterns`, `react-native-skills`) the **core way** of developing React/RN code in the plugin, with strong guarantees that produced code does not violate the rules.

## 2. Constraints (verbatim from user, paraphrased)

1. **Keep upstream as-is** — vendored Vercel content must be byte-identical to upstream; we are not maintainers and must not edit it.
2. **Adjust only for our tools** — plugin-specific adapter (CDP tools, agent prompts, hook integrations) must be layered separately from upstream.
3. **Easy refresh** — must be a one-command path to pull new upstream versions without touching adapter code.
4. **Offline-capable** — plugin runs in CDP-only environments; vendored content must ship with the plugin (no runtime fetch).

## 3. Non-goals

- **Not a fork.** We mirror upstream verbatim; we do not propose changes to Vercel.
- **Not full ESLint coverage.** We ship a narrow subset (~5-8 rules) of AST-checkable Vercel rules. Semantic rules stay in LLM-review territory.
- **Not a replacement for `rn-feature-dev`'s 8-phase pipeline.** We add gates within it.
- **Not retroactive enforcement.** Existing user codebases get a `--baseline-snapshot` mode so legacy violations don't drown the signal.
- **Not telemetry.** Local JSONL only; no network calls, no opt-in surveys, no metrics phoning home.

## 4. Architecture

Two layers separated by directory boundary:

```
claude-react-native-dev-plugin/
├── skills/
│   └── rn-best-practices/                       ← only Claude-facing skill
│       ├── SKILL.md                              ← procedural adapter
│       ├── rules.index.json                      ← generated routing surface (~5KB)
│       └── references/
│           └── rn-dev-agent/                     ← 4 custom rules + tool-bindings
│               └── *.md
│
├── third_party/                                  ← invisible to Claude skill loader
│   └── vercel-labs/
│       └── agent-skills/
│           ├── skills/
│           │   ├── react-best-practices/         ← upstream verbatim, sync-managed
│           │   ├── composition-patterns/
│           │   └── react-native-skills/
│           ├── UPSTREAM.lock.json                ← {sha, syncedAt, per-file SHA-256}
│           └── LICENSE-VENDORED.md               ← MIT text + provenance + missing-file note
│
├── eslint-plugin-rn-dev-agent/                   ← P3, separate package, P0 ships without it
│   ├── package.json
│   ├── src/rules/*.js                            ← 5-8 high-signal AST rules
│   └── src/__tests__/                            ← RuleTester fixtures
│
├── scripts/
│   ├── sync-vercel-skills.mjs                    ← refresh upstream + regenerate rules.index.json
│   ├── check-vercel-rules.mjs                    ← verification CLI: --changed | --all | --ci
│   └── vercel-rules-context.mjs                  ← PreToolUse selection helper
│
├── hooks/
│   ├── vercel-rules-pre-edit.sh                  ← PreToolUse — Selection layer
│   └── vercel-rules-audit.sh                     ← PostToolUse — Verification layer (clones post-edit-health-check.sh skeleton)
│
├── commands/
│   └── check-vercel-rules.md                     ← manual full-project audit slash command
│
└── templates/
    └── rn-agent/
        └── vercel-rules.config.json              ← scaffolded by /setup
```

**Directory invariants:**
- `skills/` — what we author. Anything inside here is Claude-discoverable and may be auto-activated.
- `third_party/` — vendored upstream. Read-only from our side. Sync wipe-and-replaces. **Not** registered in `.claude-plugin/plugin.json` `skills:` array.

**Why `third_party/` (not `skills/vercel-*/`):** Claude Code's skill loader scans `skills/`. Three large mirror dirs there would auto-register, blow the 8KB description budget, and create competing auto-activation surfaces. Hiding them under `third_party/` keeps the adapter as the single Claude-facing skill.

**Why retain `skills/rn-best-practices/` name:** `agents/rn-code-architect.md` and `agents/rn-code-reviewer.md` reference it by name in `skills:` frontmatter. Renaming is a multi-file prose change for cosmetic gain. The skill name is also user-facing in `/help`.

**Why custom rules at `references/rn-dev-agent/`:** Sync targets `third_party/` only. Custom rules live entirely outside the sync surface — they survive every refresh untouched.

## 5. Five-layer enforcement model

Selected tiers: **A-Medium / B-Heavy / C-Heavy**.

**Tier-to-layer mapping** (the user-facing A/B/C maps to implementer-facing 5 layers):
- **A (Activation)** Medium → Layer 1 only.
- **B (Consultation)** Heavy → Layers 2 + 3 (Selection + Application).
- **C (Verification)** Heavy → Layers 4 + 5 (Verification + Remediation/Policy).

### Layer 1 — Activation (Tier: Medium)

How Claude finds the skill.

- `skills/rn-best-practices/SKILL.md` adds frontmatter:
  ```yaml
  paths:
    - "**/*.{ts,tsx,js,jsx}"
    - "**/package.json"
  ```
  This auto-activates on file context regardless of phrasing.
- Existing agent preload retained: `rn-code-architect.md` and `rn-code-reviewer.md` already declare `skills: rn-best-practices`. **Not** added to `rn-debugger`, `rn-code-explorer`, `rn-tester` — they don't write code, only burn tokens.

### Layer 2 — Selection (Tier: Heavy)

Just-in-time per-file rule subset.

- `hooks/vercel-rules-pre-edit.sh` registered as `PreToolUse` for `Edit | MultiEdit | Write`.
- Hook clones the guard skeleton from `hooks/post-edit-health-check.sh` (RN-project detection, debounce, fail-soft).
- Calls `scripts/vercel-rules-context.mjs --file <path> --tool <tool>` which:
  - Reads `skills/rn-best-practices/rules.index.json`
  - Filters by file glob match + keyword scan of the edit content
  - Emits 5-10 matching rules as compact text (cap 1KB) for `additionalContext` injection
- Output format:
  ```
  Rules applicable to <path>:
  - [list-virtualize] CRITICAL: Use a list virtualizer for any list. → third_party/.../rules/list-virtualize.md
  - [stable-list-callbacks] HIGH: Stabilize list item callbacks. → third_party/.../rules/stable-list-callbacks.md
  ...
  ```
- Cap: 1KB per call. Sharded by category — only inject rules whose `triggers` keywords appear in the edit content.

### Layer 3 — Application (Tier: Heavy)

Make Claude required to apply rules during work.

- **`skills/rn-best-practices/SKILL.md` rewritten as a procedure** (not a reference). Per-category procedure block:
  ```markdown
  ## Before writing list rendering code

  1. Query `rules.index.json` filtered by `category: list-performance`
  2. Read every rule with `severity: CRITICAL` (typically 3-5 rules)
  3. Apply rule recommendations
  4. Cite rule ID in code comments only when the choice is non-obvious
  ```
  Six procedure blocks total: list rendering, animations, data fetching, component API design, navigation, image/media.

- **`commands/rn-feature-dev.md` Phase 4 (Architecture) gate:** architect must list rule IDs consulted before approving design.
- **`commands/rn-feature-dev.md` Phase 6 (Quality Review) gate:** reviewer must run `check-vercel-rules.mjs --changed` and report findings.

### Layer 4 — Verification (Tier: Heavy)

Deterministic check that produced code complies.

- **PostToolUse audit hook** `hooks/vercel-rules-audit.sh`:
  - Registered for `Edit | MultiEdit | Write` matching `*.{ts,tsx,js,jsx}`
  - Clones `hooks/post-edit-health-check.sh` skeleton (CDP active, RN project detected, simulator booted, debounce)
  - Runs `scripts/check-vercel-rules.mjs --changed --format hook`
  - Output cap: 1.5KB to `additionalContext` (well under 10KB hook output limit)
  - Default: warn-and-inject (not block — block in `--ci`/pre-commit only)

- **`scripts/check-vercel-rules.mjs`** verification CLI:
  - Run modes: `--changed` (default for hook), `--all`, `--ci`
  - Output formats: `hook` (text for `additionalContext`), `json`, `sarif` (for GitHub code-scanning)
  - Initially uses a small in-house AST checker; later wraps `eslint-plugin-rn-dev-agent` once that lands
  - Reads `.rn-agent/vercel-rules-baseline.json` if present and excludes baseline violations

- **`agents/rn-code-reviewer.md` index-driven lookup:**
  - Replace keyword-trigger lookups with: read `rules.index.json`, filter by changed file's keyword set + `fileGlobs`, read only matched references.
  - Report violations as line-level findings: `[VERCEL/list-virtualize] FlatList has > 5 items but isn't using FlashList — see third_party/.../rules/list-virtualize.md`

### Layer 5 — Remediation/Policy (Tier: Heavy)

What happens when violations are found.

- **Default:** warn-and-inject via PostToolUse hook. Claude sees the violation in context but is not blocked.
- **Block:** only in `--ci` and pre-commit modes. Refuse to ship if any CRITICAL violation outside baseline.
- **Baseline mode:** `.rn-agent/vercel-rules-baseline.json` snapshots existing violations. Run once: `check-vercel-rules.mjs --baseline-snapshot`. Subsequent runs only report NEW violations. Critical for retrofit on existing apps.
- **`/check-vercel-rules` slash command** for manual full-project audits, drives `--ci` mode.
- **`pre-ship-checker` integration** (claude-code-guide plugin's pre-ship-checker agent): refuse to ship if CRITICAL violations exist outside baseline.
- **SARIF output** for GitHub Actions code-scanning integration.

## 6. Sync mechanism

`scripts/sync-vercel-skills.mjs`:

**Invocation:**
- `npm run sync:vercel -- --ref <commit-sha>` — fetch and replace
- `npm run sync:vercel:check` — verifier-only mode, no writes

**Steps:**
1. Validate `--ref` is a commit SHA (no floating `main`).
2. Fetch from `https://raw.githubusercontent.com/vercel-labs/agent-skills/<sha>/skills/<name>/...` for each of 3 skills.
3. Verify upstream shape: `SKILL.md` + `rules/*.md` + optional `AGENTS.md`/`metadata.json` per skill.
4. Verify YAML frontmatter parses; each `SKILL.md` has `name` + `description`.
5. Verify license: top-level `LICENSE` exists upstream (currently fails — see §9 Risk #5).
6. Wipe `third_party/vercel-labs/agent-skills/skills/<name>/` and replace with fetched content.
7. Generate `UPSTREAM.lock.json`: `{ sha, fetchedAt, sourceURL, files: [{ path, sha256, bytes }], ruleCounts: { byCategory, total } }`.
8. Regenerate `skills/rn-best-practices/rules.index.json` from upstream rules + 4 custom rules. Schema:
   ```json
   { "id": "react-native-skills/list-performance-virtualize",
     "title": "Use a list virtualizer for any list",
     "category": "list-performance",
     "platform": "RN",
     "severity": "CRITICAL",
     "confidence": 95,
     "triggers": ["FlatList", "FlashList", "ScrollView"],
     "fileGlobs": ["**/*.{tsx,jsx}"],
     "checkerRule": "rn-dev-agent/no-touchable-new-code",
     "checkable": true,
     "upstream_path": "third_party/.../rules/list-performance-virtualize.md",
     "applicable_when": "any list with > 5 items expected" }
   ```
9. Drift validation: every adapter cross-ref in `SKILL.md` must resolve to an existing upstream file.
10. Rule-count delta gate: fail if upstream changed by >±20% rules unless `--accept-delta` passed.
11. Description-budget guard: total `description` across all 7 plugin skills + adapter ≤ 6KB.
12. CI lockstep validation: `rules.index.json` matches SKILL.md table; `eslint-plugin-rn-dev-agent` rule names match `checkerRule` references; `LICENSE-VENDORED.md` exists.

**Failure modes:**
- Symlink in fetched content → reject (path traversal protection).
- License-file absence on upstream → fail with clear error suggesting `--accept-missing-license-file` (and update LICENSE-VENDORED.md to call out the absence).
- Frontmatter parse failure → fail with line/col info.

## 7. License & attribution

**Status of upstream license:** GitHub sidebar shows MIT (auto-detected from README prose). However, **no top-level `LICENSE` file exists** at `https://github.com/vercel-labs/agent-skills/blob/main/LICENSE` (verified 404 during this brainstorm). This is a real audit-tooling concern.

**Strategy: L1 (proceed with mitigation):**

- **Top-level `LICENSE-VENDORED.md`** at `third_party/vercel-labs/agent-skills/LICENSE-VENDORED.md` containing:
  - Source URL + pinned SHA
  - Declared license: MIT
  - Full MIT license text verbatim
  - Statement that vendored files are unmodified
  - **Explicit note** that upstream's root `LICENSE` file was missing at vendoring time and we have filed an issue requesting its addition
- **Per-vendor-skill `LICENSE` files** copied from upstream IF upstream adds them in future syncs.
- **Do NOT add SPDX headers** to vendored files (would violate Constraint 1: "keep as-is").
- **File issue with vercel-labs** requesting top-level `LICENSE` file; reference the issue URL in `LICENSE-VENDORED.md`.

## 8. Implementation checklist

P0 = ship-or-don't-bother. P1 = recall improvements. P2 = adoption hardening. P3 = ESLint plugin (optional v1.1).

| # | Priority | File | Change | Effort |
|---|---|---|---|---|
| 1 | P0 | `skills/rn-best-practices/SKILL.md` | Add `paths:` frontmatter; rewrite body as procedure (6 category blocks) | 2h |
| 2 | P0 | `skills/rn-best-practices/rules.index.json` | New generated file, 47 entries with full schema | 3h |
| 3 | P0 | `scripts/sync-vercel-skills.mjs` | Vendor sync + index regeneration + drift validation + 12 integrity checks | 4h |
| 4 | P0 | `scripts/check-vercel-rules.mjs` | Verification CLI; hook/json/sarif outputs; baseline mode | 6h |
| 5 | P0 | `hooks/vercel-rules-audit.sh` | Clone `post-edit-health-check.sh` guards, run check-vercel-rules | 2h |
| 6 | P0 | `hooks/hooks.json` | Wire PostToolUse audit | 30m |
| 7 | P0 | `third_party/.../LICENSE-VENDORED.md` | Top-level vendored MIT notice + missing-file note | 30m |
| 8 | P0 | Initial sync run | `npm run sync:vercel -- --ref <pinned-SHA>` populates third_party | 30m |
| 9 | P0 | `skills/rn-best-practices/references/rn-dev-agent/` | Move 4 custom rules from flat references/ to subdir; delete 43 vendored copies | 30m |
| 10 | P1 | `scripts/vercel-rules-context.mjs` | PreToolUse selection helper | 3h |
| 11 | P1 | `hooks/vercel-rules-pre-edit.sh` | Wraps `vercel-rules-context.mjs` with guards | 2h |
| 12 | P1 | `hooks/hooks.json` (PreToolUse) | Wire PreToolUse selection | 30m |
| 13 | P1 | `agents/rn-code-reviewer.md` | Index-driven lookup; consume hook findings; report rule IDs | 2h |
| 14 | P1 | `agents/rn-code-architect.md` | Reference index for design-time rule consultation; Phase 4 gate | 1h |
| 15 | P1 | `commands/rn-feature-dev.md` | Phase 4 + Phase 6 rule gates | 1h |
| 16 | P2 | `commands/check-vercel-rules.md` | New slash command for manual full audits | 1h |
| 17 | P2 | `templates/rn-agent/vercel-rules.config.json` | Default config template scaffolded by `/setup`. Schema: `{ enabledCategories: string[] \| "all", severityOverrides: { [ruleId]: "warn" \| "error" \| "off" }, baselinePath: string }` | 1h |
| 18 | P2 | `commands/setup.md` | Scaffold `vercel-rules.config.json` + `vercel-rules-baseline.json` placeholder | 30m |
| 19 | P2 | `commands/doctor.md` | Add row checking vendored content presence + sync freshness | 30m |
| 20 | P2 | `pre-ship-checker` integration docs | How to call check-vercel-rules from pre-ship-checker; refuse on CRITICAL outside baseline | 1h |
| 21 | P3 | `eslint-plugin-rn-dev-agent/` (new package) | 5-8 high-signal rules + RuleTester fixtures | 12-16h |
| 22 | P3 | `scripts/check-vercel-rules.mjs` (update) | Wrap eslint-plugin-rn-dev-agent | 2h |
| 23 | All | Tests for hook scripts + checker | Unit tests in cdp-bridge style | 4h |
| 24 | All | `.github/workflows/sync-vercel-skills.yml` | Optional: scheduled sync PR every 30 days | 1h |
| 25 | All | Documentation | Update `CLAUDE.md`, `README.md`, agent prompts | 2h |

**Effort totals:**
- **P0 only (v1.0):** ~18h ≈ 2.5 days
- **P0 + P1 + P2 (recommended v1.0):** ~32h ≈ 4 days
- **P0 + P1 + P2 + P3 (full v1.1):** ~50h ≈ 6.5 days

**Phasing:** ship P0+P1+P2 as a single PR for v1.0 (≈4 days). Stack P3 (ESLint plugin) as a separate follow-up PR for v1.1 — reduces blast radius and lets the core enforcement loop prove out before we commit to maintaining a custom ESLint plugin.

## 9. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **AST false positives** flagging static-constant cases (e.g., `<FlatList renderItem={() => …} />` where the lambda is referentially stable in context) | HIGH | MEDIUM | Per-rule `confidence` scoring in `rules.index.json`; default `severity: warn`, `error` opt-in; release with high-confidence rules only |
| 2 | **Alert fatigue** from PostToolUse firing every edit | HIGH | MEDIUM | Debounce (steal pattern from `post-edit-health-check.sh`); only inject changed-violation deltas; 1.5KB cap on hook output |
| 3 | **Sync drift** across 5 truth points (upstream → vendor → index → ESLint plugin → reviewer prompts) | MEDIUM | HIGH | `sync-vercel-skills.mjs` lockstep validation; CI assertion that rules.index.json matches SKILL.md; eslint plugin rule names match `checkerRule` references |
| 4 | **Token noise** from Selection layer injecting on every edit | MEDIUM | MEDIUM | Cap PreToolUse output at 1KB; only inject rules whose `triggers` appear in the edit content; benchmark per-session token tax post-launch |
| 5 | **Upstream LICENSE absence** (verified 404) | MEDIUM (legal exposure) | HIGH if not addressed | Embed full MIT text in `LICENSE-VENDORED.md`; file issue with vercel-labs; sync script fails without LICENSE unless explicit override flag |
| 6 | **React-vs-RN rule conflict** (some `react-best-practices` rules contradict mobile reality) | HIGH | MEDIUM | `rules.index.json` carries `platform` field; adapter declares precedence: RN-specific rules override generic React when both could apply |
| 7 | **ESLint plugin maintenance scope creep** | MEDIUM | LOW (v1.1+ only) | Hard-cap "checkable subset" in plugin README; reject PRs without RuleTester fixtures + ≥90% confidence evidence |
| 8 | **Accidental vendor placement inside `skills/`** auto-registers vendored skills as Claude-discoverable | LOW | HIGH | CI assertion: registered skills in `plugin.json` matches a hand-curated allowlist; vendor paths must NOT be under `skills/` |
| 9 | **Supply chain compromise of upstream** | LOW | HIGH | SHA-pin (no floating `main`); per-file SHA-256 in `UPSTREAM.lock.json`; PR-reviewable diffs |

## 10. Open questions for upstream

To file as issues with `vercel-labs/agent-skills`:

1. **Add a top-level `LICENSE` file** to the repository (currently 404).
2. Confirm the per-rule `.md` file schema (frontmatter fields, conventions) is stable across versions to avoid sync breakage.
3. Confirm acceptable redistribution patterns for downstream marketplaces.

## 11. Migration plan (existing `rn-best-practices/references/` → new structure)

Sequence:
1. Run initial `sync-vercel-skills.mjs` to populate `third_party/vercel-labs/agent-skills/`.
2. Identify the 4 rn-dev-agent custom rules: diff `skills/rn-best-practices/references/*.md` filenames against `third_party/vercel-labs/agent-skills/skills/*/rules/*.md` filenames. Files present in references/ but absent from upstream are the rn-dev-agent custom set.
3. Move those 4 files to `skills/rn-best-practices/references/rn-dev-agent/`.
4. Delete the remaining 43 files from `skills/rn-best-practices/references/` — they now live in `third_party/`.
5. Generate `rules.index.json` from upstream + 4 custom.
6. Rewrite `skills/rn-best-practices/SKILL.md` as procedural adapter.
7. Update agent prompts to point at the new structure.

## 12. Out of scope (this spec)

- **Cross-plugin reuse.** If the `pre-ship-checker` agent or other plugins want to consume `rules.index.json`, that's a future integration.
- **Per-team customization.** No org/team-level rule overrides in v1; users can fork the plugin or maintain a local fork of `rules.index.json`.
- **Auto-fix codemods.** Codex flagged this as P3 future; not in v1.
- **Localized rule descriptions.** Upstream is English-only; we mirror.
- **Web-target React.** Plugin is RN-focused; `react-best-practices` rules apply where they translate, but no web-specific tooling.

## 13. Future work (post-v1)

- **v1.1:** Ship `eslint-plugin-rn-dev-agent` (P3).
- **v1.2:** Codemod migrations (`Touchable*` → `Pressable`, inline `renderItem` → `useCallback`-extracted).
- **v1.3:** Local telemetry JSONL at `.rn-agent/vercel-rules-events.jsonl` for "is enforcement actually working?" measurement.
- **v1.4:** Per-team rule profiles via `.rn-agent/vercel-rules.config.json` `extends:` field.
- **v2.0:** Consider upstreaming our adapter pattern to vercel-labs/agent-skills as a first-class plugin-integration model.

## 14. Acceptance criteria

This spec is ready to convert to an implementation plan when:

- [ ] User has reviewed the full spec and approved the architecture (§4), enforcement model (§5), sync mechanism (§6), and phasing (§8).
- [ ] License strategy in §7 is confirmed (proceed with L1 mitigation; file upstream issue in parallel).
- [ ] Effort totals are accepted (≈4 days for v1.0; ≈6.5 days for v1.0+v1.1).
- [ ] Phasing decision: P0+P1+P2 as one PR vs. multiple smaller PRs.

Once these are confirmed, `superpowers:writing-plans` produces the implementation plan.

---

## Appendix A — Brainstorm provenance

This spec was produced via the `superpowers:brainstorming` flow:

1. **Initial proposal** by Claude (Opus 4.7) based on user constraints.
2. **First multi-LLM brainstorm** (gemini,codex) on architecture — Codex contributed the `third_party/` location insight and `rules.index.json` routing surface; Gemini failed (HTTP 429).
3. **User refinement** — clarified "keep as deps" + "adjust only for tools" constraints.
4. **Second multi-LLM brainstorm** (gemini,codex) on enforcement strategy — Codex contributed the 5-layer factoring (Activation / Selection / Application / Verification / Remediation/Policy), baseline-mode insight, and ESLint subset strategy; Gemini failed again (HTTP 429).
5. **User decision** — A-Medium / B-Heavy / C-Heavy.

Two participants (Claude + Codex) instead of three; Gemini quota appears to have a window longer than 90 minutes. Recommend retrying Gemini in a future session for an additional perspective if the design proves unstable in implementation.
