---
command: end-session
description: Wrap up the work session — log decisions to DECISIONS.md, bugs to BUGS.md, findings + a dated narrative to ROADMAP.md (in the sibling rn-dev-agent-workspace), then run a git/changeset hygiene check. Appends only; never deletes or rewrites existing entries; never commits.
argument-hint: [optional focus or extra notes to weave in]
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# /end-session — session wrap-up

A maintainer ritual for **this repo** (`claude-react-native-dev-plugin`). It distills
what happened this session into the project's living docs, then flags anything left
undone. The docs live in the **sibling workspace repo**, per the project `CLAUDE.md`:

| Doc | Path | What goes here |
|---|---|---|
| Roadmap | `../rn-dev-agent-workspace/docs/ROADMAP.md` | A dated narrative: what shipped, what's in flight, what's next, key findings |
| Decisions | `../rn-dev-agent-workspace/docs/DECISIONS.md` | Architectural decisions as `Dxxxx` ADRs |
| Bugs | `../rn-dev-agent-workspace/docs/BUGS.md` | Defects discovered/fixed as `Bxxxx` entries |

`$ARGUMENTS` (if present) is an explicit focus or note from the maintainer — weave it in;
it does not replace your own reconstruction of the session.

## Iron rules

1. **Append only.** Never delete, reorder, or rewrite existing entries (this honors the
   standing "never delete md files" instruction). You add new entries and, for a bug that
   got fixed this session, append its `Fix` block / move it to the Fixed section — you do
   not edit history.
2. **Never fabricate.** If the session produced no new decisions, write nothing to
   DECISIONS.md. Same for bugs. An empty doc update is the correct output when nothing
   qualifies — say so in the summary. Only ROADMAP always gets an entry (the session
   itself is the news).
3. **Never commit.** You write the files and report. The maintainer reviews and commits.
   (The workspace is a separate git repo; its commits are theirs to make.)
4. **Continue the sequence.** IDs are monotonic. Read the current max `Dxxxx` / `Bxxxx`
   before writing and increment from there — do not reuse or guess.
5. **Match the house format** of each doc exactly (see the templates below). Use today's
   date from `date +%F`, never a guessed date.

## Procedure

### Step 0 — Preconditions
- `WS=../rn-dev-agent-workspace/docs`. Confirm `$WS/ROADMAP.md`, `$WS/DECISIONS.md`,
  `$WS/BUGS.md` all exist. If the workspace is missing, **stop** and tell the maintainer
  — do **not** create these files inside the plugin repo (that's the "two test-apps"
  class of mistake the project `CLAUDE.md` warns about).

### Step 1 — Gather evidence (don't rely on memory alone)
Run these and read the output before writing anything:
- `date +%F` → today's date for the entries.
- This repo: `git -C . log --oneline -25` and `git -C . status --short` and
  `git -C . branch --show-current`.
- Workspace: `git -C ../rn-dev-agent-workspace log --oneline -15` and
  `git -C ../rn-dev-agent-workspace status --short`.
- Current max IDs:
  - `grep -oE '### D[0-9]+' "$WS/DECISIONS.md" | grep -oE '[0-9]+' | sort -n | tail -1`
  - `grep -oE '### B[0-9]+' "$WS/BUGS.md" | grep -oE '[0-9]+' | sort -n | tail -1`
- Then reconstruct from THIS conversation: what was built/changed, which choices were
  architectural (→ ADR), which were defects (→ bug), which were noteworthy observations
  (→ findings in the roadmap entry).

### Step 2 — DECISIONS.md (only if there were architectural decisions)
For each new decision, append a block at the end, continuing the `Dxxxx` sequence:

```markdown
### D<next>: <imperative one-line title>

**Context.** <what forced the decision; the constraint or surprise>

**Decision.** <what was chosen; alternatives considered and why rejected>

**Lesson.** <the durable, transferable takeaway — optional but valued in this repo>

**Refs.** <GH #, PR #, commit SHAs, files touched, related Dxxxx/Bxxxx>
```

### Step 3 — BUGS.md (only if defects were found or fixed)
New defect → append under the relevant section continuing the `Bxxxx` sequence:

```markdown
### B<next>: <one-line symptom> (<Open | Fixed — YYYY-MM-DD>)

**Observed.** <how it showed up; repro if known>

**Fix.** <what resolved it, or "Proposed fix." if still open>

**Refs.** <GH #, PR #, commit SHAs, files, related Dxxxx/Bxxxx>
```
If a previously-Open bug was fixed this session, append a `Fix.` block to it (don't rewrite
the original Observed text).

### Step 4 — ROADMAP.md (always)
Append a dated section at the end:

```markdown
## <YYYY-MM-DD> — <session title>

<1–3 sentence framing: what the session was about and why it mattered.>

**Shipped.** <bullet or prose list of what landed — commits, files, behavior changes.>

**Findings.** <noteworthy observations that aren't ADRs or bugs — perf numbers,
gotchas, things to watch. Omit the heading if there were none.>

**Process.** <how the work was done if notable — TDD, multi-agent review, brainstorm.>

**Forward.** <what's still open / next — carry forward unfinished items from the prior
entry's Forward block that are still open.>

**Refs.** <Dxxxx/Bxxxx created this session, GH #, PR #.>
```

### Step 5 — Hygiene check (report, don't fix)
- Uncommitted work: surface `git status --short` for **both** repos (the plugin repo and
  the workspace, including the docs you just wrote).
- Changeset gate: if `scripts/cdp-bridge/src/` changed this session (`git diff --name-only`
  against the branch base), confirm a `.changeset/*.md` exists. If shippable src changed
  with no changeset, **flag it** — the `require-changeset` CI job will fail the PR.
- Branch: note the current branch and whether it's ahead of `main` / has an open PR.

### Step 6 — Summarize
Print a compact report:
- Which docs were updated and the new IDs assigned (e.g. "DECISIONS +D1229, D1230; BUGS
  +B162; ROADMAP +2026-05-31 entry").
- The hygiene flags (uncommitted files, missing changeset, branch state).
- An explicit reminder that **nothing was committed** — list the exact files the
  maintainer should review and commit, in both repos.

Keep the final report short; the value is in the doc updates, not the recap.
