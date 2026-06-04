# Kano Model — Research Report & Application to the rn-dev-agent Backlog

**Date:** 2026-06-04
**Scope:** What the Kano model is, how it's run, its pitfalls, how it's adapted for software/OSS backlogs — then applied to rn-dev-agent's 16 open issues.
**Companion artifacts:** [`kano-backlog-categorization.md`](./kano-backlog-categorization.md) · [`kano-survey-template.md`](./kano-survey-template.md) · [`kano-label-scheme-and-triage.md`](./kano-label-scheme-and-triage.md)

---

## 0. Provenance & verification caveat (read this first)

This report was seeded by the `deep-research` workflow (run `wf_97b5eac2-697`). Its **Scope → Search → Fetch** stages succeeded — **20 sources fetched, 88 claims extracted, top 25 selected** across 6 angles. Its **Verify** stage hit a *tooling failure*: every adversarial-verifier subagent completed without emitting its `StructuredOutput` verdict, so each claim recorded `0-0 (3 abstain)` and the harness's refute-by-default rule killed all 25 (reported "inconclusive"). That is a **false negative**, not a refutation — `0-0` means zero confirms **and** zero refutes.

The claims below are therefore **manually vetted** against the cited sources rather than machine-verified. They are canonical, uncontroversial Kano facts; the citations point at primary/secondary sources for each. Where a claim is contested in the literature, it's flagged in §6 (Critiques). Source quality grades (primary/secondary/blog) are from the fetch stage and carried through to §8.

---

## 1. Origins

The Kano model was introduced by **Dr. Noriaki Kano** (quality-management professor, Tokyo University of Science) with the 1984 paper **"Attractive quality and must-be quality,"** Kano, Seraku, Takahashi & Tsuji, *Journal of the Japanese Society for Quality Control* 14(2):39–48 [1][2][3]. It builds conceptually on **Herzberg's two-factor (motivation–hygiene) theory** and posits that customer satisfaction is **non-linear** in feature fulfillment — satisfaction does not rise uniformly as you add or improve features [4].

## 2. The five (+1) categories

| Category | Satisfaction signature | Plain meaning |
|---|---|---|
| **Must-be / Basic (M)** | Absence → strong **dissatisfaction**; presence → merely neutral (expected) | Table stakes. Users don't praise them; they revolt without them. [1][5] |
| **One-dimensional / Performance (O)** | Satisfaction **scales linearly** with degree of fulfillment | The "spoken" attributes you compete on; more is better. [1][5] |
| **Attractive / Delighter (A)** | Presence → **delight**; absence → **no** dissatisfaction | Unspoken/unexpected; the upside with no downside-of-omission. [1][5] |
| **Indifferent (I)** | Neither satisfaction nor dissatisfaction either way | Users don't care; building it is largely wasted effort. [1] |
| **Reverse (R)** | High achievement causes **dissatisfaction** for some users | The feature actively hurts a segment; more is *worse*. [1] |
| *Questionable (Q)* | Contradictory answer pair (logically inconsistent) | A data-quality flag, not a real category. [1] |

A central dynamic: **categories drift over time**. Today's *Attractive* delighter becomes tomorrow's *Performance* attribute and eventually a *Must-be* basic (the "natural decay of delight"). Re-survey periodically.

## 3. How categories are elicited — the functional/dysfunctional pair

Each feature is probed with a **paired question** [6][9][10]:
- **Functional (positive):** "How would you feel **if** the product *had* this feature?"
- **Dysfunctional (negative):** "How would you feel **if** the product did *not* have this feature?"

Both use a fixed **5-point scale**: *I like it · I expect it · I'm neutral · I can tolerate it · I dislike it* [9].

The answer **pair** maps to a category via the **evaluation table** [1][6]. Key cells:

| Functional ↓ \ Dysfunctional → | Like | Expect | Neutral | Tolerate | Dislike |
|---|---|---|---|---|---|
| **Like** | Q | **A** | **A** | **A** | **O** |
| **Expect** | R | I | I | I | **M** |
| **Neutral** | R | I | I | I | **M** |
| **Tolerate** | R | I | I | I | **M** |
| **Dislike** | R | R | R | R | Q |

Read it as: *Like-it-present / Dislike-it-absent* = **One-dimensional**; *Expect-it-present / Dislike-it-absent* = **Must-be**; *Like-it-present / Neutral-or-Expect-it-absent* = **Attractive**; *Dislike-it-present* = **Reverse**; contradictions = **Questionable** [1][6].

**Discrete vs. continuous analysis:**
- **Discrete (mode):** assign each feature the most-frequent category across respondents. Simple; loses the runner-up signal.
- **Continuous (Berger coefficients):** compute **CS+ / Satisfaction Index (SI)** = `(A+O)/(A+O+M+I)` and **CS− / Dissatisfaction Index (DI)** = `−(O+M)/(A+O+M+I)`. SI ∈ [0,1] = how much *adding* the feature raises satisfaction; DI ∈ [−1,0] = how much *omitting* it lowers it. Plotting features on the SI/DI plane gives a priority map [9].

