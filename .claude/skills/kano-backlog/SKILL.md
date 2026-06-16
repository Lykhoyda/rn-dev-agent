---
name: kano-backlog
description: >-
  Prioritize and refine a GitHub Issues backlog with the Kano model — categorize
  every open issue as Must-be, Performance, Attractive, Indifferent, or Reverse,
  apply Kano + priority labels back to GitHub automatically, and recommend the
  single best next issue to pick up. Use this whenever the user wants to triage,
  groom, or refine a backlog, decide what to build/work on next, prioritize
  issues or features, or run a Kano analysis. Triggers on "refine the backlog",
  "groom the backlog", "what should I work on next", "what should I build next",
  "which issue should I pick", "prioritize these issues", "triage my issues",
  "Kano model", "Kano analysis", "select the next issue" — even if the user
  never says the word "Kano". This operates on an existing backlog of many open
  issues; it is not for creating a single issue, closing/commenting on one issue,
  checking an issue's status, or manually labeling a fixed range of issues.
---

# Kano Backlog Refinement (GitHub Issues)

Turn a noisy GitHub Issues backlog into a Kano-prioritized plan and a single,
defensible "do this next" pick. The Kano model is the right lens because backlog
priority is not one-dimensional: an unmet **Must-be** (a bug, a broken basic)
quietly burns satisfaction every day, while an **Attractive** delighter costs
nothing when absent. Sorting by Kano category before sorting by votes or age
prevents the classic failure of shipping shiny features on top of broken basics.

Read `references/kano-model.md` for the five categories, the functional/
dysfunctional question pair, the full evaluation table, and the heuristic signals.
Load it before categorizing — the body below assumes you know the categories.

## When to use

The user wants to know what to work on next, wants the backlog cleaned up /
groomed / refined / triaged, wants issues prioritized, or names the Kano model.
You operate on **GitHub Issues** via the `gh` CLI.

## What this skill does and does not change

Write-back is **automatic** (no confirmation prompt) but deliberately scoped to
**additive, reversible** edits:

- ✅ Auto-applied: `kano:*` category labels and `priority:now|next|later` labels.
- ⚠️ Recommended, never auto-done: **closing** issues (e.g. Reverse or stale
  Indifferent items) and editing/deleting issue bodies. Closing is hard to
  reverse and signals intent to a human audience, so surface it as a recommended
  action with rationale and let the user run it. This boundary holds even though
  the user opted into "fully automatic" — automation covers labeling, not
  destructive or outward-facing actions.

Every label change is logged in the final report so the run is auditable.

## Workflow

### 1. Resolve the target repo

Confirm which repo's backlog you're refining before touching anything — labeling
the wrong repo is annoying to undo.

