---
command: end-session
description: Wrap up the work session — log decisions to DECISIONS.md, bugs to BUGS.md, findings + a dated narrative to ROADMAP.md (in the sibling rn-dev-agent-workspace), sync un-filed ROADMAP/BUGS follow-ups to GitHub issues, run Kano backlog refinement, then a git/changeset hygiene check. Docs are append-only and never committed; GitHub issue creation + labels happen only after maintainer confirmation.
argument-hint: [optional focus or extra notes to weave in]
allowed-tools: Bash, Read, Edit, Grep, Glob, Skill
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
   not edit history. **One sanctioned in-place edit:** flipping an entry's status marker
   in its heading (`(Open …)` → `(Fixed — YYYY-MM-DD, PR #N)`, or adding `~~strikethrough~~`)
   is house style, not a rewrite — the body text stays untouched.
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
6. **GitHub mutation is gated.** Creating issues (Step 4.5) and applying Kano labels
   (Step 4.6) are the ONLY outward-facing writes this command makes, and they happen ONLY
   after you present the proposed set and the maintainer confirms. Never auto-create issues
   or relabel without that explicit yes. The "never commit" rule still governs the workspace
   docs — those remain the maintainer's to commit.

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
- GitHub state git can't show: `gh pr list --state merged --limit 10` and
  `gh issue list --state all --limit 15` — PRs merged and issues filed/closed this
  session live here, not in `git log` (issues never; squash-merges only as one line).
- Current max IDs — patterns MUST tolerate `~~strikethrough~~` headers (fixed bugs get
  struck through; a plain `### B[0-9]+` grep misses them and would assign a duplicate ID):
  - `grep -oE '^#{2,4} ~?~?D[0-9]+' "$WS/DECISIONS.md" | grep -oE '[0-9]+' | sort -n | tail -1`
  - `grep -oE '^#{2,4} ~?~?B[0-9]+' "$WS/BUGS.md" | grep -oE '[0-9]+' | sort -n | tail -1`
- Mid-session writes: `git -C ../rn-dev-agent-workspace diff --stat docs/` — if this
  session already wrote doc entries as it went (common in bug-hunt or multi-PR sessions),
  your job in Steps 2–4 is to **reconcile, not re-create**: complete existing entries
  (missing `Fix.` blocks, status flips, cross-refs to the Dxxxx you add now) and skip
  anything already logged. Duplicated entries are worse than none.
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
If a previously-Open bug was fixed this session, append a `Fix.` block to it and flip its
heading status marker (don't rewrite the original Observed text). This applies equally to
entries this session wrote mid-stream — an entry created at discovery time and fixed later
the same session still needs its `Fix.` block completed here.

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

### Step 4.5 — Sync un-filed follow-ups to GitHub issues (propose, then apply)

The ROADMAP **Forward.** blocks and open `BUGS.md` entries accumulate "potential issues"
that were described but never filed. Turn the genuinely-unfiled ones into GitHub issues —
but **propose first, create only on the maintainer's yes** (this is outward mutation; Iron rule 6).

1. **Collect candidates** from:
   - the **Forward.** block you just wrote in Step 4, PLUS any still-open carried-forward
     items from the previous entry's Forward block;
   - open `BUGS.md` entries (`### B<n> … (Open …)`) that cite no GH issue number.
2. **Dedup against what's already filed:** `gh issue list --state all --limit 200`. Drop any
   candidate that (a) already cites a `#N` in the ROADMAP/BUGS text, or (b) matches an existing
   issue's title/keywords. A duplicate is worse than not filing.
3. **Draft** each remaining candidate: a clear title, a body quoting the ROADMAP/`Bxxxx`
   context + this session's date, and suggested labels (`bug`/`enhancement`; a `kano:*`/`effort:*`
   guess is optional — Step 4.6 finalizes labels).
4. **Present the proposed issue set** (titles + one-line bodies + labels) and **WAIT** for the
   maintainer to confirm / edit / drop. Create nothing before the yes.
5. **On confirmation:** `gh issue create` each, capture the new `#`s, and **append those `#`s
   into the ROADMAP Forward block** you wrote (so the doc records what got filed). On decline:
   leave the drafts in the Step 6 report only.

### Step 4.6 — Kano backlog refinement

After the sync, refine the whole open backlog so the new issues are categorized too.
**Invoke the `kano-backlog` skill** — do not re-implement Kano logic here; it is the single
source of truth (categorizes every open issue as Must-be / Performance / Attractive /
Indifferent / Reverse, applies `kano:*` + `priority:*` (+ `effort:*`) labels via `gh`, and
recommends the single best next issue). Run it AFTER Step 4.5 so it sees the issues just
created. Its label writes are GitHub mutation — gated by the skill's own flow; if it would
relabel, surface the plan and apply on the maintainer's yes (Iron rule 6).

### Step 5 — Hygiene check (report, don't fix)
- Uncommitted work: surface `git status --short` for **both** repos (the plugin repo and
  the workspace, including the docs you just wrote). **Separate three buckets explicitly:**
  (a) changes this session made, (b) leftovers from prior sessions (e.g. uncommitted docs
  entries from an earlier `/end-session`), and (c) **unexplained** changes nobody in this
  conversation made — flag (c) loudly; for a dirty tracked file you didn't touch, show a
  few diff lines so the maintainer can judge it (a hook or stale edit may be riding along).
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
- **Backlog:** issues created this run (with `#`s), or proposed-but-declined; the Kano
  next-pick recommendation from Step 4.6.

Keep the final report short; the value is in the doc updates, not the recap.
