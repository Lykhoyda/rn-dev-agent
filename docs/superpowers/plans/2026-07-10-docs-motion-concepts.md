# Docs Motion Concepts + Styling Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three motion-driven concept explainers (shared `ConceptScene` engine) to the docs, fix site-wide GFM table rendering (B166 root cause), add a PageTitle kicker, and polish docs typography.

**Architecture:** One shared scene engine (`ConceptScene.astro`: frame + driver + global step-mechanics CSS) with three declarative scene components embedded into existing MDX pages. The driver toggles `is-on`/`is-past` classes on `[data-step]` elements (slot content is outside Astro's scoped-style reach, so mechanics CSS is `is:global`, namespaced under `.concept-scene`). Static-complete default: without the driver's `is-animated` class every element is fully visible — no-JS/reduced-motion/crawler-safe, same invariant as the landing hero.

**Tech Stack:** Astro 6 + Starlight 0.38, vanilla TS in Astro `<script>`, `remark-gfm` (new direct dep, already in the transitive tree), existing `verify-site.ts` harness.

**Spec:** `docs/superpowers/specs/2026-07-10-docs-motion-concepts-design.md`
**Branch:** `feat/docs-motion-concepts` (cut from main after PR #546).

## Global Constraints

- Build/verify from repo root: `corepack yarn workspace rn-dev-agent-docs build` then `corepack yarn workspace rn-dev-agent-docs verify`. TDD: append assertions to the `TASK ASSERTIONS` section of `apps/docs-site/scripts/verify-site.ts` FIRST (RED), then implement (GREEN).
- Animations touch only `opacity`/`transform`. Reduced-motion + no-JS users see the complete, labeled diagram (CSS media override AND `matchMedia` guard).
- New scripts/files are TypeScript (repo TypeScript-only gate; `.mjs` fails CI). Astro components may use TS in front-matter and `<script>`.
- No new deps except `remark-gfm` (pin to the range already in the lockfile: `^4.0.1`).
- No changes to generated reference pages, their generator, or the landing page.
- `rn-dev-agent-docs` is changesets-ignored — no changeset needed.
- Repo conventions: no unnecessary comments; explicit type imports; commits signed (`git commit -S`; on signer failure retry `--no-gpg-sign` and note it), small, per-task.
- Pre-push hook runs oxlint + oxfmt `--check`: run `npx oxfmt <changed js/ts/css files>` before each commit.

---

### Task 1: Site-wide GFM table fix (B166 root cause)

Diagnosis (verified by controller spike): GFM tables render in `.md` pages but in ZERO `.mdx` pages — the Astro 6 + MDX 5 pipeline drops GFM. Adding `remark-gfm` explicitly to `markdown.remarkPlugins` restores tables site-wide (architecture: 0 → 6 tables) without double-applying to `.md` pages. The architecture.mdx table source was never malformed.

**Files:**
- Modify: `apps/docs-site/package.json` (add dependency)
- Modify: `apps/docs-site/astro.config.mjs` (import + `markdown` option)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Produces: working `<table>` rendering on all `.mdx` pages; later tasks' pages rely on it.

- [ ] **Step 1: Add failing assertions**

Append to the `TASK ASSERTIONS` section of `verify-site.ts`:

```ts
console.log('\nverify-site: gfm tables (B166)');
const archHtml = page('architecture/index.html');
check('architecture tables render', (archHtml.match(/<table/g) ?? []).length >= 5);
check('tools overview table renders', page('tools/index.html').includes('<table'));
check('md pages unaffected', (page('dev-client-coverage/index.html').match(/<table/g) ?? []).length === 1);
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on `architecture tables render` and `tools overview table renders`; `md pages unaffected` passes.

- [ ] **Step 3: Implement**

```bash
corepack yarn workspace rn-dev-agent-docs add remark-gfm@^4.0.1
```

In `astro.config.mjs`, add the import after the existing imports:

```js
import remarkGfm from 'remark-gfm';
```

and add the `markdown` option as the first key inside `defineConfig({...})`:

```js
markdown: { remarkPlugins: [remarkGfm] },
```

- [ ] **Step 4: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS (all three new assertions and every pre-existing block).

- [ ] **Step 5: Format + commit (include yarn.lock)**

```bash
npx oxfmt apps/docs-site/astro.config.mjs apps/docs-site/scripts/verify-site.ts
git add apps/docs-site/package.json apps/docs-site/astro.config.mjs apps/docs-site/scripts/verify-site.ts yarn.lock
git commit -S -m "fix(docs-site): restore GFM tables on MDX pages via explicit remark-gfm (B166)

Astro 6 + MDX 5 dropped implicit GFM for .mdx; .md pages were unaffected.
Root cause of B166 — the architecture table source was never malformed."
```

---

### Task 2: ConceptScene engine + VerifyLoopScene (Getting Started embed)

The engine is only testable through a consumer, so the first scene ships with it.

**Files:**
- Create: `apps/docs-site/src/components/concepts/ConceptScene.astro`
- Create: `apps/docs-site/src/components/concepts/VerifyLoopScene.astro`
- Modify: `apps/docs-site/src/content/docs/getting-started.mdx` (embed)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Produces (consumed by Tasks 3–4): `<ConceptScene id: string, title?: string, caption?: string, steps: number, stepMs?: number (default 1400), holdMs?: number (default 3200)>` with slotted scene markup. Choreography contract: any slotted element with `data-step="N"` reveals at step N; optional `data-until="M"` dims it (35% opacity) after step M. Global classes the driver manages: `is-animated` on the figure root, `is-on`/`is-past` on step elements. The figure root carries `data-scene-id`.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: concept scenes — engine + verify loop');
const gsHtml = page('getting-started/index.html');
check('verify-loop scene mounted', gsHtml.includes('data-scene-id="verify-loop"'));
check('scene static-complete', gsHtml.includes('report with evidence'));
const sceneBundle = readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join('') + gsHtml;
check('scene driver present', sceneBundle.includes('data-scene-id') && sceneBundle.includes('is-animated'));
check('scene driver guards reduced motion', sceneBundle.includes('prefers-reduced-motion'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on all four.

- [ ] **Step 3: Create `ConceptScene.astro`**

```astro
---
interface Props {
  id: string;
  title?: string;
  caption?: string;
  steps: number;
  stepMs?: number;
  holdMs?: number;
}
const { id, title, caption, steps, stepMs = 1400, holdMs = 3200 } = Astro.props;
---

<figure
  class="concept-scene not-content"
  data-scene-id={id}
  data-steps={steps}
  data-step-ms={stepMs}
  data-hold-ms={holdMs}
>
  {title && <figcaption class="scene-title">{title}</figcaption>}
  <div class="scene-stage"><slot /></div>
  {caption && <p class="scene-caption">{caption}</p>}
</figure>

<style is:global>
  .concept-scene {
    margin: 1.75rem 0;
    padding: 1.25rem 1.4rem 1.1rem;
    background: var(--sl-color-gray-7);
    border: 1px solid var(--sl-color-gray-5);
    border-radius: 10px;
  }

  .concept-scene .scene-title {
    font-family: var(--sl-font-system-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--sl-color-accent);
    margin-bottom: 1rem;
  }

  .concept-scene .scene-caption {
    font-size: 0.82rem;
    color: var(--sl-color-gray-2);
    margin: 0.9rem 0 0;
  }

  .concept-scene.is-animated [data-step] {
    opacity: 0;
    transform: translateY(4px);
    transition:
      opacity 0.3s ease,
      transform 0.3s ease;
  }

  .concept-scene.is-animated [data-step].is-on {
    opacity: 1;
    transform: none;
  }

  .concept-scene.is-animated [data-until].is-past {
    opacity: 0.35;
  }

  @media (prefers-reduced-motion: reduce) {
    .concept-scene.is-animated [data-step] {
      opacity: 1;
      transform: none;
      transition: none;
    }
    .concept-scene.is-animated [data-until].is-past {
      opacity: 1;
    }
  }
</style>

<script>
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const scene of document.querySelectorAll<HTMLElement>('[data-scene-id]')) {
    const steps = Number(scene.dataset.steps ?? 0);
    if (!steps || reduced || !('IntersectionObserver' in window)) continue;
    const stepMs = Number(scene.dataset.stepMs ?? 1400);
    const holdMs = Number(scene.dataset.holdMs ?? 3200);
    const parts = [...scene.querySelectorAll<HTMLElement>('[data-step]')];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let visible = false;
    let running = false;

    const apply = (active: number) => {
      for (const el of parts) {
        el.classList.toggle('is-on', Number(el.dataset.step) <= active);
        el.classList.toggle('is-past', active > Number(el.dataset.until ?? Infinity));
      }
    };

    const play = async () => {
      if (running) return;
      running = true;
      scene.classList.add('is-animated');
      while (visible) {
        for (let s = 1; s <= steps && visible; s += 1) {
          apply(s);
          await sleep(s === steps ? holdMs : stepMs);
        }
      }
      running = false;
      apply(steps);
    };

    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) play();
      },
      { threshold: 0.35 },
    ).observe(scene);
  }
