# Docs-Site Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stock Starlight splash landing with a custom receipts-first landing page (animated terminal + phone hero), restructure the docs sidebar journey-style, consolidate Best Practices to one page, restyle the docs theme, and add llms.txt.

**Architecture:** The docs stay on Astro Starlight (`apps/docs-site`); the landing becomes a standalone Astro page at `src/pages/index.astro` (the Starlight content page `src/content/docs/index.mdx` is deleted so exactly one owner of `/` remains). A `scripts/verify-site.mjs` assertion harness runs against the built `dist/` and is the test vehicle for every task (TDD: add failing assertions first, then implement). All page URLs stay unchanged — the IA work is pure sidebar config.

**Tech Stack:** Astro 6 + Starlight 0.38, vanilla JS (~60 lines, no framework), pure CSS, `sharp` (already a dep) for the OG image, `starlight-llms-txt` (new dev-facing dep).

**Spec:** `docs/superpowers/specs/2026-07-10-docs-site-overhaul-design.md`

## Global Constraints

- Node >= 22; the site is a Yarn workspace named `rn-dev-agent-docs`. Build from repo root: `corepack yarn workspace rn-dev-agent-docs build`.
- GitHub Pages base path is `/rn-dev-agent` (`base` in `astro.config.mjs`). Every internal link/asset on the custom landing must go through `import.meta.env.BASE_URL`.
- Dark-only site (ThemeProvider override SSRs `data-theme="dark"`). The landing page hardcodes `data-theme="dark"` on `<html>` and must not depend on Starlight CSS.
- Headline (verbatim): **"Your agent writes the code. This proves it runs."**
- Stats (verbatim): `210×` action replay speedup · `79` MCP tools · `35` stories, `0` crashes · iOS + Android.
- Hero eyebrow version is read at build time from `packages/claude-plugin/.claude-plugin/plugin.json` (currently `0.66.14`) — never hardcoded.
- Animations may touch only `opacity`/`transform`; `prefers-reduced-motion` and no-JS users must see the complete final transcript.
- `rn-dev-agent-docs` is in the changesets `ignore` list — **no changeset needed** for any task in this plan.
- No new runtime frameworks. Only new dependency allowed: `starlight-llms-txt`.
- Repo conventions: no unnecessary comments; commits signed (`git commit -S`), small, per-task.

---

### Task 1: Site verification harness

The docs site has no test infrastructure. This harness runs assertions against the built `dist/` (page existence, content markers, and an internal-link check) and is how every later task proves itself.

**Files:**
- Create: `apps/docs-site/scripts/verify-site.mjs`
- Modify: `apps/docs-site/package.json` (add `verify` script)

**Interfaces:**
- Produces: `node scripts/verify-site.mjs` (run from `apps/docs-site/`), exits 1 on any failed assertion. Later tasks append `check(...)` calls to the `TASK ASSERTIONS` section of this file.
- Produces: helper functions later tasks use: `check(name, cond)`, `page(relPath)` (reads a dist HTML file as string, e.g. `page('getting-started/index.html')`), `exists(relPath)`.

- [ ] **Step 1: Write the harness with baseline assertions**

Create `apps/docs-site/scripts/verify-site.mjs`:

```js
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const BASE = '/rn-dev-agent';
let failed = 0;

function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}`);
  }
}

function exists(relPath) {
  return existsSync(join(DIST, relPath));
}

function page(relPath) {
  return readFileSync(join(DIST, relPath), 'utf8');
}

function htmlFiles(dir = DIST) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

function checkInternalLinks() {
  let broken = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    for (const [, url] of html.matchAll(/(?:href|src)="([^"#?]+)[#?]?[^"]*"/g)) {
      if (url !== BASE && !url.startsWith(`${BASE}/`)) continue;
      const rel = url === BASE ? '' : url.slice(BASE.length + 1);
      if (/\.(css|js|png|svg|txt|xml|ico|json|webmanifest|woff2?|ttf|webp|avif|jpe?g|gif|mp4)$/.test(rel)) {
        if (!exists(rel)) {
          broken += 1;
          console.error(`  broken asset ${url} in ${file.slice(DIST.length)}`);
        }
        continue;
      }
      const target = rel === '' ? 'index.html' : join(rel, 'index.html');
      if (!exists(target) && !exists(rel)) {
        broken += 1;
        console.error(`  broken link ${url} in ${file.slice(DIST.length)}`);
      }
    }
  }
  check('no broken internal links or assets', broken === 0);
}

console.log('verify-site: baseline');
check('dist exists (run `yarn build` first)', existsSync(DIST));
check('landing page built', exists('index.html'));
check('getting-started built', exists('getting-started/index.html'));
check('tools overview built', exists('tools/index.html'));
check('a generated CDP tool page built', exists('tools/cdp/cdp_status/index.html'));
checkInternalLinks();

// ── TASK ASSERTIONS (appended by later tasks) ──

