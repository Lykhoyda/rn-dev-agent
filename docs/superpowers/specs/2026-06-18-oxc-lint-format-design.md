# OXC (oxlint + oxfmt) adoption — design spec

**Date:** 2026-06-18
**Status:** Approved (pending implementation plan)
**Topic:** Add OXC linting (`oxlint`) and formatting (`oxfmt`) to the monorepo, enforced in CI.

## Problem

The repo has **no linter or formatter** for its own code. Code quality today is gated only by
the TypeScript compiler (`tsc` via `npm run build`), `node --test` suites, and a handful of bash
guard scripts in `.github/workflows/ci.yml`. The only ESLint config present
(`drivers/ios/WebDriverAgent/eslint.config.mjs`) belongs to the **vendored** Appium WebDriverAgent,
not to this project's source. There is no Prettier config anywhere.

Goal: adopt OXC's two tools — `oxlint` (linter) and `oxfmt` (formatter) — as the lint + format
layer for all hand-written code in the monorepo, enforced by a blocking CI gate.

## Tooling state (June 2026)

- **oxlint** — stable / production-ready (v1.70.x). Config: `.oxlintrc.json`. ~50–100× faster than ESLint.
  Not type-aware by default; runs file-by-file without needing each package's `tsconfig`/`node_modules`.
- **oxfmt** — **beta** (reached beta Feb 2026). Passes 100% of Prettier's JS/TS conformance tests;
  ~30× faster than Prettier, ~3× faster than Biome. Prettier-compatible defaults (`proseWrap: preserve`).
  Adopted by vuejs/core, vercel/turborepo, getsentry/sentry-javascript.
  Supported languages include JS/JSX/TS/TSX/JSON/JSONC/YAML/CSS/Markdown/MDX — but **not `.astro`**.

Because oxfmt is beta, its dependency version is pinned **exactly**.

## Repo surfaces (measured 2026-06-18)

| Area | Path | Files in scope |
|---|---|---|
| MCP server (core, shipped) | `scripts/cdp-bridge/src` + `scripts/cdp-bridge/test` | 385 `.ts/.tsx/.js/.mjs` |
| Root build/release scripts | `scripts/*.mjs` (top level) | 4 `.mjs` |
| Observability web SPA | `scripts/cdp-bridge/src/observability/web/src` | 1 `.tsx` |
| Docs site (Astro) | `docs-site/src` | 157 `.mdx`, 2 `.md`, 2 `.astro`, 1 `.ts`, 1 `.css` |

**Always excluded** (both tools): `**/node_modules/**`, `**/dist/**` (tracked `tsc` output),
`drivers/ios/WebDriverAgent/**` and `scripts/cdp-bridge/drivers/ios/WebDriverAgent/**` (vendored),
`.claude/worktrees/**` (duplicate working trees), `scripts/cdp-bridge/src/observability/web/dist/**`,
`docs-site/dist/`, `.astro/` cache, `.superpowers/`, `.remember/`.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Coverage | **Everything**: cdp-bridge + root scripts + web SPA + docs-site (subject to MDX rule below) |
| CI | **Blocking CI gate** (lint + format-check) on push + PR |
| First format pass | **Format now in one commit, no `.git-blame-ignore-revs`** |
| oxlint rule set | **Defaults (`correctness` category only)** — real bugs, near-zero false positives |
| Config layout | **Approach A** — single root config + root devDeps + one CI job |
| MDX handling | **B2** — formatter covers code only; `.md`/`.mdx` are **excluded** from oxfmt. oxlint still lints docs-site `.ts`. |

### Why Approach A (single root config)

`oxlint`/`oxfmt` are standalone binaries that operate on file paths and do not require each
package's `node_modules` or `tsconfig`. A single root install + single config covering all paths is
the least machinery for a monorepo where `docs-site/` and the web SPA are separate npm projects
(not root workspace members). Per-area rule differences, if ever needed, are expressed via an
`overrides` block in the one config rather than additional config files.

### Why B2 for MDX

"Everything" in `docs-site/` is 157 `.mdx` **prose** files, not code. Running a code formatter over
published documentation is a different risk profile (list-marker / code-fence / frontmatter
normalization across content), and MDX-with-components is oxfmt's least-battle-tested path. B2 keeps
the formatter to actual code (`.ts/.tsx/.js/.mjs/.css`) while still achieving 100% coverage of code;
docs prose is left untouched by the formatter. oxlint still lints the one docs-site `.ts` file.