- If the user named a repo, use `--repo owner/name` on every `gh` call.
- Otherwise detect the current one: `gh repo view --json nameWithOwner -q .nameWithOwner`.
- State the resolved repo in your first message ("Refining the backlog for
  `owner/name`…") so a wrong target is caught immediately.

Honor any scope the user gives — a label filter, a milestone, "just the bugs",
a maximum count. Pass it through to the fetch.

### 2. Fetch the backlog

Run the bundled fetch helper (it selects exactly the fields you need):

```bash
bash scripts/fetch_backlog.sh --repo owner/name --limit 100
# optional: --label area/api   --search "milestone:v2"
```

It returns a JSON array of open issues with `number`, `title`, `body`, `labels`,
`createdAt`, `updatedAt`, `comments`, `reactionGroups`, `assignees`, `milestone`.
If the backlog is large, agree on a scope (a label, a milestone, top N by recent
activity) rather than silently truncating — and say what you scoped to.

### 3. Categorize each issue (Kano, heuristic)

For each issue, reason about the **pair** of Kano questions before reaching for
keywords:

> If this shipped and worked well, how would users feel? → functional answer
> If this never ships / stays broken, how would users feel? → dysfunctional answer

Map the pair through the evaluation table in `references/kano-model.md` to get the
category (M / O / A / I / R / Q). Use the heuristic signals there to estimate the
answers — bugs and broken basics lean Must-be, "faster/more/cheaper" leans
Performance, novel/unexpected upside leans Attractive, internal-only or
zero-engagement leans Indifferent, forced/intrusive/option-removing leans Reverse.

Record per issue: **category**, a one-line **rationale** tied to the question
pair, a **confidence** (high/med/low), and a **demand signal** (reactions +
comments + age). Flag low-confidence or mixed-scope issues as Questionable rather
than guessing — those want a clarifying comment, not a confident label.

### 4. Rank into a refined backlog

Kano gives the tier; demand and effort order issues within it. Apply the
prioritization policy from the reference:

1. **Unmet Must-be** → `priority:now`. Active dissatisfaction; clear first.
2. **Performance** by value/effort (demand ÷ effort) → top of the list go `now`,
   the rest `next`.
3. **1–2 Attractive** bets for differentiation → `next`; the remainder `later`.
4. **Indifferent** → `later`, or recommend closing if stale and not unblocking
   anything. If it *does* unblock a higher tier, say so and keep it.
5. **Reverse** → no priority label; recommend "make optional / scope down / close
   with rationale".

Use `effort:*` / `size:*` / `SP:*` labels when present; otherwise infer scope
from the description and say it's an estimate.

### 5. Write back the labels (automatic)

Ensure the label set exists, then apply categories and priorities. The label
helper is idempotent (`gh label create --force` updates color/description in place):

```bash
bash scripts/ensure_labels.sh --repo owner/name
```

Then per issue (additive — swap any prior `kano:*`/`priority:*` so an issue never
carries two conflicting tiers):

```bash
gh issue edit <num> --repo owner/name \
  --add-label "kano:performance" --add-label "priority:next" \
  --remove-label "priority:later"
```

Apply in a loop over your ranked list. Keep a running log of `#num → category,
priority` for the report. If a `gh` call fails (permissions, missing label),
note it and continue — don't abort the whole run over one issue.

### 6. Select the next issue

Recommend exactly one issue to pick up next, with reasoning. The default winner is
the **highest-impact unmet Must-be that is unblocked and reasonably sized**. If no
Must-be is outstanding, take the top Performance item by value/effort. Only lead
with an Attractive item when basics and performance are genuinely in good shape —
and say why.

The pick must be **actionable now**: not blocked, not already assigned/in-progress
(unless the user asked about their own in-flight work), and scoped enough to start.
If the best-by-Kano item is blocked, name the blocker and pick the best unblocked
alternative instead.

### 7. Report

Use this structure:

```
## Backlog refinement — owner/name (N issues)

### 🎯 Next pick: #<num> <title>
Kano: <category> · Priority: now · Effort: <est> · Demand: <signal>
Why: <2–3 sentences tying the Kano reasoning + readiness to the recommendation>
First steps: <1–3 concrete starting actions>

### Refined backlog
| # | Title | Kano | Conf | Demand | Effort | Priority | Action |
|---|-------|------|------|--------|--------|----------|--------|
| … | …     | M/O/A/I/R | H/M/L | 👍12 💬4 | S/M/L | now/next/later | label / recommend-close |

### Labels applied
- #12 → kano:must-be, priority:now
- #34 → kano:attractive, priority:later  (…)

### Recommended manual actions (not auto-applied)
- Close #56 (Reverse: forces a flow users rely on opting out of) — rationale + suggested comment
- Clarify #78 (Questionable: mixes two features) — suggested clarifying question
```

Keep rationales tied to *why* a category was chosen (the question pair), not just
the label. That's what makes the refinement defensible to a human.

## Categorization examples

**Example 1 — Must-be**
Input: "#101 Login fails with 500 for SSO users since Tuesday's deploy."
Reasoning: present→users *expect* working login; absent→users *dislike* it
strongly. Expect × Dislike → **Must-be**. Priority: now. It's a regression on a
basic — top of the list.

**Example 2 — Performance**
Input: "#102 Search takes 4–6s; please make results return faster."
Reasoning: faster is *liked*, slower is *disliked*, and satisfaction scales with
the metric. Like × Dislike → **Performance (O)**. Rank by latency-pain ÷ effort.

**Example 3 — Attractive**
Input: "#103 Would be cool to auto-generate a weekly summary email with AI."
Reasoning: present→*like* (novel, unexpected); absent→*neutral* (nobody expects
it yet). Like × Neutral → **Attractive (A)**. Worth one bet, not the whole cycle.

**Example 4 — Indifferent / Reverse**
Input: "#104 Rename internal `UtilHelper` class to `Helpers`." → no user-visible
effect, no demand → **Indifferent**; `later` or close unless it unblocks work.
Input: "#105 Force all users into the new onboarding, remove the skip button." →
removing an option many rely on → **Reverse**; recommend making it skippable
rather than shipping as written.

## Notes

- This skill never closes, deletes, or edits issue bodies on its own. Those are
  recommended actions for a human.
- If `gh` isn't authenticated (`gh auth status` fails), stop and tell the user to
  run `gh auth login` rather than guessing.
- Re-running is safe: labels are idempotent and priorities are recomputed each run,
  so the skill doubles as ongoing grooming, not a one-shot.