if (failed > 0) {
  console.error(`\nverify-site: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-site: all assertions passed');
```

- [ ] **Step 2: Add the `verify` script**

In `apps/docs-site/package.json`, add to `scripts`:

```json
"verify": "node scripts/verify-site.mjs"
```

- [ ] **Step 3: Build and run — verify it passes against the current site**

```bash
corepack yarn workspace rn-dev-agent-docs build
corepack yarn workspace rn-dev-agent-docs verify
```

Expected: all baseline checks `ok`, exit 0. (If `no broken internal links` fails on the *current* site, list the broken links in the commit message and fix only ones this plan's tasks touch; pre-existing breakage outside scope gets a `KNOWN` skip with a comment.)

- [ ] **Step 4: Commit**

```bash
git add apps/docs-site/scripts/verify-site.mjs apps/docs-site/package.json
git commit -S -m "test(docs-site): add verify-site assertion harness with link check"
```

---

### Task 2: Sidebar IA restructure (journey-based, URLs unchanged)

**Files:**
- Modify: `apps/docs-site/astro.config.mjs` (the `sidebar` array, lines ~66–167)
- Modify: `apps/docs-site/scripts/verify-site.mjs` (assertions)

**Interfaces:**
- Consumes: `check`/`page` from Task 1.
- Produces: the final sidebar structure; Task 3 removes the Best Practices rules group it still contains at the end of this task.

- [ ] **Step 1: Add failing assertions**

Append to the `TASK ASSERTIONS` section of `verify-site.mjs`:

```js
console.log('\nverify-site: IA restructure');
const gs = page('getting-started/index.html');
for (const group of ['Start Here', 'Core Concepts', 'Guides', 'Reference', 'Project']) {
  check(`sidebar group "${group}"`, gs.includes(group));
}
check('orphan dev-client-coverage page is in sidebar', gs.includes('dev-client-coverage'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on `sidebar group "Start Here"`, `"Core Concepts"`, `"Project"`, and the orphan check.

- [ ] **Step 3: Replace the sidebar config**

While editing `astro.config.mjs`, also update the stale tool count in the top-level `description` (and the JSON-LD description below it): replace both occurrences of `74 MCP tools` with `79 MCP tools`.

Then replace the entire `sidebar: [...]` array with:

```js
sidebar: [
  {
    label: 'Start Here',
    items: [{ label: 'Getting Started', slug: 'getting-started' }],
  },
  {
    label: 'Core Concepts',
    items: [
      { label: 'Architecture', slug: 'architecture' },
      { label: 'Actions', slug: 'actions' },
      { label: 'Troubleshooting Memory', slug: 'troubleshooting-memory' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { label: 'React Native DevTools coexistence', slug: 'guides/devtools-coexistence' },
      { label: 'maestro-mcp interop', slug: 'guides/maestro-interop' },
      { label: 'Dev Client coverage', slug: 'dev-client-coverage' },
    ],
  },
  {
    label: 'Reference',
    items: [
      {
        label: 'Commands',
        collapsed: true,
        items: [
          { label: 'Overview', slug: 'commands' },
          { label: 'rn-feature-dev', slug: 'commands/rn-feature-dev' },
          { label: 'test-feature', slug: 'commands/test-feature' },
          { label: 'build-and-test', slug: 'commands/build-and-test' },
          { label: 'debug-screen', slug: 'commands/debug-screen' },
          { label: 'check-env', slug: 'commands/check-env' },
          { label: 'setup', slug: 'commands/setup' },
          { label: 'doctor', slug: 'commands/doctor' },
          { label: 'list-learned-actions', slug: 'commands/list-learned-actions' },
          { label: 'run-action', slug: 'commands/run-action' },
          { label: 'proof-capture', slug: 'commands/proof-capture' },
          { label: 'nav-graph', slug: 'commands/nav-graph' },
          { label: 'send-feedback', slug: 'commands/send-feedback' },
        ],
      },
      {
        label: 'MCP Tools',
        items: [
          { label: 'Overview', slug: 'tools' },
          { label: 'CDP Tools', collapsed: true, autogenerate: { directory: 'tools/cdp' } },
          { label: 'Device Tools', collapsed: true, autogenerate: { directory: 'tools/device' } },
          { label: 'Testing Tools', collapsed: true, autogenerate: { directory: 'tools/testing' } },
        ],
      },
      {
        label: 'Agents',
        collapsed: true,
        items: [
          { label: 'Overview', slug: 'agents' },
          { label: 'rn-tester', slug: 'agents/rn-tester' },
          { label: 'rn-debugger', slug: 'agents/rn-debugger' },
          { label: 'rn-code-explorer', slug: 'agents/rn-code-explorer' },
          { label: 'rn-code-architect', slug: 'agents/rn-code-architect' },
          { label: 'rn-code-reviewer', slug: 'agents/rn-code-reviewer' },
        ],
      },
      {
        label: 'Skills',
        collapsed: true,
        items: [
          { label: 'Overview', slug: 'skills' },
          { label: 'Device Control', slug: 'skills/rn-device-control' },
          { label: 'Testing', slug: 'skills/rn-testing' },
          { label: 'Debugging', slug: 'skills/rn-debugging' },
          { label: 'Best Practices', slug: 'skills/rn-best-practices' },
        ],
      },
      {
        label: 'Best Practices',
        items: [
          { label: 'Rule Index', slug: 'best-practices' },
          { label: 'Rules', collapsed: true, autogenerate: { directory: 'best-practices/rules' } },
        ],
      },
    ],
  },
  {
    label: 'Project',
    items: [
      { label: 'Benchmarks', slug: 'benchmarks' },
      { label: 'Troubleshooting', slug: 'troubleshooting' },
      { label: 'Changelog', slug: 'changelog' },
    ],
  },
],
```

(The Best Practices group keeps its rules subgroup for now; Task 3 collapses it to a single link.)

- [ ] **Step 4: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS, including the link check (no page moved, only sidebar grouping).

- [ ] **Step 5: Commit**

```bash
git add apps/docs-site/astro.config.mjs apps/docs-site/scripts/verify-site.mjs
git commit -S -m "feat(docs-site): journey-based sidebar IA (Start Here / Concepts / Guides / Reference / Project)"
```

---

### Task 3: Best Practices consolidation (one page, drop 47 generated rule pages)

**Files:**
- Delete: `apps/docs-site/src/content/docs/best-practices/rules/` (entire directory)
- Delete: `apps/docs-site/scripts/generate-bp-docs.mjs`
- Modify: `apps/docs-site/package.json` (`generate` script)
- Modify: `apps/docs-site/src/content/docs/best-practices/index.mdx` (rewrite)
- Modify: `apps/docs-site/astro.config.mjs` (sidebar: single Best Practices link)
- Modify: `apps/docs-site/scripts/verify-site.mjs` (assertions)

**Interfaces:**
- Consumes: sidebar structure from Task 2; `check`/`exists`/`page` from Task 1.
- Produces: `best-practices/` as a single page; the rules under `packages/shared-agent-knowledge/skills/rn-best-practices/` are untouched (plugin feature keeps working).

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.mjs`:

```js
console.log('\nverify-site: best-practices consolidation');
check('rule pages removed', !exists('best-practices/rules'));
const bp = page('best-practices/index.html');
check('overview links to Vercel agent-skills', bp.includes('github.com/vercel-labs/agent-skills'));
check('overview names a custom rule', bp.includes('reanimated-in-lists'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on `rule pages removed` and `overview names a custom rule`.

- [ ] **Step 3: Delete the generated pages and the generator**

```bash
git rm -r apps/docs-site/src/content/docs/best-practices/rules
git rm apps/docs-site/scripts/generate-bp-docs.mjs
```

In `apps/docs-site/package.json` change:

```json
"generate": "node scripts/generate-tool-docs.mjs"
```

In `astro.config.mjs`, replace the Best Practices group inside Reference with a single link:

```js
{ label: 'Best Practices', slug: 'best-practices' },
```

- [ ] **Step 4: Rewrite the overview page**

Replace `apps/docs-site/src/content/docs/best-practices/index.mdx` with:

```mdx
---
title: Best Practices
description: How the built-in React Native best-practice rules are checked during architecture design and code review.
---

The plugin ships a library of React Native best-practice rules that are
checked automatically during **Phase 4 (Architecture)** and **Phase 6
(Code Review)** of [`/rn-feature-dev`](/rn-dev-agent/commands/rn-feature-dev/).
Most rules are integrated from
[Vercel's agent-skills](https://github.com/vercel-labs/agent-skills)
(composition patterns, list performance, animations, state management) —
see that repository for the full rule text. The rules live inside the
plugin package and need no setup.

## Impact levels

| Level | Meaning | When checked |
|-------|---------|-------------|
| **CRITICAL** | Can cause crashes or data loss | Always checked |
| **HIGH** | Significant performance or UX impact | Always checked |
| **MEDIUM** | Noticeable improvement | Checked when relevant patterns present |
| **LOW** | Minor optimization | Checked on 3+ occurrences |

## Custom rules

Four rules were written for this plugin (not part of the Vercel set),
covering failure modes discovered while verifying features on device:

| Rule | Covers |
|------|--------|
| `navigation-transparent-modal` | Transparent modal screens that break navigation introspection |
| `query-cache-reactive` | React Query cache reads that silently go stale |
| `reanimated-in-lists` | Reanimated shared values inside virtualized list items |
| `theme-memoization-lists` | Theme-object identity churn re-rendering whole lists |

## How rules are applied

During architecture design the agent filters rules by trigger keywords and
file globs, then checks the CRITICAL and HIGH rules against the proposed
design. During code review the same filter runs against the diff. Findings
cite the rule id so you can look up the reasoning.
```

- [ ] **Step 5: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. The link check also proves no remaining page links into `best-practices/rules/`.

- [ ] **Step 6: Commit**

```bash
git add -A apps/docs-site
git commit -S -m "feat(docs-site): consolidate Best Practices to one overview page

Drops the 47 auto-generated republications of Vercel agent-skills rule
text and the generate-bp-docs.mjs generator. The rules themselves stay in
packages/shared-agent-knowledge — only the docs republication is removed."
```

---

### Task 4: Landing page foundation (page shell, hero, CTA band, footer — static)

Replaces the Starlight splash with a standalone Astro page. After this task the landing is complete and correct *without* animation (the terminal shows its full transcript; the phone shows its final screen) — Task 6 adds motion on top.

**Files:**
- Delete: `apps/docs-site/src/content/docs/index.mdx`
- Create: `apps/docs-site/src/pages/index.astro`
- Create: `apps/docs-site/src/styles/landing.css`
- Modify: `apps/docs-site/scripts/verify-site.mjs`

**Interfaces:**
- Consumes: `packages/claude-plugin/.claude-plugin/plugin.json` (`version` field) via JSON import.
- Produces: section anchors `#capabilities`, `#how-it-works` and the CSS classes/tokens (`--rda-*`, `.term`, `.t-line`, `.phone`, `.phone-screen`) that Tasks 5–6 build on. The terminal markup contract for Task 6: each transcript line is `li.t-line` with optional `data-screen="1|2|3"` (phone state to show when the line appears) and `data-hold` (ms pause after the line); the first line additionally has `data-type` (typed per-character).

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.mjs`:

```js
console.log('\nverify-site: landing foundation');
const landing = page('index.html');
check('headline present', landing.includes('This proves it runs.'));
check('install command present', landing.includes('/plugin marketplace add Lykhoyda/rn-dev-agent'));
check(
  'eyebrow version comes from plugin.json',
  landing.includes(
    `v${JSON.parse(readFileSync(join(DIST, '../../../packages/claude-plugin/.claude-plugin/plugin.json'), 'utf8')).version}`,
  ),
);
check('full transcript is static text', landing.includes('Verified on iPhone 16 Pro'));
check('links use base path', landing.includes('href="/rn-dev-agent/getting-started/"'));
check('no Starlight splash remnants', !landing.includes('class="hero"'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on all six (index.html is still the Starlight splash).

- [ ] **Step 3: Delete the splash page**

```bash
git rm apps/docs-site/src/content/docs/index.mdx
```

- [ ] **Step 4: Create `src/styles/landing.css`**

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --rda-bg: #0c1015;
  --rda-bg-raise: #12171e;
  --rda-panel: #1a2028;
  --rda-border: #252e37;
  --rda-border-strong: #3a4550;
  --rda-text: #e8edf2;
  --rda-text-mid: #c4cdd6;
  --rda-text-dim: #8e99a4;
  --rda-accent: #38bdf8;
  --rda-accent-soft: #0d2d3a;
  --rda-ok: #4ade80;
  --rda-sans: 'DM Sans', system-ui, sans-serif;
  --rda-mono: 'JetBrains Mono', ui-monospace, monospace;
}

* { box-sizing: border-box; margin: 0; }

html {
  background: var(--rda-bg);
  color-scheme: dark;
  scroll-behavior: smooth;
  -webkit-font-smoothing: antialiased;
}

body {
  font-family: var(--rda-sans);
  color: var(--rda-text);
  line-height: 1.6;
}

.wrap { max-width: 72rem; margin-inline: auto; padding-inline: 1.5rem; }

.eyebrow {
  font-family: var(--rda-mono);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--rda-accent);
}

.grain::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.025;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* ── Header ── */
.site-head {
  position: sticky;
  top: 0;
  z-index: 10;
  border-bottom: 1px solid var(--rda-border);
  background: color-mix(in srgb, var(--rda-bg) 88%, transparent);
  backdrop-filter: blur(10px);
}

.site-head .wrap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 3.5rem;
}

.wordmark {
  font-family: var(--rda-mono);
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--rda-text);
  text-decoration: none;
}

.wordmark span { color: var(--rda-accent); }

.site-nav { display: flex; gap: 1.5rem; }

.site-nav a {
  color: var(--rda-text-dim);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 500;
}

.site-nav a:hover { color: var(--rda-text); }

/* ── Hero ── */
.hero-section {
  position: relative;
  padding-block: 5rem 4rem;
  overflow: hidden;
}

.hero-section::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--rda-border) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 20%, black 30%, transparent 75%);
  opacity: 0.5;
}

