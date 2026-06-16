# The Kano Model — reference

The Kano model (Noriaki Kano, 1984) classifies product attributes by how their
presence or absence affects user satisfaction. It is not a linear priority score:
two features with identical "importance" can demand opposite treatment because
users react to them asymmetrically.

## The five categories

| Category | Code | If present | If absent | Treat as |
|----------|------|-----------|-----------|----------|
| **Must-be** (Basic / Threshold) | M | No extra satisfaction — taken for granted | Strong dissatisfaction | Non-negotiable. Fix/ship before anything else. |
| **Performance** (One-dimensional / Linear) | O | Satisfaction rises the more/better it is | Dissatisfaction rises the less/worse it is | Invest proportionally to demand. The "more is better" axis. |
| **Attractive** (Delighter / Exciter) | A | Delight, differentiation | No dissatisfaction — users didn't expect it | Selective bets. A few wins outsized loyalty; don't over-invest. |
| **Indifferent** | I | No measurable effect | No measurable effect | Deprioritize or drop. Often internal-only or nobody-asked. |
| **Reverse** | R | Some users actively dislike it | Those users are happier without it | Don't build as-is. Make optional, or reconsider. |
| **Questionable** | Q | Contradictory signal | Contradictory signal | Data/understanding is inconsistent — re-read the issue, don't classify. |

The critical insight for backlog work: **Must-be items are invisible when present
but catastrophic when missing**, so an unmet Must-be (a bug, a broken basic) almost
always outranks a shiny Attractive feature. Conversely, piling Performance effort
onto an already-satisfied Must-be yields nothing — you can't delight users by making
the login page "more reliable" past the point where it already works.

## The functional / dysfunctional question pair

Classic Kano derives a category from two mirrored questions about the *same* feature:

- **Functional** (feature is present / works well): *How do you feel?*
- **Dysfunctional** (feature is absent / works poorly): *How do you feel?*

Each is answered on the same 5-point scale:

1. I like it
2. I expect it (it must be that way)
3. I am neutral
4. I can tolerate it
5. I dislike it

In heuristic mode you estimate both answers from the issue text and any demand
signals, then read the category off the table below.

## Kano evaluation table

Rows = the **functional** answer (feature present). Columns = the **dysfunctional**
answer (feature absent). The cell is the category.

| Functional ↓ \ Dysfunctional → | Like | Expect | Neutral | Tolerate | Dislike |
|---|---|---|---|---|---|
| **Like**     | Q | A | A | A | O |
| **Expect**   | R | I | I | I | M |
| **Neutral**  | R | I | I | I | M |
| **Tolerate** | R | I | I | I | M |
| **Dislike**  | R | R | R | R | Q |

How to read it: "I'd *like* it if present (Like) and I'd *dislike* its absence
(Dislike)" → **O**, Performance. "I *expect* it if present and I'd *dislike* its
absence" → **M**, Must-be. "I'd *like* it if present but I'm *neutral* about its
absence" → **A**, Attractive.

## Heuristic signals (text → estimated answers)

These are *hints*, not rules. Always reason about the pair of questions first;
use signals to break ties. Read the issue's title, body, labels, comments, and
reaction/vote counts.

**Lean Must-be (M)** — the absence causes pain users consider unacceptable:
- Bug reports, regressions, crashes, errors, "doesn't work", "broken", "fails"
- Security vulnerabilities, data loss, privacy, auth/login/payment broken
- Legal/compliance/accessibility obligations (the floor, not a delighter)
- Anything described as "table stakes", "expected", "should already work"

**Lean Performance (O)** — satisfaction scales with the metric:
- Speed/latency/load-time, throughput, cost/price, capacity/limits/quota
- "Faster", "more", "reduce steps", "improve accuracy", "increase X"
- Search relevance, sync reliability, battery/efficiency — graded, not binary

**Lean Attractive (A)** — unexpected upside, no pain if missing:
- New integrations, novel capabilities, automation, "AI-powered", "magic"
- "Would be cool", "nice to have", "wishlist", "delight", "wow"
- Differentiators competitors lack; things users didn't think to ask for

**Lean Indifferent (I)** — no user-visible effect or no demand:
- Internal refactors, renames, tech-debt cleanup, dependency bumps with no behavior change
- Cosmetic tweaks nobody requested; zero reactions/comments after a long time
- (Internal-but-enabling work isn't worthless — it may *unblock* a Must-be/Performance
  item. Note the dependency rather than dismissing it.)

**Lean Reverse (R)** — adding it would annoy a meaningful set of users:
- Forced flows, mandatory steps, removing an option users rely on
- Intrusive notifications/popups, auto-enabled tracking, dark patterns
- "Make X mandatory", "remove the ability to Y", "force users to Z"

**Confidence.** Note low confidence when the issue is vague, mixes several features,
or signals conflict (Questionable). Low-confidence items are candidates for a
clarifying comment, not a confident label.

## Demand signals (for ranking *within* a category)

Kano gives the *tier*; these order issues inside a tier:
- **Reactions / 👍 / votes** — revealed demand
- **Comment volume & distinct participants** — breadth of interest
- **Age** — a long-unmet Must-be is more urgent; a stale Indifferent is a drop candidate
- **Effort** — from `effort:*`/`size:*`/`SP:*` labels or inferred scope
- **Dependencies / blockers** — an item that unblocks others rises

## Prioritization policy (Kano → backlog order)

1. **Unmet Must-be first.** Bugs and broken basics produce active dissatisfaction
   every day they remain. Clear these before adding anything new.
2. **Performance next, by value/effort.** Order by demand signal ÷ effort so the
   steepest satisfaction-per-cost work surfaces first.
3. **A few Attractive bets.** Reserve limited capacity for 1–2 delighters per cycle
   for differentiation — not the whole backlog, since their absence costs nothing.
4. **Indifferent: deprioritize or drop.** Keep only if it unblocks a higher tier
   (say so explicitly).
5. **Reverse: don't ship as-is.** Recommend making it optional, scoping it down, or
   closing with rationale. Never silently build it.