</script>
```

Notes for the implementer: `not-content` opts the figure out of Starlight's content styling; the mechanics CSS is `is:global` because slotted scene markup is outside this component's scope — everything is namespaced under `.concept-scene` so nothing leaks. The spec described cycling a `data-active` attribute; class-toggling per element is the working equivalent under the slot-scoping constraint (attribute-only CSS cannot compare numbers) — this deviation is pre-adjudicated, implement as written.

- [ ] **Step 4: Create `VerifyLoopScene.astro`**

```astro
---
import ConceptScene from './ConceptScene.astro';
---

<ConceptScene
  id="verify-loop"
  title="The verification loop"
  caption="Phase 6 of /rn-feature-dev: the agent proves the feature on the simulator before reporting done."
  steps={6}
>
  <ol class="vl-loop">
    <li data-step="1"><b>Implement</b><span>writes the feature</span></li>
    <li data-step="2"><b>Connect</b><span>CDP over WebSocket</span></li>
    <li data-step="3"><b>Navigate</b><span>to the changed screen</span></li>
    <li data-step="4"><b>Read</b><span>component tree + store state</span></li>
    <li data-step="5"><b>Exercise</b><span>taps the real UI</span></li>
    <li data-step="6" class="vl-final"><b>Report</b><span>with evidence</span></li>
  </ol>
  <p class="vl-tagline" data-step="6">report with evidence — not "it should work now"</p>
