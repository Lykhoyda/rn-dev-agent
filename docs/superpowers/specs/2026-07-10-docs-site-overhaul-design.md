# Docs-site overhaul: custom landing page + journey-based IA

**Date:** 2026-07-10
**Status:** Approved
**Scope:** `apps/docs-site` only (plus removal of one generator script reference)

## Problem

The docs site (Astro Starlight, 157 pages) presents well-organized reference
material but fails at its two front doors:

1. **The landing page doesn't sell.** It is a stock Starlight `template: splash`
   page — hero text plus a CardGrid — indistinguishable from any other Starlight
   site. Nothing *shows* the product's differentiator (an agent that verifies
   its own work live on the simulator).
2. **The sidebar is organized by artifact type** (Commands / MCP Tools / Agents /
   Skills), not by user journey. A new user has no guided path from "what is
   this" to "first verified feature" to "deep reference".
3. **47 of the 157 pages republish third-party content** — the Best Practices
   rule pages are auto-generated copies of Vercel's agent-skills rules. This is
   redundant; the feature deserves one page, not 47.

Research input: a survey of modern dev-tool sites (Bun, Warp, Biome, Turborepo,
Knip, Linear, Vercel AI SDK, Expo, Stripe, Cloudflare Docs, Mintlify guidance,
Evil Martians' 100-devtool-landing-pages study) informed the section blueprint,
headline formula, IA quarantine pattern, and terminal-animation technique below.

## Decisions (user-approved)

| Decision | Choice |
|---|---|
| Depth | Custom Astro landing page; keep Starlight for docs, restyled |
| IA | Restructure sidebar journey-style; content moves, no rewrites |
| Best Practices | One overview page; delete 47 generated rule pages + generator |
| Hero centerpiece | Code-animated terminal + synced pure-CSS phone mockup (no video) |
| Visual identity | Evolve existing dark-only "engineering precision" theme |
| Landing composition | Receipts-first engineering page (Bun/Biome pattern) |

## 1. Landing page — custom `src/pages/index.astro`

Replaces `src/content/docs/index.mdx` (which is deleted). A fully custom Astro
page outside Starlight's page shell, sharing CSS tokens with the docs theme.
Dark-only. No framework JS; total scripted budget ≈ 60 lines of vanilla JS.

### Section order

1. **Minimal header** — wordmark; links: Docs · Tools · Benchmarks · GitHub.
2. **Hero**
   - Eyebrow badge: current version + one release highlight
     (e.g. "v0.66 · self-building device runners").
   - Headline: **"Your agent writes the code. This proves it runs."**
   - Subline (mechanism): reads the component tree, store state, and navigation
     stack over CDP; taps real UI on iOS and Android; replays verified flows in
     seconds.
   - Primary CTA: copyable install command
     `/plugin marketplace add Lykhoyda/rn-dev-agent` (terminal-styled, copy
     button). Secondary CTA: "Get started →" (links to `getting-started/`).
   - Demo panel: **animated terminal** (left) replaying a condensed real
     `/test-feature` session — command line typed per-character, then tool-call
     lines (`⚙ cdp_component_tree … ✓ 128ms`, `⚙ device_press …`,
     `✓ Verified on iPhone 16 Pro`) revealed per-line — beside a **pure-CSS
     phone mockup** (right) whose screen states cross-fade in sync with the log.
3. **Stat strip** — oversized tabular numerals as the visual element:
   `210×` action replay speedup · `79` MCP tools · `35` stories / `0` crashes ·
   iOS + Android.
4. **Problem → solution** — "Coding agents ship blind": the pain (agent claims
   the feature works but never sees it run), answered by what live verification
   looks like (component-tree and store-state excerpts in terminal frames).
5. **Three-layer capability grid** — one card per layer of the real
   device-control contract: **Introspect** (L1, CDP reads), **Interact**
   (L2, native runners), **Replay** (L3, actions). Each card holds a miniature
   code/output sample. The grid maps 1:1 to the architecture so the landing
   cannot drift from the docs.
6. **Tabbed tool showcase** — CSS-only tabs (radio-input pattern, no JS)
   switching between `cdp_component_tree`, `cdp_store_state`, `device_press`,
   `cdp_run_action`, each with realistic JSON output.
7. **How it works** — the 8-phase `/rn-feature-dev` pipeline as a compact
   horizontal strip (Explore → … → Verify live → Review → E2E proof).
8. **Final CTA band** — contrasting panel; install command again; Getting
   Started link.
9. **Footer** — GitHub, docs, changelog, license.

### Terminal animation (termynal pattern, hand-rolled — no dependency)

- All transcript lines live in the HTML with `data-*` delay attributes; a small
  script reveals them line-by-line. Per-character typing only for the single
  command line (fixed-`ch`-width container; no layout thrash).
- `IntersectionObserver` starts the animation on visibility and pauses it
  off-screen. Loop with a 3–4 s hold on the finished state.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables the
  CSS animations AND a `matchMedia` check skips the JS driver — users see the
  complete final transcript. No-JS visitors likewise see the full transcript
  (content is real text in the DOM).
- Only `opacity`/`transform` are animated. Decorative caret is `aria-hidden`;
  no `aria-live` (the panel is decorative).
- Phone screens are **CSS-drawn stylized UI**, not screenshots — crisp at any
  DPI, zero binary assets, cannot go stale.

### Visual treatments (shared design language)

- Faint blueprint dot-grid behind the hero, radially masked.
- One radial accent glow behind the demo panels (no global gradients).
- Terminal-chrome window framing (traffic-light dots + title bar) as the
  repeating motif — matches Expressive Code frames in the docs.
- 2–3% noise overlay on dark bands; 1px `color-mix` accent borders on cards.
- Monospace letter-spaced caps for eyebrow labels ("VERIFIED ON DEVICE").

## 2. Docs IA restructure — sidebar only, URLs unchanged

Pure regrouping in `astro.config.mjs`; every page keeps its slug, so **no
redirects are needed**. New sidebar:

- **Start Here** — Getting Started
- **Core Concepts** — Architecture · Actions · Troubleshooting Memory
- **Guides** — DevTools coexistence · maestro-mcp interop · Dev Client
  coverage (currently an orphan page absent from the sidebar — this fixes it)
- **Reference** — Commands (13, collapsed) · MCP Tools (CDP 58 / Device 14 /
  Testing 5 as collapsed autogenerated groups under the existing overview page
  with a scannable tool · one-liner table) · Agents (5) · Skills (4) ·
  Best Practices (single page)
- **Project** — Benchmarks · Troubleshooting · Changelog

### Best Practices consolidation

- Delete `src/content/docs/best-practices/rules/` (47 generated pages).
- Delete `scripts/generate-bp-docs.mjs`; remove it from the `generate` npm
  script (keep `generate-tool-docs.mjs`).
- Rewrite `best-practices/index.mdx` as one overview page: what the feature
  does, impact levels, when rules are checked (Phase 4 architecture / Phase 6
  review), link to Vercel's agent-skills repo for rule text, and a named list
  of the custom non-Vercel rules.
- Note: the rules themselves stay in `packages/shared-agent-knowledge` — the
  plugin feature is untouched; only the docs republication is removed.

## 3. Theme restyle (Starlight side)

Evolve `src/styles/custom.css`, keeping DM Sans + JetBrains Mono and the sky
accent (`#38bdf8`):

- Shared token layer (glow, grid, noise, border treatments) used by both the
  landing page and docs so they read as one system.
- Expressive Code: align to a matching dark Shiki theme; use terminal-style
  frames for shell samples.
- Sidebar refinements: group-label styling, current-section emphasis.
- Cards, tables, and asides restyled with the landing's border/glow language.
- Stays dark-only via the existing ThemeProvider/ThemeSelect overrides.

## 4. Extras

- **`llms.txt`** via the `starlight-llms-txt` community plugin — a Markdown
  index of the docs for AI agents (Expo/Cloudflare/Claude Code precedent; for
  a tool consumed by coding agents this is near-mandatory).
- Regenerate the OG image (`og-image.png`) to match the new brand.

## 5. Non-goals

- No content rewrites of narrative pages (IA move only).
- No light theme.
- No framework migration off Starlight.
- No video assets.
- No error-code-catalog restructure of the troubleshooting page (good future
  work, out of scope).

## 6. Risks & mitigations

- **GitHub Pages base path** (`/rn-dev-agent`): every asset/link on the custom
  landing must resolve under the base. Use `import.meta.env.BASE_URL`
  consistently; verify in the built output, not just `astro dev`.
- **Root-route collision**: deleting `index.mdx` and adding
  `src/pages/index.astro` must leave exactly one owner of `/`. Verified by
  build + preview.
- **Sidebar regression**: 157 pages regrouped — a link check over the built
  site guards against dropped pages.

## 7. Verification

- `yarn build` green (includes `generate-tool-docs.mjs`; bp generator removed).
- Playwright / Chrome DevTools visual pass: landing + 3 representative doc
  pages at desktop and mobile widths.
- Reduced-motion emulation check on the landing.
- Link check across the new sidebar; confirm the orphan page is reachable.
- Deploy preview (GitHub Pages build) before merge.