.hero-inner { position: relative; text-align: center; }

.hero-inner h1 {
  margin-top: 1rem;
  font-size: clamp(2.1rem, 5vw, 3.4rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.12;
}

.hero-inner h1 em {
  font-style: normal;
  color: var(--rda-accent);
}

.hero-sub {
  max-width: 44rem;
  margin: 1.25rem auto 0;
  font-size: 1.08rem;
  color: var(--rda-text-dim);
}

.hero-ctas {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-top: 2rem;
}

.install-cmd {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--rda-mono);
  font-size: 0.85rem;
  background: var(--rda-bg-raise);
  border: 1px solid var(--rda-border-strong);
  border-radius: 8px;
  padding: 0.7rem 1rem;
}

.install-cmd::before { content: '❯'; color: var(--rda-accent); }

.install-cmd button {
  font: inherit;
  color: var(--rda-text-dim);
  background: none;
  border: 1px solid var(--rda-border);
  border-radius: 5px;
  padding: 0.15rem 0.5rem;
  cursor: pointer;
}

.install-cmd button:hover { color: var(--rda-text); border-color: var(--rda-border-strong); }

.btn-secondary {
  color: var(--rda-text);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.95rem;
  padding: 0.7rem 1.2rem;
  border: 1px solid var(--rda-border-strong);
  border-radius: 8px;
}

.btn-secondary:hover { border-color: var(--rda-accent); color: var(--rda-accent); }

/* ── Demo panel: terminal + phone ── */
.demo {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 2rem;
  align-items: center;
  max-width: 58rem;
  margin: 3.5rem auto 0;
}

.demo::before {
  content: '';
  position: absolute;
  inset: -3rem;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--rda-accent) 14%, transparent), transparent 70%);
  pointer-events: none;
}

.term {
  position: relative;
  background: var(--rda-bg-raise);
  border: 1px solid var(--rda-border-strong);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.term-bar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--rda-border);
  background: var(--rda-panel);
}

.term-bar i {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  background: var(--rda-border-strong);
}