## Design

### 1. Dependencies & config (repo root)

- `package.json` (root) → `devDependencies`: `oxlint` (pinned, e.g. `^1.70.0`), `oxfmt` (pinned exact, e.g. `0.x.y`).
- `.oxlintrc.json`:
  - `categories`: `correctness` enabled (default); others left off.
  - `ignorePatterns`: the "Always excluded" set above.
  - `overrides`: reserved (empty initially) for future per-area relaxations (e.g. test files).
- oxfmt config (`.oxfmtrc.json` — exact filename confirmed against current oxfmt docs at implementation time):
  - Formatter defaults (Prettier-compatible).
  - `ignore`: the "Always excluded" set **plus** `**/*.md` and `**/*.mdx` (B2).
- An ignore file (`.oxlintignore` / `.oxfmtignore`) is used instead of/in addition to inline
  `ignorePatterns` if the current tool versions prefer it; functionally equivalent.

### 2. npm scripts (root `package.json`)

```
"lint":         "oxlint",
"lint:fix":     "oxlint --fix",
"format":       "oxfmt",          // writes in place
"format:check": "oxfmt --check"   // CI / verification mode
```

(Exact CLI flags verified against installed tool versions during implementation.)

### 3. CI gate — `.github/workflows/ci.yml`

New job `lint-format` (sibling to the existing `test` job):

```yaml
lint-format:
  name: Lint & format
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@<sha>          # SHA-pinned, matching Phase-134.5 convention
    - uses: actions/setup-node@<sha>        # SHA-pinned; node-version: 22; cache: npm
    - run: npm ci
    - run: npm run lint
    - run: npm run format:check
```

Runs on `push: [main]` and `pull_request: [main]`, same triggers as the rest of CI. The
workflow-level `permissions: contents: read` already covers it (read-only).

### 4. Big-bang format commit

1. `npm run format` over all in-scope files (code only, per B2).
2. Commit the reformatted files in a single commit (no `.git-blame-ignore-revs`).
3. `npm run build` (cdp-bridge) + rebuild web bundle; commit `dist/` / bundle **only if changed**
   (expected: no change — `tsc` output is independent of source whitespace, and the web bundle is
   built from the AST, so the existing `web-bundle freshness` check stays green).

### 5. Lint-findings triage

With `correctness`-only over 385 files, findings should be few and genuine. Order of resolution:
1. `oxlint --fix` for auto-fixable findings.
2. Hand-fix the rest.
3. For any false positive, a **narrow** `// oxlint-disable-next-line <rule>` with a one-line reason —
   never a blanket file/rule disable, never relaxing a rule globally to hide a real issue.

### 6. Changeset

The format pass and config touch the published `rn-dev-agent-cdp` package's `src`, so the
`require-changeset` CI gate requires a **patch** changeset (e.g. `chore: adopt oxlint + oxfmt`).

## Out of scope

- Reformatting `.md`/`.mdx` docs (excluded by B2).
- Formatting `.astro` files (unsupported by oxfmt).
- Enabling oxlint categories beyond `correctness` (can be a later, separate increment).
- oxfmt import-sorting / Tailwind features (kept at defaults to bound the initial diff).
- Touching the vendored WebDriverAgent ESLint setup.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| oxfmt is beta | Pin exact version; it passes 100% Prettier conformance and is used by major projects. |
| Format commit churn / in-flight branch conflicts | Single self-contained commit; coordinate timing; no blame-ignore per decision. |
| `dist/` drift after reformat | Rebuild + commit only if changed; verified by existing build + web-bundle CI checks. |
| Worktree copies double-counted | `.claude/worktrees/**` in the ignore set. |
| Unexpected correctness findings block CI | Triage before landing the CI gate (steps 4–5 precede gate enforcement in the same PR). |

## Success criteria

- `npm run lint` exits 0 on the repo.
- `npm run format:check` exits 0 (codebase fully formatted, docs prose untouched).
- CI `lint-format` job is green on the adoption PR and blocks future drift.
- No behavior change: `npm run build` + all existing test/bundle/version CI jobs stay green.
- `dist/` and the web bundle remain in sync.
