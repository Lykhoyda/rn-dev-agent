# Kano Label Scheme & Triage Workflow — rn-dev-agent

A lightweight, recurring way to keep the backlog Kano-ordered. Adapted from the Kubernetes issue-triage model (namespaced priority labels + a follow-up cadence — see [report](./2026-06-04-kano-model-research-report.md) §7).

## 1. Label scheme

**Kano category (one per issue, mutually exclusive):**

| Label | Meaning | Color |
|---|---|---|
| `kano:must-be` | Breaks/withholds a core promise; absence → strong dissatisfaction. **Highest gate.** | `#b60205` (red) |
| `kano:performance` | Satisfaction scales with degree (accuracy, speed, ergonomics). | `#d93f0b` (orange) |
| `kano:attractive` | Delighter / new surface; not missed when absent. | `#0e8a16` (green) |
| `kano:indifferent` | No satisfaction signal either way; candidate to close/defer. | `#cccccc` (grey) |
| `kano:reverse` | More of it dissatisfies a segment — guard/opt-out, don't "build". | `#5319e7` (purple) |
| `kano:needs-triage` | Not yet categorized (auto-applied to new issues). | `#fbca04` (yellow) |

**Effort (orthogonal — breaks ties *within* a Kano gate, since Kano ignores cost):**

| Label | Meaning |
|---|---|
| `effort:s` | < ~½ day |
| `effort:m` | ~1–3 days |
| `effort:l` | > ~3 days / needs design |

> Rule of thumb: **work `kano:must-be` before all else**; within a gate, prefer lower `effort:*` for faster satisfaction gains (Kano-gated RICE-lite).

## 2. Create the labels (gh CLI)

```bash
REPO=Lykhoyda/rn-dev-agent
gh label create kano:must-be     -R $REPO -c b60205 -d "Kano: core promise; absence causes strong dissatisfaction" --force
gh label create kano:performance -R $REPO -c d93f0b -d "Kano: satisfaction scales with degree" --force
gh label create kano:attractive  -R $REPO -c 0e8a16 -d "Kano: delighter; not missed when absent" --force
gh label create kano:indifferent -R $REPO -c cccccc -d "Kano: no satisfaction signal; defer/close" --force
gh label create kano:reverse     -R $REPO -c 5319e7 -d "Kano: more of it dissatisfies a segment; guard/opt-out" --force
gh label create kano:needs-triage -R $REPO -c fbca04 -d "Kano: not yet categorized" --force
gh label create effort:s -R $REPO -c c2e0c6 -d "Effort: < half a day" --force
gh label create effort:m -R $REPO -c c2e0c6 -d "Effort: ~1-3 days" --force
gh label create effort:l -R $REPO -c c2e0c6 -d "Effort: > 3 days / needs design" --force
```

## 3. Seed the current backlog (from the categorization artifact)

```bash
REPO=Lykhoyda/rn-dev-agent
# Wave 1 — Must-be (open)
for n in 208 182 210 191; do gh issue edit $n -R $REPO --add-label kano:must-be; done
# Already-shipped Must-be (verify & close)
for n in 202 194; do gh issue edit $n -R $REPO --add-label kano:must-be; done
# Performance
for n in 186 201 214 209 206 211 199; do gh issue edit $n -R $REPO --add-label kano:performance; done
# Attractive
for n in 108 212; do gh issue edit $n -R $REPO --add-label kano:attractive; done
# Indifferent / meta
gh issue edit 173 -R $REPO --add-label kano:indifferent
```

(Effort labels are a judgment call per issue; apply during triage.)

## 4. Recurring triage workflow

**On every new issue:** auto-apply `kano:needs-triage` (a `gh` workflow or a label-default). It stays until categorized.

**Monthly triage pass (~30 min):**
1. **Sweep `kano:needs-triage`.** For each: read it, assign exactly one `kano:*` category + one `effort:*`, remove `kano:needs-triage`.
2. **Re-validate Must-bes.** Confirm each open `kano:must-be` still breaks a core promise; demote if the promise changed.
3. **Decay check.** Re-examine `kano:attractive` items > ~2 cycles old — has a delighter become expected (→ `kano:performance`/`kano:must-be`)? Kano categories drift; re-label.
4. **Reverse review.** For any `kano:reverse`, confirm it's guarded/opt-out, not scheduled to "build."
5. **Order the next sprint:** all open `kano:must-be` (lowest effort first) → then `kano:performance` (lowest effort first) → then a *selective* `kano:attractive`. Never pull an Attractive while an unblocked Must-be is open.

**Quarterly (optional):** run the [survey](./kano-survey-template.md) on the top contested features to replace *inferred* categories with *measured* ones.

## 5. Guardrails

- **One `kano:*` per issue.** Multiple categories = the issue is really several issues — split it (see #173).
- **Inferred ≠ measured.** Labels applied without a survey are hypotheses (report §6). Don't treat the order as statistically defensible; treat it as a sane default that a survey can correct.
- **Kano gates, effort orders.** Kano never moves a Performance item above an open Must-be; effort only sorts *within* a gate.
