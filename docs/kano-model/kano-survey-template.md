# Kano Survey Template — rn-dev-agent

A ready-to-run **functional/dysfunctional** Kano questionnaire tailored to this plugin, for when you want *measured* categories (vs. the inferred ones in [`kano-backlog-categorization.md`](./kano-backlog-categorization.md)). See the [report](./2026-06-04-kano-model-research-report.md) §3 for the method and §6 for the **N≥~200 reliability caveat** — below that, treat results as directional.

## How to administer

- **Audience:** users who drive RN apps with rn-dev-agent (and, for #108, CI/non-LLM consumers).
- **Per feature, ask exactly two questions** (functional + dysfunctional), each on the same 5-point scale.
- **Add one self-stated importance question** per feature (1–9) — use it to break ties *within* a Kano category, not across.
- Keep it to ≤8 features per respondent to avoid fatigue. Randomize feature order.

## The 5-point scale (use verbatim for both questions)

```
1. I like it
2. I expect it
3. I am neutral
4. I can tolerate it
5. I dislike it
```

## Question pair format

> **Functional:** "If rn-dev-agent **had** «FEATURE», how would you feel?"
> **Dysfunctional:** "If rn-dev-agent did **not** have «FEATURE», how would you feel?"
> **Importance:** "How important is «FEATURE» to your workflow?" (1 = not at all … 9 = extremely)

## Feature bank (tailored to this plugin)

Drop in the features relevant to the decision. Phrase each as a *user-visible capability*, not an implementation.

| Key | «FEATURE» wording |
|---|---|
| connect-reliable | "a CDP connection that attaches on the first try and never wedges on a stale prior session" |
| introspect-truth | "reading live store state / component tree / navigation accurately while the app runs" |
| device-interact | "tapping, scrolling, and **reliably typing text** into the running app" |
| session-visibility | "a clear readout of device-session state (which runner/target is active) when something is off" |
| maestro-coexist | "running Maestro flows and rn-dev-agent reads together without the two evicting each other" |
| network-accuracy | "a network log with exactly one entry per request (no duplicates)" |
| storage-reset | "reading/clearing app storage (incl. MMKV) for auth/state reset" |
| observe-live | "a live `/observe` view whose screenshot and route stay in sync with the device" |
| maestro-structured | "structured per-step Maestro results with partial progress when a flow times out" |
| transient-capture | "automatic capture of transient screens triggered by route changes" |
| cli-actions | "a plain CLI (`rn-action list/run`) to replay saved actions outside an LLM session" |

## Evaluation table (code each functional×dysfunctional pair)

| Functional ↓ \ Dysfunctional → | Like | Expect | Neutral | Tolerate | Dislike |
|---|---|---|---|---|---|
| **Like** | Q | A | A | A | O |
| **Expect** | R | I | I | I | M |
| **Neutral** | R | I | I | I | M |
| **Tolerate** | R | I | I | I | M |
| **Dislike** | R | R | R | R | Q |

`M`=Must-be · `O`=One-dimensional/Performance · `A`=Attractive · `I`=Indifferent · `R`=Reverse · `Q`=Questionable.

## Analysis

**Discrete (quick):** per feature, take the **modal** category across respondents. If Must-be and Performance are within a few points, treat as Must-be (conservative).

**Continuous (Berger coefficients) — recommended when N is small:**
```
SI  (better)  = (A + O) / (A + O + M + I)      # 0..1   — how much ADDING it raises satisfaction
DI  (worse)   = -(O + M) / (A + O + M + I)      # -1..0  — how much OMITTING it lowers satisfaction
```
Plot features on the SI (x) / |DI| (y) plane:
- **High SI, high |DI|** → Performance (compete here)
- **Low SI, high |DI|** → Must-be (floor — fix first)
- **High SI, low |DI|** → Attractive (delight — selective)
- **Low SI, low |DI|** → Indifferent (skip)

Drop any respondent's feature row coded **Q** (contradictory). Tally **R** separately — a non-trivial Reverse share means *guard/opt-out*, not "build."

## Reporting

For each feature report: modal category, SI, |DI|, %Reverse, and mean importance. Feed the result back into [`kano-backlog-categorization.md`](./kano-backlog-categorization.md) to replace an *inferred* category with a *measured* one.