</ConceptScene>

<style is:global>
  .vl-loop {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.6rem;
    list-style: none;
    padding: 0;
    margin: 0;
    counter-reset: vl;
  }

  .vl-loop li {
    counter-increment: vl;
    background: var(--sl-color-gray-6);
    border: 1px solid var(--sl-color-gray-5);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .vl-loop li::before {
    content: counter(vl);
    display: inline-block;
    font-family: var(--sl-font-system-mono);
    font-size: 0.65rem;
    color: var(--sl-color-accent);
    border: 1px solid var(--sl-color-accent-low);
    background: var(--sl-color-accent-low);
    border-radius: 4px;
    padding: 0 0.35rem;
    margin-bottom: 0.35rem;
  }

  .vl-loop b {
    display: block;
    color: var(--sl-color-white);
  }

  .vl-loop span {
    color: var(--sl-color-gray-2);
    font-size: 0.74rem;
  }

  .vl-loop .vl-final {
    border-color: var(--sl-color-accent);
    background: var(--sl-color-accent-low);
  }

  .vl-tagline {
    margin: 0.8rem 0 0;
    font-family: var(--sl-font-system-mono);
    font-size: 0.75rem;
    color: var(--sl-color-accent);
  }

  @media (max-width: 40rem) {
    .vl-loop {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
```

- [ ] **Step 5: Embed in `getting-started.mdx`**

Add the import at the top of the file (after the frontmatter closing `---`):

```mdx
import VerifyLoopScene from '../../components/concepts/VerifyLoopScene.astro';
```

Insert the component immediately BEFORE the `## Setup for your app` heading:

```mdx
## What happens after install

<VerifyLoopScene />
```

- [ ] **Step 6: Build + verify**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: PASS.

- [ ] **Step 7: Format + commit**

```bash
npx oxfmt apps/docs-site/src/components/concepts/ConceptScene.astro apps/docs-site/src/components/concepts/VerifyLoopScene.astro apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): ConceptScene engine + verify-loop explainer on Getting Started"
```

(If oxfmt does not process `.astro` files, format only `verify-site.ts` and note it in the report.)

---

### Task 3: ThreeLayerScene (Architecture embed)

**Files:**
- Create: `apps/docs-site/src/components/concepts/ThreeLayerScene.astro`
- Modify: `apps/docs-site/src/content/docs/architecture.mdx` (embed)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Consumes: `ConceptScene` props and `data-step`/`data-until` contract from Task 2.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: three-layer scene');
const archHtml2 = page('architecture/index.html');
check('three-layer scene mounted', archHtml2.includes('data-scene-id="three-layers"'));
check('busy chip present statically', archHtml2.includes('BUSY_FLOW_ACTIVE'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on both.

- [ ] **Step 3: Create `ThreeLayerScene.astro`**

```astro
---
import ConceptScene from './ConceptScene.astro';
---

<ConceptScene
  id="three-layers"
  title="Three layers, one contract"
  caption="L1 reads are always safe. L2 taps re-attach instead of evicting. L3 flows own the device — and the arbiter refuses conflicting work fast."
  steps={4}
>
  <div class="tl-grid">
    <div class="tl-layers">
      <div class="tl-band" data-step="1">
        <b>L1 · Introspect</b>
        <span>CDP reads — tree, store, nav</span>
        <i class="tl-tag">shared — always safe</i>
      </div>
      <div class="tl-band" data-step="2">
        <b>L2 · Interact</b>
        <span>native runner taps &amp; types</span>
        <i class="tl-tag">shared — re-attach, don't evict</i>
      </div>
      <div class="tl-band tl-flow" data-step="3">
        <b>L3 · Flow-replay</b>
        <span>Maestro flow runs end-to-end</span>
        <i class="tl-tag">exclusive — owns the device</i>
      </div>
    </div>
    <div class="tl-arrows">
      <span class="tl-arrow" data-step="1">⇢ reads</span>
      <span class="tl-arrow" data-step="2" data-until="2">⇢ tap</span>
      <span class="tl-chip" data-step="3" data-until="3">BUSY_FLOW_ACTIVE</span>
      <span class="tl-arrow tl-own" data-step="3">⇒ flow</span>
    </div>
    <div class="tl-device" aria-hidden="true"><i></i></div>
  </div>
  <p class="tl-rule" data-step="4">
    Reads never conflict · taps coexist · one flow at a time — enforced by the in-process arbiter.
  </p>
</ConceptScene>

<style is:global>
  .tl-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.9rem;
    align-items: center;
  }

  .tl-layers {
    display: grid;
    gap: 0.5rem;
  }

  .tl-band {
    border: 1px solid var(--sl-color-gray-5);
    background: var(--sl-color-gray-6);
    border-radius: 8px;
    padding: 0.55rem 0.75rem;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .tl-band b {
    display: block;
    color: var(--sl-color-white);
  }

  .tl-band span {
    color: var(--sl-color-gray-2);
    font-size: 0.72rem;
  }

  .tl-band .tl-tag {
    display: block;
    font-style: normal;
    font-family: var(--sl-font-system-mono);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--sl-color-accent);
    margin-top: 0.25rem;
  }

  .tl-band.tl-flow {
    border-color: var(--sl-color-accent);
    background: var(--sl-color-accent-low);
  }

  .tl-arrows {
    display: grid;
    gap: 0.7rem;
    font-family: var(--sl-font-system-mono);
    font-size: 0.72rem;
    color: var(--sl-color-gray-2);
  }

  .tl-arrow.tl-own {
    color: var(--sl-color-accent);
    font-weight: 600;
  }

  .tl-chip {
    font-family: var(--sl-font-system-mono);
    font-size: 0.6rem;
    letter-spacing: 0.05em;
    color: #fca5a5;
    border: 1px solid #7f1d1d;
    background: rgb(127 29 29 / 0.25);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    justify-self: start;
  }

  .tl-device {
    width: 3.4rem;
    aspect-ratio: 9 / 19;
    border: 2px solid var(--sl-color-gray-4);
    border-radius: 0.8rem;
    position: relative;
    background: var(--sl-color-gray-7);
  }

  .tl-device i {
    position: absolute;
    top: 0.3rem;
    left: 50%;
    translate: -50% 0;
    width: 1.2rem;
    height: 0.3rem;
    background: var(--sl-color-gray-4);
    border-radius: 999px;
  }

  .tl-rule {
    margin: 1rem 0 0;
    font-size: 0.8rem;
    color: var(--sl-color-gray-1);
    border-top: 1px solid var(--sl-color-gray-5);
    padding-top: 0.7rem;
  }

  @media (max-width: 40rem) {
    .tl-grid {
      grid-template-columns: 1fr;
    }
    .tl-device {
      display: none;
    }
  }
</style>
```

- [ ] **Step 4: Embed in `architecture.mdx`**

Add the import after the frontmatter:

```mdx
import ThreeLayerScene from '../../components/concepts/ThreeLayerScene.astro';
```

Insert `<ThreeLayerScene />` immediately AFTER the paragraph "The plugin is organized into three layers. Each one has a different job and gets used at a different point in the loop." and BEFORE the `| Layer | Job | Examples |` table (the table stays — it renders correctly since Task 1 and remains the reference detail).

- [ ] **Step 5: Build + verify, then commit**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
npx oxfmt apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): three-layer contract explainer on Architecture"
```

Expected: verify PASS before committing.

---

### Task 4: ActionsLifecycleScene (Actions embed)

**Files:**
- Create: `apps/docs-site/src/components/concepts/ActionsLifecycleScene.astro`
- Modify: `apps/docs-site/src/content/docs/actions/index.mdx` (embed)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Consumes: `ConceptScene` contract from Task 2.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: actions lifecycle scene');
const actionsHtml = page('actions/index.html');
check('actions scene mounted', actionsHtml.includes('data-scene-id="actions-lifecycle"'));
check('payoff numerals present statically', actionsHtml.includes('al-payoff') && actionsHtml.includes('14 min'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on both.

- [ ] **Step 3: Create `ActionsLifecycleScene.astro`**

```astro
---
import ConceptScene from './ConceptScene.astro';
---

<ConceptScene
  id="actions-lifecycle"
  title="The action lifecycle"
  caption="Every verified walk becomes a replayable action; drift is absorbed by auto-repair instead of a human re-record."
  steps={6}
>
  <ol class="al-flow">
    <li data-step="1"><b>Interactive walk</b><span>LLM discovers the flow</span></li>
    <li data-step="2"><b>Verified ✓</b><span>UI + state confirmed live</span></li>
    <li data-step="3"><b>Saved</b><span>.rn-agent/actions/&lt;name&gt;.yaml</span></li>
    <li data-step="4"><b>Replayed</b><span>as a prologue, next session</span></li>
    <li data-step="5"><b>UI drifts</b><span>a testID changes</span></li>
    <li data-step="6"><b>Auto-repaired ✓</b><span>cdp_repair_action patches &amp; retries</span></li>
  </ol>
  <div class="al-payoff" data-step="4">
    <span><strong>14 min</strong> interactive walk</span>
    <em>→</em>
    <span><strong>4 s</strong> replayed</span>
  </div>
</ConceptScene>

<style is:global>
  .al-flow {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.6rem;
    list-style: none;
    padding: 0;
    margin: 0;
    counter-reset: al;
  }

  .al-flow li {
    counter-increment: al;
    background: var(--sl-color-gray-6);
    border: 1px solid var(--sl-color-gray-5);
    border-radius: 8px;
    padding: 0.55rem 0.7rem;
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .al-flow li::before {
    content: counter(al);
    display: inline-block;
    font-family: var(--sl-font-system-mono);
    font-size: 0.62rem;
    color: var(--sl-color-accent);
    border: 1px solid var(--sl-color-accent-low);
    background: var(--sl-color-accent-low);
    border-radius: 4px;
    padding: 0 0.32rem;
    margin-bottom: 0.3rem;
  }

  .al-flow b {
    display: block;
    color: var(--sl-color-white);
  }

  .al-flow span {
    color: var(--sl-color-gray-2);
    font-size: 0.72rem;
  }

  .al-payoff {
    display: flex;
    align-items: baseline;
    gap: 0.9rem;
    margin-top: 1rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--sl-color-gray-5);
    font-size: 0.8rem;
    color: var(--sl-color-gray-2);
  }

  .al-payoff strong {
    font-family: var(--sl-font-system-mono);
    font-variant-numeric: tabular-nums;
    font-size: 1.3rem;
    color: var(--sl-color-accent);
    letter-spacing: -0.02em;
  }

  .al-payoff em {
    font-style: normal;
    color: var(--sl-color-gray-3);
  }

  @media (max-width: 40rem) {
    .al-flow {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
```

- [ ] **Step 4: Embed in `actions/index.mdx`**

Add the import next to the existing `Aside` import — NOTE the extra `../`: this file lives one directory deeper (`src/content/docs/actions/`) than the other two embed pages:

```mdx
import ActionsLifecycleScene from '../../../components/concepts/ActionsLifecycleScene.astro';
```

Insert `<ActionsLifecycleScene />` immediately BEFORE the `## Why we have actions — the LLM/pragmatic hybrid` heading.

- [ ] **Step 5: Build + verify, then commit**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
npx oxfmt apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): actions lifecycle explainer on Actions page"
```

Expected: verify PASS before committing.

---

### Task 5: PageTitle kicker override

**Files:**
- Create: `apps/docs-site/src/components/PageTitle.astro`
- Modify: `apps/docs-site/astro.config.mjs` (`components` map)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Consumes: `Astro.locals.starlightRoute.sidebar` (Starlight 0.38 route data): entries are `{ type: 'group', label, entries } | { type: 'link', href, isCurrent, ... }`.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: page-title kicker');
check('kicker on architecture', page('architecture/index.html').includes('page-kicker'));
check('kicker shows sidebar group', page('architecture/index.html').includes('Core Concepts'));
check('kicker on reference page', page('tools/index.html').includes('page-kicker'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on `kicker on architecture` and `kicker on reference page` (the `Core Concepts` string already exists in the sidebar HTML — that assertion may pass in RED; the `page-kicker` class checks are the real gate).

- [ ] **Step 3: Create `PageTitle.astro`**

```astro
---
import Default from '@astrojs/starlight/components/PageTitle.astro';

type Entry = { type: 'group'; label: string; entries: Entry[] } | { type: 'link'; isCurrent: boolean };

const containsCurrent = (entry: Entry): boolean =>
  entry.type === 'link' ? entry.isCurrent : entry.entries.some(containsCurrent);

let kicker: string | undefined;
try {
  const sidebar = (Astro.locals.starlightRoute?.sidebar ?? []) as Entry[];
  const group = sidebar.find((entry) => entry.type === 'group' && containsCurrent(entry));
  kicker = group && group.type === 'group' ? group.label : undefined;
} catch {
  kicker = undefined;
}
---

{kicker && <p class="page-kicker">{kicker}</p>}
<Default />

<style>
  .page-kicker {
    font-family: var(--sl-font-system-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--sl-color-accent);
    margin: 0 0 0.4rem;
  }
</style>
```

The `try/catch` + optional chaining is the spec's mandated degrade path: any route-shape surprise renders no kicker, never a broken title.

- [ ] **Step 4: Register the override**

In `astro.config.mjs`, extend the existing `components` map:

```js
components: {
  ThemeSelect: './src/components/ThemeSelect.astro',
  ThemeProvider: './src/components/ThemeProvider.astro',
  PageTitle: './src/components/PageTitle.astro',
},
```

- [ ] **Step 5: Build + verify, then commit**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
npx oxfmt apps/docs-site/astro.config.mjs apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): PageTitle kicker shows the page's sidebar group"
```

Expected: verify PASS before committing.

---

### Task 6: Docs rhythm pass + Steps/Badge restyle + Getting Started Steps

**Files:**
- Modify: `apps/docs-site/src/styles/custom.css` (append rhythm rules)
- Modify: `apps/docs-site/src/content/docs/getting-started.mdx` (Steps conversion)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Consumes: Starlight's built-in `<Steps>` component (`@astrojs/starlight/components`), which renders `<ol role="list" class="sl-steps">`.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: rhythm + steps');
check('getting-started uses Steps', page('getting-started/index.html').includes('sl-steps'));
const rhythmCss = readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join('');
check('rhythm rules shipped', rhythmCss.includes('rda-lead'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on both.

- [ ] **Step 3: Convert the Claude Code install flow to Steps**

In `getting-started.mdx`, add the import after the frontmatter:

```mdx
import { Steps } from '@astrojs/starlight/components';
```

Replace this exact block under `### Claude Code`:

````mdx
From inside Claude Code:

```bash
# 1. Add the marketplace
/plugin marketplace add Lykhoyda/rn-dev-agent

# 2. Install the plugin
/plugin install rn-dev-agent@rn-dev-agent

# 3. Reload plugins to activate
/reload-plugins
```
````

with:

````mdx
From inside Claude Code:

<Steps>

1. Add the marketplace:

   ```bash
   /plugin marketplace add Lykhoyda/rn-dev-agent
   ```

2. Install the plugin:

   ```bash
   /plugin install rn-dev-agent@rn-dev-agent
   ```

3. Reload plugins to activate:

   ```bash
   /reload-plugins
   ```

</Steps>
````

(Everything after — the local-development note onward — stays unchanged.)

- [ ] **Step 4: Append the rhythm rules to `custom.css`**

```css
/* ─── Rhythm pass (motion-concepts follow-up) ─── */
:root {
  --rda-lead: 1; /* marker consumed by verify-site */
}

.sl-markdown-content > p:first-child {
  font-size: 1.06rem;
  line-height: 1.7;
  color: var(--sl-color-gray-1);
}

.sl-markdown-content h2 {
  margin-block-start: 2.2em;
}

.sl-markdown-content h3 {
  margin-block-start: 1.6em;
}

.sl-markdown-content td:has(> code:only-child) {
  font-variant-numeric: tabular-nums;
}

starlight-toc a[aria-current='true'] {
  color: var(--sl-color-accent);
  box-shadow: inset 2px 0 0 var(--sl-color-accent);
  border-radius: 0;
}

.pagination-links > a {
  border: 1px solid var(--sl-color-gray-5);
  border-radius: 8px;
  box-shadow: none;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.pagination-links > a:hover {
  border-color: var(--sl-color-accent);
  box-shadow: var(--rda-glow);
}

.sl-steps > li {
  padding-bottom: 0.4rem;
}

.sl-steps > li::before {
  color: var(--sl-color-accent);
  background: var(--sl-color-accent-low);
  box-shadow: inset 0 0 0 1px var(--sl-color-accent-low);
  font-family: var(--sl-font-system-mono);
  font-weight: 600;
}
```

- [ ] **Step 5: Build + verify, then commit**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
npx oxfmt apps/docs-site/src/styles/custom.css apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): docs rhythm pass, restyled Steps, Getting Started install as Steps"
```

Expected: verify PASS before committing.

---

### Task 7: Full verification pass (controller-inline browser gauntlet)

**Runs LAST — after Tasks 8 and 9** (added by the 2026-07-11 spec amendment §4b).

**Files:** none new. Same pattern as the overhaul's Task 10.

- [ ] **Step 1: Clean build + full harness**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: every block PASS.

- [ ] **Step 2: Browser pass** (preview server + Playwright)

1. `architecture/`, `actions/`, `getting-started/`: each scene animates through its steps when scrolled into view; the `BUSY_FLOW_ACTIVE` chip appears at step 3 of the three-layer scene and dims after.
2. Reduced-motion emulation: every scene shows its complete labeled diagram immediately, no `is-animated` choreography.
3. 390 px width: scenes fit without horizontal overflow (grids collapse per their media queries).
4. Kicker renders above H1 on a Core Concepts page and a Reference page; the H1 itself is unchanged.
5. Tables on `architecture/` render as real tables (B166 visual close-out).
6. Getting Started shows the numbered Steps rail.
7. Zero console errors on all three pages.
8. GFM side-effect scan on the three touched pages: newly-active strikethrough/task-list/autolink syntax must not have changed any existing prose rendering (Task 1 enables these on all `.mdx` pages).

- [ ] **Step 3: Fix anything found, re-run until green; commit fixes**

```bash
git add apps/docs-site
git commit -S -m "fix(docs-site): verification-pass fixes"
```

---

### Task 8: Benchmarks redesign + landing stat swap (spec §4b)

**Files:**
- Modify: `apps/docs-site/src/content/docs/benchmarks.mdx` (full rewrite)
- Modify: `apps/docs-site/src/pages/index.astro` (one stat cell)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Consumes: nothing from earlier tasks. The landing stat-strip markup contract: each stat is `<div class="stat"><strong>…</strong><span>…</span></div>`.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: benchmarks redesign + stat swap');
const benchHtml = page('benchmarks/index.html');
check('benchmarks jargon removed', !benchHtml.includes('Ralph Loop') && !benchHtml.includes('Polar Star'));
check('stale dispatch tiers removed', !benchHtml.includes('agent-device daemon'));
check('benchmarks leads with verified-feature timing', benchHtml.includes('Description → verified feature'));
const landingStat = page('index.html');
check('stories stat replaced', !landingStat.includes('stories built / crashes'));
check('time-to-verified stat present', landingStat.includes('3–25 min'));
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on all five.

- [ ] **Step 3: Rewrite `benchmarks.mdx`**

Replace the entire file with:

```mdx
---
title: Benchmarks
description: Measured performance — from feature description to on-device verification, replay economics, and interaction latency.
---

Every number on this page comes from building real features on the public
test app (Expo Dev Client) with `/rn-feature-dev` — 35 completed features
across form wizards, charts, lists, notifications, and animations. No
synthetic micro-benchmarks.

## Description → verified feature

The end-to-end measurement that matters: from a one-line feature
description to code that has been implemented **and verified live on the
simulator** — component tree, store state, and interactions checked.

| Feature complexity | Examples | Time to verified |
|---|---|---|
| Simple | search field, toggle, store slice | 3–5 min |
| Medium | forms, charts, lists | 5–10 min |
| Complex | 3-step wizard, onboarding flow | 11–25 min |

Zero crashes and zero manual interventions across all 35 measured builds —
no human unblocking, no restarts.

### Where the time goes

| Pipeline phase | Typical share |
|---|---|
| Discovery, exploration, questions | ~3 min |
| Architecture | ~1 min |
| Implementation | ~5 min |
| Live on-device verification | ~5 min |
| Code review + fixes | ~4 min |
| Summary + E2E proof | ~2 min |

## Replay economics

Flows the agent has verified once are saved as
[actions](/rn-dev-agent/actions/) and replayed instead of rediscovered:

| | Interactive walk | Replayed action |
|---|---|---|
| 3-step wizard flow | ~14 min | ~4 s |

That is a ~210× speedup on every later session that needs the same flow
(login, navigation, multi-step setup). Across the measured features,
average session time dropped from ~12 min to ~4 min once the
corresponding actions existed.

## Device interaction latency

iOS interaction goes through an in-tree XCTest HTTP runner:

| Operation | Latency |
|---|---|
| Tap | ~216 ms |
| Accessibility-tree snapshot | ~5 ms |
| Screenshot | ~74 ms |
| Per-step overhead | ~1.4 s (vs ~3.1 s CLI baseline) |

The ~210 ms tap floor is XCTest's own event-synthesis limit.

## Libraries verified end-to-end

Features using these libraries were built and verified through the full
pipeline: react-hook-form, zod, @tanstack/react-query,
@gorhom/bottom-sheet, @shopify/flash-list, zustand, react-native-svg,
expo-notifications, react-native-reanimated,
react-native-gesture-handler, expo-haptics.

## Methodology

Timings are wall-clock, recorded on an Apple-silicon MacBook Pro with a
booted iOS simulator and Metro running, using the repository's public
test app. Complexity buckets reflect the feature's UI and state surface,
not lines of code. Latency numbers are medians over repeated runs.
```

- [ ] **Step 4: Swap the landing stat**

In `apps/docs-site/src/pages/index.astro`, replace:

```astro
<div class="stat"><strong>35 / 0</strong><span>stories built / crashes</span></div>
```

with:

```astro
<div class="stat"><strong>3–25 min</strong><span>description → verified feature</span></div>
```

(No other stat cells change.)

- [ ] **Step 5: Build + verify, format, commit**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
npx oxfmt apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): user-facing Benchmarks rewrite + time-to-verified landing stat

Removes internal codenames and the stale agent-device dispatch tiers;
replaces the 'stories built / crashes' stat with description→verified
timing (spec amendment 4b)."
```

Expected: verify PASS before committing.

---

### Task 9: Troubleshooting error-code catalog (spec §4b)

**Files:**
- Modify: `apps/docs-site/src/content/docs/troubleshooting.mdx` (full restructure)
- Modify: `apps/docs-site/scripts/verify-site.ts` (assertions)

**Interfaces:**
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Add failing assertions**

Append to `verify-site.ts`:

```ts
console.log('\nverify-site: troubleshooting catalog');
const tsHtml = page('troubleshooting/index.html');
check('quick-reference table present', tsHtml.includes('Quick reference') && tsHtml.includes('<table'));
check('error codes documented', ['RN_FAST_RUNNER_DOWN', 'BUSY_FOREIGN_FLOW', 'RUNNER_PROTOCOL_MISMATCH'].every((c) => tsHtml.includes(c)));
check('aside wall replaced', (tsHtml.match(/starlight-aside/g) ?? []).length <= 2);
```

- [ ] **Step 2: Run to verify failure**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
```

Expected: FAIL on all three (the current page is ~20 Asides, no quick table, no error codes).

- [ ] **Step 3: Restructure the page**

Rewrite `troubleshooting.mdx` with this exact structure. **Content rule:** every existing Aside's body text is PRESERVED (verbatim, minus the Aside wrapper) under a `###` heading matching its old title — the format changes, the fixes don't. The worked example below shows the conversion; apply it to all ~20 entries.

Frontmatter + lead:

```mdx
---
title: Troubleshooting
description: Symptom → fix quick reference, error-code catalog, and per-area fixes for rn-dev-agent.
---

Find your symptom in the quick reference, or jump to the
[error-code catalog](#error-codes) if a tool returned a code in
SCREAMING_SNAKE_CASE.

## Quick reference

| Symptom | Go to |
|---|---|
| CDP won't connect / 1006 | [Connection](#connection) |
| DevTools keeps disconnecting | [Connection](#connection) |
| `cdp_store_state` empty or errors | [Store state](#store-state) |
| Plugin/skills not detected | [Plugin install](#plugin-install) |
| Install/update fails (ENOTEMPTY, ENAMETOOLONG) | [Plugin install](#plugin-install) |
| Taps/flows fail on the device | [Device & flows](#device--flows) |
| A tool returned `RN_…`/`BUSY_…`/`RUNNER_…` | [Error codes](#error-codes) |
| Action replay fails | [Actions & setup](#actions--setup) |
```

Then five `##` sections — `## Connection`, `## Store state`, `## Plugin install`, `## Device & flows`, `## Actions & setup` — each containing the existing entries converted per this worked example (old → new):

Old:

```mdx
<Aside type="tip" title="Metro not found">
Start Metro first: `npx expo start` or `npx react-native start`. The plugin auto-detects ports 8081, 8082, 19000, and 19006.
</Aside>
```

New:

```mdx
### Metro not found

Start Metro first: `npx expo start` or `npx react-native start`. The plugin auto-detects ports 8081, 8082, 19000, and 19006.
```

Mapping of old sections → new: "Connection issues" → `## Connection`; "Store state issues" → `## Store state`; "Plugin issues" → `## Plugin install`; "Device issues" → `## Device & flows`; "Actions and setup" → `## Actions & setup`. Drop the now-unused `Aside` import ONLY if zero Asides remain; keeping ≤2 Asides for genuinely exceptional callouts is allowed (the assertion permits 2).

Then add the new `## Error codes` section between `## Device & flows` and `## Actions & setup`:

```mdx
## Error codes

Codes returned by `device_*`/flow tools, what they mean, and the fix.

### RN_FAST_RUNNER_DOWN / RN_ANDROID_RUNNER_DOWN

The in-tree device runner couldn't start. Check that the simulator/emulator
is booted and (Android) the SDK is available. iOS self-builds on first use —
a cold build takes several minutes; if it times out, pre-build once with
`xcodebuild build-for-testing` (see Getting Started) and re-open the device
session.

### BUSY_FOREIGN_FLOW

A foreign Maestro/XCUITest session (e.g. a standalone maestro-mcp) is
driving the same simulator. Wait for it to finish (the guard clears within
~5 s), use CDP reads and `device_screenshot` meanwhile, or disable the
guard with `RN_IOS_FOREIGN_GUARD=0`.

### BUSY_FLOW_ACTIVE

Your own Maestro flow holds the device (L3 is exclusive). Reads
(`cdp_component_tree`, `cdp_store_state`) still work mid-flow; taps are
refused on purpose until the flow ends.

### RUNNER_PROTOCOL_MISMATCH

The bridge and the native runner disagree on the wire protocol and the
automatic reinstall didn't clear it. iOS: delete
`scripts/rn-fast-runner/build/DerivedData` and re-open the device session
(cold rebuild). Android: rebuild the runner APKs
(`./gradlew :app:assembleDebug :app:assembleDebugAndroidTest`).

### RUNNER_COMMANDS_STALE / UNSUPPORTED_COMMAND

The runner build predates a newer command verb. Re-open the device session
(`device_snapshot action=open`) — the stale artifact is rebuilt
automatically (one multi-minute build on iOS). If a cold build still
reports missing commands, update the plugin checkout.

### KEYBOARD_OCCLUDED

A tap target sits under the software keyboard and the safe dismiss control
isn't available (iPhone standard QWERTY). Dismiss the keyboard first (e.g.
`cdp_evaluate` → `Keyboard.dismiss()`) or fill via `device_fill`, which is
JS-first and needs no keyboard. Opt the guard off with
`RN_KEYBOARD_GUARD=0`.

### DEVICE_BUSY

Another project's session holds this simulator (UDID-scoped ownership
lock). Close the other session, or wait — the lock self-heals when its
holder exits (PID-liveness + 90 s heartbeat staleness).

### STALE_REF

An `@ref` from an old snapshot no longer resolves uniquely. Re-run
`device_snapshot` and use a fresh ref; unique testID/label matches are
re-bound automatically, so persistent `STALE_REF` with a `candidates` list
means the match is ambiguous — disambiguate by testID.
```

- [ ] **Step 4: Build + verify, format, commit**

```bash
corepack yarn workspace rn-dev-agent-docs build && corepack yarn workspace rn-dev-agent-docs verify
npx oxfmt apps/docs-site/scripts/verify-site.ts
git add apps/docs-site
git commit -S -m "feat(docs-site): troubleshooting as symptom/error-code catalog

Quick-reference table + linkable sections replace the Aside wall; adds
the error-code reference (spec amendment 4b). Fix content preserved."
```

Expected: verify PASS before committing. (The harness's link check ignores `#anchor` fragments — manually confirm each quick-reference anchor resolves by checking the built HTML contains matching heading ids, e.g. `id="connection"`, `id="error-codes"`.)

---

## Self-Review Notes

- **Spec coverage:** §1 engine (Task 2), §2 scenes (Tasks 2–4; B166 absorbed by Task 1 with the *actual* root cause — the spec's "repair the table markup" was superseded by the verified diagnosis that the source was never malformed, and Task 1 fixes tables site-wide), §3 styling (Tasks 5–6), §4 verification (harness per task + Task 7), §5 non-goals honored (no landing changes, no generator changes, only `remark-gfm` added).
- **Type consistency:** `ConceptScene` props and `data-step`/`data-until`/`is-on`/`is-past` contract defined once (Task 2), consumed verbatim in Tasks 3–4; harness helpers unchanged from the overhaul.
- **Pre-adjudicated deviation:** class-toggling instead of the spec's `data-active`-only CSS (slot scoping makes numeric attribute comparison impossible in CSS); noted inside Task 2 Step 3 so the reviewer doesn't re-litigate it.
