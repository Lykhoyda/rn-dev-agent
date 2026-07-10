# Docs follow-up: motion-driven concept explainers + docs styling polish

**Date:** 2026-07-10
**Status:** Approved
**Scope:** `apps/docs-site` only. Follow-up to the docs-site overhaul
(spec `2026-07-10-docs-site-overhaul-design.md`, shipped as PR #546).

## Problem

The overhauled landing page shows the product; the docs pages still *tell*.
The three load-bearing mental models — the three-layer device-control
contract, the actions lifecycle, and the live-verification loop — are
explained in prose and (in one case) a broken table. And the docs pages'
visual treatment received only a conservative alignment pass in the
overhaul; their typography and rhythm lag the landing's quality.

Also open: **B166** — the "Three layers" table in `architecture.mdx` is
malformed in source and renders as inline pipe soup.

## Decisions (user-approved)

| Decision | Choice |
|---|---|
| Concepts animated | Three-layer contract · Actions lifecycle · Live-verification loop |
| Placement | Embedded in existing pages (Architecture / Actions / Getting Started); no new pages |
| Engine | One shared scene engine (Approach A) — not bespoke per scene, not scroll-scrubbed |
| Styling depth | Typography/rhythm polish + restyled Starlight built-ins; no bespoke Steps/Badge components |

## 1. Scene engine — `ConceptScene`

A generalization of the landing hero's proven termynal pattern.

- `src/components/concepts/ConceptScene.astro` renders a bordered,
  captioned `<figure>` (terminal-chrome-adjacent framing, `--rda-*`-token
  styling consistent with the docs theme) around slotted scene content.
  Props: `id` (required), `title`, `caption`, `steps` (count, required),
  `stepMs` (default 1400), `holdMs` (end-of-loop hold, default 3200).
- Scene content is plain HTML/SVG. Elements opt into choreography with
  `data-step="N"` (become active at step N) and optionally
  `data-until="M"` (de-emphasize after step M).
- One shared driver script inside `ConceptScene.astro` (bundled once by
  Astro regardless of how many scenes a page mounts): arms only when
  `IntersectionObserver` exists AND `prefers-reduced-motion` is off; adds
  `is-animated` to the figure; cycles the figure's `data-active` attribute
  `1…steps` on timers, holds `holdMs` at the final step, loops; pauses via
  the observer when off-screen.
- All step visuals are CSS keyed off `[data-active]` +
  `.is-animated`; only `opacity`/`transform` animate.
- **Static-complete default:** without `is-animated`, every element is
  fully visible and labeled. No-JS, reduced-motion, and crawlers all get a
  finished diagram. The `@media (prefers-reduced-motion: reduce)` CSS
  override backstops the JS guard, mirroring the landing.
- Captions/labels are real text (screen-reader readable); purely
  decorative flourishes are `aria-hidden`. No `aria-live`.

## 2. The three scenes

Each scene = one Astro component (declarative markup + scoped CSS, no
per-scene JS) under `src/components/concepts/`.

### `ThreeLayerScene` → `architecture.mdx`

Three horizontal layer bands (L1 INTROSPECT / L2 INTERACT / L3
FLOW-REPLAY) beside a device outline.

1. L1 active: read arrows flow device → docs; label "shared — always safe".
2. L2 active alongside L1: a tap arrow lands on the device; label
   "shared — re-attach, don't evict".
3. L3 takes the device exclusively: flow band highlights, the L2 arrow is
   refused with a `BUSY_FLOW_ACTIVE` chip, L1 arrows keep flowing.
4. Full labeled contract (the static end state).

**B166 fix is part of this embed:** the malformed layer table in
`architecture.mdx` is repaired (valid markdown table). The scene carries
the concept; the fixed table remains as reference detail below it.

### `ActionsLifecycleScene` → `actions/index.mdx`

The hybrid loop as a cycle diagram: interactive walk (⏱ 14 min) →
verified ✓ → saved to `.rn-agent/actions/` → replay (⏱ 4 s) → UI drift
detected → `cdp_repair_action` patches the selector → replay ✓. Steps
highlight each node with a one-line caption; the 14 min → 4 s contrast is
the visual anchor (oversized tabular numerals, landing-style).

### `VerifyLoopScene` → `getting-started.mdx`

Compact loop: implement → connect (CDP) → navigate → read tree + state →
exercise UI → report **with evidence**. Six nodes, one revolution, then
hold. Placed after installation so a newcomer sees what the plugin
actually does before the first command.

## 3. Docs styling polish + restyled built-ins

- **PageTitle override** (`src/components/PageTitle.astro`, registered in
  `astro.config.mjs` `components`): renders a monospace, letter-spaced
  kicker above the H1 showing the page's top-level sidebar group name
  ("CORE CONCEPTS", "REFERENCE", …) resolved from
  `Astro.locals.starlightRoute`; pages outside any group render no kicker.
  Falls back to Starlight's default markup for the title itself.
- **`custom.css` rhythm pass** (evolving, not replacing, the existing
  file): lead-paragraph treatment for the first paragraph after the title;
  refined h2/h3 spacing; table polish (tabular numerals, tighter
  uppercase headers — building on the existing rules); brand-tinted
  asides; right-ToC active rail (accent inset like the left sidebar);
  pagination (prev/next) cards restyled with the landing's border/hover
  language.
- **Starlight built-ins, restyled not rebuilt:** `<Steps>` gets the brand
  treatment (numbered rail in accent, connector line) and is applied to
  the Getting Started installation flow; `<Badge>` styling (already
  partially themed) is refined for platform chips and used where the
  touched pages state platform applicability. No bespoke equivalents.

## 4. Verification

- `verify-site.ts` gains an assertions block: the three embed pages
  contain their scene roots (`data-scene-id`), the built bundles contain
  the driver markers (`data-active`, `prefers-reduced-motion` guard), the
  built HTML of each embed page contains the scene's full label text
  (static-complete proof), and `architecture/index.html` contains a real
  `<table>` in the layers section (B166 proof).
- Playwright pass: each scene animates through its steps on-screen,
  freezes complete under reduced-motion emulation, and fits at 390 px
  without horizontal overflow; PageTitle kicker renders on a grouped page
  and is absent on an ungrouped one.

## 5. Non-goals

- No scroll-scrubbed animation, no animation libraries, no new deps.
- No content rewrites beyond the three embed points and the B166 table
  repair.
- No changes to generated reference pages or their generator.
- No landing-page changes.

## 6. Risks

- **Starlight route data for the kicker:** the sidebar-group lookup from
  `starlightRoute` must degrade to "no kicker" if the shape differs —
  never break the title. Implementation verifies against Starlight 0.38's
  actual route shape.
- **MDX + Astro component interplay:** scenes are imported into `.mdx`;
  Astro bundles component scripts once per page — verified by the
  existing build + the new assertions.
- **Scene CSS leakage:** scene styles are component-scoped (Astro scoped
  styles) so they cannot bleed into Starlight content styling.