## 4. Prioritization logic

The model's recommended order [7][11][13]:
1. **Satisfy every Must-be** first — they're the floor; missing one caps satisfaction regardless of everything else.
2. **Be competitive on Performance** — invest proportional to the satisfaction gradient.
3. **Add selective Attractive delighters** — differentiation, but only after the floor is solid and within capacity.
4. **De-prioritize Indifferent**; **avoid/guard against Reverse**.

**Critical limitation to design around:** Kano measures **satisfaction impact only** — it says nothing about **cost, effort, or feasibility** [13]. The standard remedy is to **combine Kano with an effort/value score (e.g. RICE)**: Kano sets the *category gate* (Must-bes are non-negotiable), then RICE orders *within* a category by cost-adjusted value [13].

## 5. No-survey / proxy-signal adaptation (our case)

Running a full functional/dysfunctional survey is costly and reaches few stakeholders. A documented adaptation **infers Kano categories from existing user text** instead [a]:
- An arXiv study (2303.03798) trains an ML classifier to assign Kano categories **from app-store reviews**, explicitly motivated by surveys being "costly and covering few stakeholders" — and reports a **BERT classifier at 0.928 in-sample accuracy** (10-fold CV) for category assignment [a].
- This legitimizes our approach: **infer categories from existing GitHub issues, field reports (#186), and usage** rather than running a survey — with the caveat below.

A supporting empirical result: Kano's **SI strongly tracks users' self-stated importance** (one study: SI explains ~78% of importance variance), while **DI does *not* significantly predict** self-stated importance — i.e. the "satisfaction-when-present" signal aligns with importance, but "dissatisfaction-when-absent" is a partially independent axis [b]. Practical upshot: *don't collapse Kano to a single importance score; the Must-be (DI-heavy) axis carries information importance-ranking misses.*

## 6. Critiques & pitfalls (apply with eyes open)

From a Google Research critical review and others [c]:
- **Survey-item quality:** the standard Kano questions are arguably **low-quality survey items** paired with questionable scoring — measurement validity is contested [c].
- **Domain transfer:** Kano's theory derives from **durable consumer goods**; transfer to **software/technology products is not guaranteed** [c]. (A direct caution for a dev-tool like this.)
- **Small-sample unreliability:** category assignment can be **unstable below ~N=200** [c] — which matters acutely for a *no-survey, inferred* application like ours (effective N is tiny). **Treat inferred categories as hypotheses, not measurements.**
- **Mode hides disagreement:** discrete winner-take-all can mask a near-tie between, say, Must-be and Performance.

**Net for us:** Kano is a useful *lens for ordering* the backlog by satisfaction shape, **not** a measurement we can defend statistically with the signal we have. We use it qualitatively, gate with it, and order within gates by effort/impact.

## 7. OSS issue-triage adaptation

Kubernetes' triage guide is a concrete, battle-tested template we adapt [d]:
- **Five-level priority labels** with defined meanings: `priority/critical-urgent`, `priority/important-soon`, `priority/important-longterm`, `priority/backlog`, `priority/awaiting-more-evidence` — a direct model for a **namespaced `kano:*` label scheme** [d].
- **A structured workflow:** new issues auto-labeled `needs-triage` → categorize by type → assign priority → route to the right area → **follow up on 30-/90-day windows** [d].

We map Kano categories onto labels and borrow the cadence — see [`kano-label-scheme-and-triage.md`](./kano-label-scheme-and-triage.md).

## 8. Sources (fetch-stage quality grades)

**Primary:** arXiv 2303.03798 (ML Kano from reviews) [a]; NIH PMC4769705 (SI/DI vs. importance) [b]; Google Research "Kano Analysis: A Critical Survey-Science Review" [c]; kubernetes.dev issue-triage guide [d].
**Secondary:** Wikipedia "Kano model" [1]; Qualtrics Kano analysis [9]; Interaction Design Foundation [3][5]; LearningLoop glossary [4][13]; ProductPlan [7][6]; Plane.so (RICE/MoSCoW/Kano).
**Blog/practitioner:** foldingburritos, scrumdesk (agile backlog), si-labs, conjointly (criticism), justinmind, quantuxblog (critical assessment), medium/people-in-product.

> Citation keys [1]–[13] and [a]–[d] map to the sources above; full URLs are listed in the workflow output (`tasks/w81v4xrs9.output`). Two fetched URLs were graded *unreliable* (0 usable claims) and excluded: a KFUPM PDF and a userpilot blog.

---

## 9. Application to rn-dev-agent → see the categorization artifact

The 16-issue Kano categorization, rationale, and prioritized order live in **[`kano-backlog-categorization.md`](./kano-backlog-categorization.md)**. Headline: the tool's **core promise is *reliable live verification on device*** — so connection/interaction reliability bugs (#208, #182, #210, #191) are **Must-be** and lead; data-quality and ergonomics issues are **Performance**; new surfaces (#108 CLI, #212 transient capture) are **Attractive**. The #202/#186/#201 cluster is largely **already shipped** (Phases 1–2b via #218, plus #188) and is mostly "verify & close."