.term-bar i:first-child { background: #f87171; }
.term-bar i:nth-child(2) { background: #fbbf24; }
.term-bar i:nth-child(3) { background: #34d399; }

.term-title {
  margin-left: 0.5rem;
  font-family: var(--rda-mono);
  font-size: 0.7rem;
  color: var(--rda-text-dim);
}

.term-body {
  list-style: none;
  padding: 1rem 1.1rem 1.2rem;
  font-family: var(--rda-mono);
  font-size: 0.78rem;
  line-height: 1.9;
  min-height: 15rem;
}

.t-line { white-space: pre-wrap; }
.t-cmd { color: var(--rda-text); font-weight: 500; }
.t-tool { color: var(--rda-text-dim); }
.t-ok { color: var(--rda-ok); }
.t-final { color: var(--rda-ok); font-weight: 600; }
.t-caret {
  display: inline-block;
  width: 0.55em;
  height: 1.1em;
  vertical-align: text-bottom;
  background: var(--rda-accent);
  opacity: 0;
}

/* ── Phone mockup (pure CSS) ── */
.phone {
  position: relative;
  width: 13.5rem;
  aspect-ratio: 9 / 19;
  margin-inline: auto;
  background: #05070a;
  border: 3px solid var(--rda-border-strong);
  border-radius: 2.2rem;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.phone::before {
  content: '';
  position: absolute;
  top: 0.55rem;
  left: 50%;
  translate: -50% 0;
  width: 5rem;
  height: 1.15rem;
  background: #05070a;
  border-radius: 1rem;
  z-index: 3;
}

.phone-screen {
  position: absolute;
  inset: 0;
  padding: 2.2rem 0.9rem 1rem;
  background: var(--rda-bg-raise);
  opacity: 0;
  transition: opacity 0.45s ease;
}

.phone[data-screen='1'] .phone-screen[data-s='1'],
.phone[data-screen='2'] .phone-screen[data-s='2'],
.phone[data-screen='3'] .phone-screen[data-s='3'] { opacity: 1; }

.app-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.72rem;
  font-weight: 600;
  margin-bottom: 0.8rem;
}

.cart-dot { position: relative; width: 1.1rem; height: 1.1rem; border: 1.5px solid var(--rda-text-mid); border-radius: 3px; }

.cart-dot[data-count]::after {
  content: attr(data-count);
  position: absolute;
  top: -0.45rem;
  right: -0.5rem;
  min-width: 0.9rem;
  height: 0.9rem;
  font-size: 0.55rem;
  font-weight: 700;
  line-height: 0.9rem;
  text-align: center;
  color: #05070a;
  background: var(--rda-accent);
  border-radius: 999px;
}

.app-row {
  display: flex;
  gap: 0.55rem;
  align-items: center;
  padding: 0.5rem;
  border: 1px solid var(--rda-border);
  border-radius: 8px;
  margin-bottom: 0.5rem;
}

.app-thumb { width: 2rem; height: 2rem; border-radius: 6px; background: var(--rda-panel); }

.app-lines { flex: 1; }

.app-lines i {
  display: block;
  height: 0.4rem;
  border-radius: 3px;
  background: var(--rda-panel);
}

.app-lines i + i { margin-top: 0.3rem; width: 60%; }

.app-btn {
  font-size: 0.6rem;
  font-weight: 700;
  color: #05070a;
  background: var(--rda-accent);
  border-radius: 6px;
  padding: 0.3rem 0.55rem;
}

.app-total {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--rda-border);
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
  font-weight: 700;
}

/* ── Section scaffolding ── */
.section { padding-block: 4.5rem; }
.section-alt { background: var(--rda-bg-raise); border-block: 1px solid var(--rda-border); position: relative; }

.section h2 {
  font-size: clamp(1.5rem, 3vw, 2.1rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-top: 0.6rem;
}

.section .lead { max-width: 42rem; color: var(--rda-text-dim); margin-top: 0.9rem; }

/* ── Final CTA band ── */
.cta-band {
  text-align: center;
  background: linear-gradient(180deg, var(--rda-bg) 0%, var(--rda-accent-soft) 160%);
  border-top: 1px solid var(--rda-border);
  padding-block: 5rem;
}

.cta-band .hero-ctas { margin-top: 1.75rem; }

/* ── Footer ── */
.site-foot {
  border-top: 1px solid var(--rda-border);
  padding-block: 2rem;
  font-size: 0.85rem;
  color: var(--rda-text-dim);
}

.site-foot .wrap { display: flex; flex-wrap: wrap; gap: 1.5rem; justify-content: space-between; }
.site-foot a { color: var(--rda-text-mid); text-decoration: none; }
.site-foot a:hover { color: var(--rda-accent); }

@media (max-width: 48rem) {
  .demo { grid-template-columns: 1fr; }
  .phone { display: none; }
  .site-nav a:not(:last-child) { display: none; }
}
```

- [ ] **Step 5: Create `src/pages/index.astro`**

```astro
---
import '../styles/landing.css';
import plugin from '../../../../packages/claude-plugin/.claude-plugin/plugin.json';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const site = 'https://lykhoyda.github.io';
const title = 'rn-dev-agent — Your agent writes the code. This proves it runs.';
const description =
  'Claude Code and Codex plugin for React Native. Reads the component tree, store state, and navigation over CDP, taps real UI on iOS and Android, and replays verified flows in seconds.';
---

<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={`${site}${base}/`} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content="website" />
    <meta property="og:image" content={`${site}${base}/og-image.png`} />
    <meta name="twitter:card" content="summary_large_image" />
    <script
      type="application/ld+json"
      set:html={JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'rn-dev-agent',
        description,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux',
        url: `${site}${base}/`,
        softwareVersion: plugin.version,
        author: { '@type': 'Person', name: 'Anton Lykhoyda', url: 'https://github.com/Lykhoyda' },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      })}
    />
  </head>
  <body>
    <header class="site-head">
      <div class="wrap">
        <a class="wordmark" href={`${base}/`}>rn-dev-<span>agent</span></a>
        <nav class="site-nav">
          <a href={`${base}/getting-started/`}>Docs</a>
          <a href={`${base}/tools/`}>Tools</a>
          <a href={`${base}/benchmarks/`}>Benchmarks</a>
          <a href="https://github.com/Lykhoyda/rn-dev-agent">GitHub</a>
        </nav>
      </div>
    </header>

    <main>
      <section class="hero-section grain">
        <div class="wrap hero-inner">
          <p class="eyebrow">v{plugin.version} · Claude Code + Codex · iOS + Android</p>
          <h1>Your agent writes the code.<br /><em>This proves it runs.</em></h1>
          <p class="hero-sub">
            rn-dev-agent turns Claude Code and Codex into a React Native development partner.
            It reads the component tree, store state, and navigation stack over CDP, taps real
            UI on iOS and Android, and replays verified flows in seconds.
          </p>
          <div class="hero-ctas">
            <div class="install-cmd">
              <code id="install-cmd-text">/plugin marketplace add Lykhoyda/rn-dev-agent</code>
              <button type="button" data-copy aria-label="Copy install command">copy</button>
            </div>
            <a class="btn-secondary" href={`${base}/getting-started/`}>Get started →</a>
          </div>

          <div class="demo">
            <div class="term" id="hero-term">
              <div class="term-bar" aria-hidden="true">
                <i></i><i></i><i></i>
                <span class="term-title">claude — rn-dev-agent</span>
              </div>
              <ol class="term-body">
                <li class="t-line t-cmd" data-type data-screen="1" data-hold="700">❯ /rn-dev-agent:test-feature "cart badge updates on add"</li>
                <li class="t-line t-tool" data-hold="500">⚙ cdp_status              <span class="t-ok">✓ connected · Metro :8081</span></li>
                <li class="t-line t-tool" data-hold="500">⚙ cdp_navigate Products   <span class="t-ok">✓ 96 ms</span></li>
                <li class="t-line t-tool" data-screen="2" data-hold="700">⚙ device_press @addToCart <span class="t-ok">✓ 142 ms</span></li>
                <li class="t-line t-tool" data-hold="500">⚙ cdp_component_tree      <span class="t-ok">✓ CartBadge count=3</span></li>
                <li class="t-line t-tool" data-screen="3" data-hold="700">⚙ cdp_store_state cart    <span class="t-ok">✓ items: 3 · total: $47.00</span></li>
                <li class="t-line t-tool" data-hold="600">⚙ maestro_run cart-badge  <span class="t-ok">✓ replayed in 4.2 s</span></li>
                <li class="t-line t-final" data-hold="3500">✓ Verified on iPhone 16 Pro · action saved: add-to-cart</li>
              </ol>
            </div>
            <div class="phone" id="hero-phone" data-screen="3" aria-hidden="true">
              <div class="phone-screen" data-s="1">
                <div class="app-bar"><span>Products</span><span class="cart-dot"></span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div><span class="app-btn">ADD</span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div><span class="app-btn">ADD</span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div><span class="app-btn">ADD</span></div>
              </div>
              <div class="phone-screen" data-s="2">
                <div class="app-bar"><span>Products</span><span class="cart-dot" data-count="3"></span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div><span class="app-btn">ADD</span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div><span class="app-btn">ADD</span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div><span class="app-btn">ADD</span></div>
              </div>
              <div class="phone-screen" data-s="3">
                <div class="app-bar"><span>Cart</span><span class="cart-dot" data-count="3"></span></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div></div>
                <div class="app-row"><div class="app-thumb"></div><div class="app-lines"><i></i><i></i></div></div>
                <div class="app-total"><span>Total</span><span>$47.00</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Task 5 sections mount here: stats, problem, #capabilities, showcase, #how-it-works -->

      <section class="cta-band">
        <div class="wrap">
          <p class="eyebrow">Free · open source · MIT</p>
          <h2>Stop taking your agent's word for it.</h2>
          <div class="hero-ctas">
            <div class="install-cmd">
              <code>/plugin marketplace add Lykhoyda/rn-dev-agent</code>
              <button type="button" data-copy aria-label="Copy install command">copy</button>
            </div>
            <a class="btn-secondary" href={`${base}/getting-started/`}>Read the docs →</a>
          </div>
        </div>
      </section>
    </main>

    <footer class="site-foot">
      <div class="wrap">
        <span>© {new Date().getFullYear()} Anton Lykhoyda · MIT License</span>
        <nav class="site-nav">
          <a href={`${base}/getting-started/`}>Docs</a>
          <a href={`${base}/changelog/`}>Changelog</a>
          <a href="https://github.com/Lykhoyda/rn-dev-agent">GitHub</a>
        </nav>
      </div>
    </footer>

    <script>
      for (const btn of document.querySelectorAll('[data-copy]')) {
        btn.addEventListener('click', async () => {
          const code = btn.parentElement?.querySelector('code');
          if (!code) return;
          await navigator.clipboard.writeText(code.textContent ?? '');
          btn.textContent = 'copied';
          setTimeout(() => (btn.textContent = 'copy'), 1500);
        });
      }
    </script>
  </body>
</html>
```

- [ ] **Step 6: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. Also eyeball once: `corepack yarn workspace rn-dev-agent-docs preview` → open `http://localhost:4321/rn-dev-agent/` — hero renders, phone shows the cart screen (final state), transcript fully visible.

- [ ] **Step 7: Commit**

```bash
git add -A apps/docs-site
git commit -S -m "feat(docs-site): custom landing page foundation — hero, install CTA, static terminal + phone demo"
```

---

### Task 5: Landing below-the-fold sections (stats, problem→solution, capability grid, tabbed showcase, pipeline, CTA copy)

**Files:**
- Modify: `apps/docs-site/src/pages/index.astro` (replace the `<!-- Task 5 sections mount here ... -->` comment)
- Modify: `apps/docs-site/src/styles/landing.css` (append section styles)
- Modify: `apps/docs-site/scripts/verify-site.mjs`

**Interfaces:**
- Consumes: `.section`, `.section-alt`, `.wrap`, `.eyebrow`, `.term`/`.term-bar` classes and `--rda-*` tokens from Task 4.
- Produces: the finished static landing; nothing later depends on these DOM details.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.mjs`:

```js
console.log('\nverify-site: landing sections');
const landing2 = page('index.html');
check('stat strip present', landing2.includes('210×') && landing2.includes('79'));
check('problem section present', landing2.includes('Coding agents ship blind'));
check('three-layer grid present', ['Introspect', 'Interact', 'Replay'].every((w) => landing2.includes(w)));
check('tabbed showcase present', landing2.includes('cdp_component_tree') && landing2.includes('cdp_run_action'));
check('pipeline strip present', landing2.includes('Verify live'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on all five.

- [ ] **Step 3: Insert the sections**

Replace the `<!-- Task 5 sections mount here ... -->` comment in `index.astro` with:

```astro
<section class="stats" aria-label="Key numbers">
  <div class="wrap stats-row">
    <div class="stat"><strong>210×</strong><span>action replay speedup</span></div>
    <div class="stat"><strong>79</strong><span>MCP tools</span></div>
    <div class="stat"><strong>35 / 0</strong><span>stories built / crashes</span></div>
    <div class="stat"><strong>2</strong><span>platforms — iOS + Android</span></div>
  </div>
</section>

<section class="section">
  <div class="wrap problem-grid">
    <div>
      <p class="eyebrow">The problem</p>
      <h2>Coding agents ship blind.</h2>
      <p class="lead">
        They write the feature, satisfy the type-checker, and declare victory — without
        ever seeing the app run. "It should work now" is not verification.
      </p>
    </div>
    <div>
      <p class="eyebrow">The fix</p>
      <h2>Close the loop on device.</h2>
      <p class="lead">
        After implementing, the agent connects to your running app, navigates to the
        screen, reads the component tree and store state, exercises the real UI, and
        only then reports done — with the evidence attached.
      </p>
    </div>
  </div>
</section>

<section class="section section-alt grain" id="capabilities">
  <div class="wrap">
    <p class="eyebrow">Three layers, one contract</p>
    <h2>Introspect. Interact. Replay.</h2>
    <div class="cap-grid">
      <article class="cap-card">
        <h3><span>L1</span> Introspect</h3>
        <p>Read the running app's truth over Chrome DevTools Protocol — component tree, Redux/Zustand/React Query state, navigation, network, logs.</p>
        <pre><code>cdp_store_state cart
→ &#123; items: 3, total: 47.00 &#125;</code></pre>
      </article>
      <article class="cap-card">
        <h3><span>L2</span> Interact</h3>
        <p>Tap, type, swipe, and scroll through in-tree native runners — XCTest on iOS, UIAutomator2 on Android. Self-building, self-healing.</p>
        <pre><code>device_press @checkoutBtn
→ ✓ 142 ms · settled</code></pre>
      </article>
      <article class="cap-card">
        <h3><span>L3</span> Replay</h3>
        <p>Verified walks are saved as parameterized actions and replayed as prologues — a 14-minute interactive flow reruns in about 4 seconds.</p>
        <pre><code>cdp_run_action login
→ ✓ replayed in 3.8 s</code></pre>
      </article>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <p class="eyebrow">See the output</p>
    <h2>Tools that return evidence, not vibes.</h2>
    <div class="showcase">
      <input type="radio" name="tab" id="tab-tree" checked />
      <input type="radio" name="tab" id="tab-store" />
      <input type="radio" name="tab" id="tab-press" />
      <input type="radio" name="tab" id="tab-action" />
      <div class="tab-labels">
        <label for="tab-tree">cdp_component_tree</label>
        <label for="tab-store">cdp_store_state</label>
        <label for="tab-press">device_press</label>
        <label for="tab-action">cdp_run_action</label>
      </div>
      <div class="term tab-panels">
        <div class="term-bar" aria-hidden="true"><i></i><i></i><i></i></div>
        <pre class="tab-panel" data-tab="tree"><code>&#123; "testID": "cartBadge",
  "type": "Badge",
  "props": &#123; "count": 3, "visible": true &#125;,
  "children": [&#123; "type": "Text", "text": "3" &#125;] &#125;</code></pre>
        <pre class="tab-panel" data-tab="store"><code>&#123; "store": "cart", "kind": "zustand",
  "state": &#123; "items": 3, "total": 47.0,
             "lastAdded": "sku_2481" &#125; &#125;</code></pre>
        <pre class="tab-panel" data-tab="press"><code>&#123; "ok": true, "ref": "@addToCart",
  "meta": &#123; "timings_ms": &#123; "resolve": 18, "tap": 96, "settle": 28 &#125;,
           "keyboardGuard": "no_keyboard" &#125; &#125;</code></pre>
        <pre class="tab-panel" data-tab="action"><code>&#123; "action": "add-to-cart", "status": "passed",
  "durationMs": 4180, "autoRepair": "not-needed",
  "runRecord": ".rn-agent/actions/runs/2026-07-10.json" &#125;</code></pre>
      </div>
    </div>
  </div>
</section>

<section class="section section-alt" id="how-it-works">
  <div class="wrap">
    <p class="eyebrow">/rn-feature-dev</p>
    <h2>From description to verified feature.</h2>
    <ol class="pipeline">
      <li>Discover</li>
      <li>Explore</li>
      <li>Question</li>
      <li>Architect</li>
      <li>Implement</li>
      <li class="pipeline-hot">Verify live</li>
      <li>Review</li>
      <li>E2E proof</li>
    </ol>
    <p class="lead">
      Phase 6 is the difference: the agent drives the simulator, confirms the UI and
      state, and saves the verified walk as a replayable action for next time.
    </p>
  </div>
</section>
```

- [ ] **Step 4: Append the section styles to `landing.css`**

```css
/* ── Stat strip ── */
.stats { border-block: 1px solid var(--rda-border); background: var(--rda-bg-raise); }

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  padding-block: 2rem;
}

.stat { text-align: center; }

.stat strong {
  display: block;
  font-family: var(--rda-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(1.6rem, 3.5vw, 2.4rem);
  font-weight: 600;
  color: var(--rda-accent);
  letter-spacing: -0.02em;
}

.stat span { font-size: 0.82rem; color: var(--rda-text-dim); }

/* ── Problem grid ── */
.problem-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3rem;
}

/* ── Capability grid ── */
.cap-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
  margin-top: 2rem;
}

.cap-card {
  background: var(--rda-bg);
  border: 1px solid color-mix(in srgb, var(--rda-accent) 18%, var(--rda-border));
  border-radius: 10px;
  padding: 1.4rem;
}

.cap-card h3 { font-size: 1.05rem; font-weight: 600; }

.cap-card h3 span {
  font-family: var(--rda-mono);
  font-size: 0.68rem;
  color: var(--rda-accent);
  border: 1px solid var(--rda-accent-soft);
  background: var(--rda-accent-soft);
  border-radius: 4px;
  padding: 0.1rem 0.35rem;
  margin-right: 0.4rem;
  vertical-align: middle;
}

.cap-card p { font-size: 0.9rem; color: var(--rda-text-dim); margin-top: 0.6rem; }

.cap-card pre {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--rda-bg-raise);
  border: 1px solid var(--rda-border);
  border-radius: 8px;
  font-family: var(--rda-mono);
  font-size: 0.72rem;
  line-height: 1.6;
  overflow-x: auto;
}

.cap-card code { color: var(--rda-text-mid); }

/* ── Tabbed showcase (CSS-only) ── */
.showcase { margin-top: 2rem; }
.showcase > input { position: absolute; opacity: 0; pointer-events: none; }

.tab-labels { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }

.tab-labels label {
  font-family: var(--rda-mono);
  font-size: 0.78rem;
  color: var(--rda-text-dim);
  border: 1px solid var(--rda-border);
  border-radius: 6px;
  padding: 0.4rem 0.8rem;
  cursor: pointer;
}

#tab-tree:checked ~ .tab-labels label[for='tab-tree'],
#tab-store:checked ~ .tab-labels label[for='tab-store'],
#tab-press:checked ~ .tab-labels label[for='tab-press'],
#tab-action:checked ~ .tab-labels label[for='tab-action'] {
  color: var(--rda-accent);
  border-color: var(--rda-accent);
  background: var(--rda-accent-soft);
}

.tab-panels { max-width: 46rem; }

.tab-panel {
  display: none;
  padding: 1.1rem;
  font-family: var(--rda-mono);
  font-size: 0.78rem;
  line-height: 1.8;
  color: var(--rda-text-mid);
  overflow-x: auto;
}

#tab-tree:checked ~ .tab-panels .tab-panel[data-tab='tree'],
#tab-store:checked ~ .tab-panels .tab-panel[data-tab='store'],
#tab-press:checked ~ .tab-panels .tab-panel[data-tab='press'],
#tab-action:checked ~ .tab-panels .tab-panel[data-tab='action'] { display: block; }

/* ── Pipeline strip ── */
.pipeline {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
  margin-top: 2rem;
  counter-reset: phase;
}

.pipeline li {
  font-family: var(--rda-mono);
  font-size: 0.78rem;
  color: var(--rda-text-mid);
  border: 1px solid var(--rda-border);
  border-radius: 999px;
  padding: 0.45rem 0.9rem;
  counter-increment: phase;
}

.pipeline li::before { content: counter(phase) ' · '; color: var(--rda-text-dim); }

.pipeline .pipeline-hot {
  color: var(--rda-accent);
  border-color: var(--rda-accent);
  background: var(--rda-accent-soft);
  font-weight: 600;
}

@media (max-width: 48rem) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .problem-grid, .cap-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 5: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. Preview once more; check tabs switch with keyboard (radio inputs are focusable) and at a 390px-wide viewport nothing overflows horizontally.

- [ ] **Step 6: Commit**

```bash
git add -A apps/docs-site
git commit -S -m "feat(docs-site): landing sections — stats, problem/fix, capability grid, tabbed showcase, pipeline"
```

---

### Task 6: Terminal animation driver + phone sync

Progressive enhancement over Task 4's static markup. Without JS or with reduced motion, nothing changes visually from Task 4 (full transcript + final phone screen).

**Files:**
- Modify: `apps/docs-site/src/pages/index.astro` (add one `<script>` before `</body>`)
- Modify: `apps/docs-site/src/styles/landing.css` (animation-state styles)
- Modify: `apps/docs-site/scripts/verify-site.mjs`

**Interfaces:**
- Consumes: `#hero-term`, `#hero-phone`, `li.t-line` with `data-type` / `data-screen` / `data-hold` from Task 4.
- Produces: nothing downstream.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.mjs`:

The driver is a *processed* `<script>` (it uses TS generics), so Astro externalizes it into `dist/_astro/*.js`; the animation CSS likewise lands in `dist/_astro/*.css`, and `.t-caret` is created by JS — none of this appears in `index.html`. Assert on the built bundles:

```js
console.log('\nverify-site: terminal animation');
const bundle = readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join('');
check('driver respects reduced motion', bundle.includes('prefers-reduced-motion'));
check('driver uses IntersectionObserver', bundle.includes('IntersectionObserver'));
check('caret is aria-hidden', bundle.includes('t-caret') && bundle.includes('aria-hidden'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on all three.

- [ ] **Step 3: Add animation-state CSS**

Append to `landing.css`:

```css
/* ── Terminal animation states (only when the JS driver arms) ── */
.term.is-animated .t-line { opacity: 0; transform: translateY(4px); }

.term.is-animated .t-line.is-shown {
  opacity: 1;
  transform: none;
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.term.is-animated .t-caret { opacity: 1; animation: rda-blink 1s step-end infinite; }

@keyframes rda-blink { 50% { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .term.is-animated .t-line { opacity: 1; transform: none; }
  .term.is-animated .t-caret { animation: none; opacity: 0; }
  .phone-screen { transition: none; }
}
```

- [ ] **Step 4: Add the driver script**

Insert before `</body>` in `index.astro` (after the copy-button script):

```astro
<script>
  const term = document.getElementById('hero-term');
  const phone = document.getElementById('hero-phone');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (term && phone && !reduced && 'IntersectionObserver' in window) {
    const lines = [...term.querySelectorAll<HTMLElement>('.t-line')];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let running = false;
    let visible = false;

    async function typeLine(line: HTMLElement) {
      const full = line.textContent ?? '';
      line.textContent = '';
      const caret = document.createElement('span');
      caret.className = 't-caret';
      caret.setAttribute('aria-hidden', 'true');
      line.append(caret);
      line.classList.add('is-shown');
      for (const ch of full) {
        caret.before(ch);
        await sleep(18);
      }
      caret.remove();
    }

    async function play() {
      if (running) return;
      running = true;
      while (visible) {
        for (const line of lines) {
          line.classList.remove('is-shown');
          if (line.dataset.type) line.dataset.full ??= line.textContent ?? '';
        }
        phone.dataset.screen = '1';
        await sleep(400);
        for (const line of lines) {
          if (!visible) break;
          if (line.dataset.screen) phone.dataset.screen = line.dataset.screen;
          if (line.dataset.type) {
            line.textContent = line.dataset.full ?? '';
            await typeLine(line);
          } else {
            line.classList.add('is-shown');
          }
          await sleep(Number(line.dataset.hold ?? 450));
        }
      }
      running = false;
      for (const line of lines) line.classList.add('is-shown');
      phone.dataset.screen = '3';
    }

    term.classList.add('is-animated');
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) play();
      },
      { threshold: 0.35 },
    ).observe(term);
  }
</script>
```

- [ ] **Step 5: Build + verify + behavioral check**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. Then `corepack yarn workspace rn-dev-agent-docs preview` and check in a browser:
1. Animation plays when the hero is visible, loops with a ~3.5 s hold on the final line.
2. Phone screens change at the `data-screen` lines (1 → 2 → 3).
3. Scroll the terminal off-screen → animation stops burning frames (the driver breaks out after the current awaited step and idles).
4. Emulate reduced motion (DevTools → Rendering → prefers-reduced-motion: reduce, then reload) → full transcript is instantly visible, phone on final screen, no caret blink.
5. Disable JS → same complete transcript.

- [ ] **Step 6: Commit**

```bash
git add -A apps/docs-site
git commit -S -m "feat(docs-site): termynal-style hero animation with phone sync, reduced-motion + no-JS fallbacks"
```

---

### Task 7: Docs theme restyle (shared design language)

**Files:**
- Modify: `apps/docs-site/src/styles/custom.css`
- Modify: `apps/docs-site/astro.config.mjs` (`expressiveCode` option)
- Modify: `apps/docs-site/scripts/verify-site.mjs`

**Interfaces:**
- Consumes: `--rda-*` naming convention from Task 4 (tokens are duplicated here on purpose — the docs bundle must not import `landing.css`).
- Produces: nothing downstream.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.mjs` (asserts on the built CSS bundle — custom properties never appear in page HTML):

```js
console.log('\nverify-site: docs theme');
const cssBundle = readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join('');
check('docs css bundle contains rda theme tokens', cssBundle.includes('rda-docs-theme'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on the theme marker.

- [ ] **Step 3: Configure Expressive Code**

In `astro.config.mjs`, add inside the `starlight({...})` options:

```js
expressiveCode: {
  themes: ['github-dark'],
  styleOverrides: {
    borderColor: 'var(--sl-color-gray-5)',
    borderRadius: '8px',
    frames: {
      terminalTitlebarBackground: 'var(--sl-color-gray-6)',
      terminalTitlebarBorderBottomColor: 'var(--sl-color-gray-5)',
    },
  },
},
```

- [ ] **Step 4: Evolve `custom.css`**

Make these targeted edits (the file's existing structure stays):

1. At the top of `:root`, add the shared tokens and the theme marker custom property:

```css
:root {
  --rda-docs-theme: 1; /* marker consumed by verify-site */
  --rda-accent-soft: #0d2d3a;
  --rda-glow: 0 0 0 1px var(--sl-color-accent-low), 0 8px 32px rgba(56, 189, 248, 0.06);
  /* …existing --sl-* declarations stay… */
}
```

2. Append at file end:

```css
.sl-markdown-content h2 code,
.sl-markdown-content h3 code {
  font-size: 0.85em;
}

.card:hover {
  box-shadow: var(--rda-glow);
}

nav.sidebar details > summary:hover {
  color: var(--sl-color-white);
}

nav.sidebar .top-level > li > details > summary {
  margin-top: 0.5rem;
}
```

The `--rda-docs-theme: 1` declaration in `:root` is the marker Step 1's assertion finds in the CSS bundle (minifiers preserve custom-property declarations).

- [ ] **Step 5: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. Preview 3 representative pages (`architecture/`, `tools/`, one generated tool page) — code blocks use the github-dark theme with the bordered frame, sidebar groups render the new collapsed structure cleanly.

- [ ] **Step 6: Commit**

```bash
git add -A apps/docs-site
git commit -S -m "feat(docs-site): align docs theme with landing design language, github-dark code frames"
```

---

### Task 8: llms.txt

**Files:**
- Modify: `apps/docs-site/package.json` (new dependency)
- Modify: `apps/docs-site/astro.config.mjs` (plugin registration)
- Modify: `apps/docs-site/scripts/verify-site.mjs`

**Interfaces:**
- Produces: `dist/llms.txt` (+ `llms-full.txt`, `llms-small.txt`) served from the site root.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.mjs`:

```js
console.log('\nverify-site: llms.txt');
check('llms.txt generated', exists('llms.txt'));
check('llms.txt mentions the project', exists('llms.txt') && page('llms.txt').includes('rn-dev-agent'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on `llms.txt generated`.

- [ ] **Step 3: Install and register the plugin**

```bash
corepack yarn workspace rn-dev-agent-docs add -E starlight-llms-txt@0.10.0
```

**Version is pinned on purpose:** `0.11.0`+ peers on Astro `^7` / Starlight `>=0.41`; `0.10.0` is the last release compatible with this project's Astro 6 / Starlight 0.38 (verified against the npm registry during plan review). Do not bump it here, and do not force-resolve — a Starlight upgrade is separate work.

In `astro.config.mjs`:

```js
import starlightLlmsTxt from 'starlight-llms-txt';
```

and inside the `starlight({...})` options:

```js
plugins: [starlightLlmsTxt()],
```

- [ ] **Step 4: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. If even the pinned `0.10.0` fails against this exact Astro 6 minor, stop and surface the conflict rather than force-resolving (fallback decision for the reviewer: hand-roll a small `generate-llms-txt.mjs` emitting an index from the content collection).

- [ ] **Step 5: Commit**

```bash
git add apps/docs-site/package.json apps/docs-site/astro.config.mjs apps/docs-site/scripts/verify-site.mjs yarn.lock
git commit -S -m "feat(docs-site): expose llms.txt via starlight-llms-txt"
```

---

### Task 9: OG image (fixes currently-404 og:image)

`astro.config.mjs` and the landing both point at `og-image.png`, but `public/` contains no such file — the meta tag is broken today. Generate a brand-matched 1200×630 PNG with `sharp` (already a dependency) from an inline SVG.

**Files:**
- Create: `apps/docs-site/scripts/generate-og.mjs`
- Create (generated, committed): `apps/docs-site/public/og-image.png`
- Modify: `apps/docs-site/scripts/verify-site.mjs`

**Interfaces:**
- Produces: `public/og-image.png` (committed; the script is run manually, not in the build).

- [ ] **Step 1: Add failing assertion**

Append to `verify-site.mjs`:

```js
console.log('\nverify-site: og image');
check('og-image.png shipped', exists('og-image.png'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL.

- [ ] **Step 3: Create the generator**

Create `apps/docs-site/scripts/generate-og.mjs`:

```js
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/og-image.png');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#0c1015"/>
  <g fill="none" stroke="#252e37" stroke-width="1">
    ${Array.from({ length: 22 }, (_, i) => `<line x1="${i * 56}" y1="0" x2="${i * 56}" y2="630"/>`).join('')}
    ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 56}" x2="1200" y2="${i * 56}"/>`).join('')}
  </g>
  <rect width="1200" height="630" fill="url(#fade)"/>
  <defs>
    <radialGradient id="fade" cx="0.5" cy="0.4" r="0.9">
      <stop offset="0" stop-color="#0c1015" stop-opacity="0"/>
      <stop offset="1" stop-color="#0c1015" stop-opacity="0.92"/>
    </radialGradient>
  </defs>
  <text x="80" y="200" font-family="Menlo, monospace" font-size="30" fill="#38bdf8">❯ rn-dev-agent</text>
  <text x="80" y="290" font-family="Helvetica, Arial, sans-serif" font-size="58" font-weight="700" fill="#e8edf2">Your agent writes the code.</text>
  <text x="80" y="360" font-family="Helvetica, Arial, sans-serif" font-size="58" font-weight="700" fill="#38bdf8">This proves it runs.</text>
  <text x="80" y="440" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#8e99a4">React Native development partner for Claude Code and Codex</text>
  <text x="80" y="540" font-family="Menlo, monospace" font-size="22" fill="#4ade80">✓ Verified on iPhone 16 Pro · action saved</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out}`);
```

- [ ] **Step 4: Generate, build, verify**

```bash
cd apps/docs-site && node scripts/generate-og.mjs && cd ../..
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS. Open `apps/docs-site/public/og-image.png` and eyeball it renders correctly (text not clipped).

- [ ] **Step 5: Commit**

```bash
git add apps/docs-site/scripts/generate-og.mjs apps/docs-site/public/og-image.png apps/docs-site/scripts/verify-site.mjs
git commit -S -m "feat(docs-site): generate brand OG image (fixes 404 og:image)"
```

---

### Task 10: Full-site verification pass

**Files:**
- No new files. Runs the full gauntlet from the spec's §7.

- [ ] **Step 1: Clean build + full assertion run**

```bash
corepack yarn workspace rn-dev-agent-docs build
corepack yarn workspace rn-dev-agent-docs verify
```

Expected: every section PASS, exit 0.

- [ ] **Step 2: Browser pass (Playwright or Chrome DevTools MCP)**

Start `corepack yarn workspace rn-dev-agent-docs preview`, then against `http://localhost:4321/rn-dev-agent/`:

1. Screenshot the landing at 1440×900 and 390×844 — no horizontal overflow, hero legible at both.
2. Watch one full animation loop; confirm phone screens track the transcript.
3. Emulate `prefers-reduced-motion: reduce`, reload — full transcript instantly, no motion.
4. Navigate: header "Docs" → getting-started renders with the new sidebar; expand Reference → MCP Tools → CDP Tools; open one tool page.
5. Screenshot `architecture/` and `tools/` for the theme pass.
6. Fetch `http://localhost:4321/rn-dev-agent/llms.txt` — 200, contains page listing.

- [ ] **Step 3: Fix anything found, re-run Steps 1–2 until green**

- [ ] **Step 4: Final commit (if fixes were made)**

```bash
git add -A apps/docs-site
git commit -S -m "fix(docs-site): verification-pass fixes"
```

---

## Self-Review Notes

- **Spec coverage:** §1 landing (Tasks 4–6), §2 IA + BP (Tasks 2–3), §3 theme (Task 7), §4 extras (Tasks 8–9), §6 risks (base-path assertions in Task 4, root-route by deleting `index.mdx` in Task 4, link check from Task 1), §7 verification (Tasks 1, 10).
- **Type consistency:** `check`/`exists`/`page` helpers defined once (Task 1), used verbatim later; `#hero-term`/`#hero-phone`/`.t-line`/`data-screen`/`data-hold`/`data-type` contract defined in Task 4, consumed in Task 6.
- **Known judgment points for implementers:** Task 8 peer-range conflict has an explicit fallback decision; Task 1 pre-existing broken links get `KNOWN` skips, not silent fixes.
