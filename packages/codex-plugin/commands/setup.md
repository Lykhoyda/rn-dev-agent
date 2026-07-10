---
command: setup
description: Full onboarding for a new project — runs /doctor diagnostics, then injects the CLAUDE.md template + nav-ref instrumentation + Zustand store exposure so the plugin works without the user having to read documentation.
argument-hint: 
---

Run the rn-dev-agent onboarding flow. Two phases: diagnose what's installed, then inject the project-side wiring the plugin needs. Most users don't read the README — this command does the wiring for them.

For shell snippets, resolve the Codex package root first:

```bash
CODEX_PLUGIN_ROOT="${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-}}"
if [ -z "$CODEX_PLUGIN_ROOT" ] && [ -f "packages/codex-plugin/.codex-plugin/plugin.json" ]; then
  CODEX_PLUGIN_ROOT="packages/codex-plugin"
fi
if [ -z "$CODEX_PLUGIN_ROOT" ]; then
  CODEX_PLUGIN_MANIFEST="$(find "${CODEX_HOME:-$HOME/.codex}/plugins/cache" -path "*/rn-dev-agent/*/.codex-plugin/plugin.json" -print -quit 2>/dev/null || true)"
  [ -n "$CODEX_PLUGIN_MANIFEST" ] && CODEX_PLUGIN_ROOT="$(dirname "$(dirname "$CODEX_PLUGIN_MANIFEST")")"
fi
test -n "$CODEX_PLUGIN_ROOT" || { echo "rn-dev-agent Codex plugin root not found" >&2; exit 2; }
```

`CODEX_PLUGIN_ROOT` must point at the directory containing `.codex-plugin/plugin.json`.

## Phase 1 — Diagnose

Invoke the `rn-setup` skill (same as `/rn-dev-agent:doctor`). Walk all 16 prerequisite checks and present the table.

**Abort thresholds.** Only the rows that block ALL plugin functionality count as critical for onboarding:

- **CRITICAL (abort if any fail)**: Node.js version, CDP bridge dependencies. Platform-specific device-control row: **`rn-fast-runner` build artifacts on macOS targeting iOS**, OR **`rn-android-runner` build/install when targeting Android**. Both runners ship in-tree — there is no external CLI to install; they build/install on first use. iOS-only users don't need `rn-android-runner`; Android-only users don't need `rn-fast-runner`. Without the relevant device-control row green, the plugin can't drive the simulator/emulator. Show the one-time pre-build commands (if any) and ask the user to run them, then re-run `/rn-dev-agent:setup`.
- **DEFERRED (warn but continue)**: Metro dev server, iOS/Android simulator/emulator, CDP connection. A clean-clone user running `/setup` immediately after `git clone` typically hasn't started Metro or booted a simulator yet — that's a normal onboarding state, not a failure. The CLAUDE.md / nav-ref / Zustand / scaffold injection steps don't need Metro running. Phase 2 Step E verification (cdp_status) WILL skip with a note if Metro+simulator aren't up; the user can come back to it later.
- **OPTIONAL (note, continue)**: ffmpeg, physical-device prerequisites when no devices connected, the off-platform device row (e.g. `rn-android-runner` on an iOS-only macOS setup → N/A).

## Phase 2 — Inject project instructions

Once diagnostics pass, perform the five steps below (A–D inject; E verifies). **Each step must show the proposed change to the user (diff or new-file content) BEFORE writing.** Ask "Apply this change? [y/n]" and wait for confirmation. Skipped steps are recorded but don't abort the flow.

### A. CLAUDE.md project instructions

The plugin's full operating manual lives at `${CODEX_PLUGIN_ROOT}/CLAUDE-MD-TEMPLATE.md`. It documents the operating modes (Exploration/Debugging/Verification), tool selection guidance, multi-device routing escape hatches, anti-patterns, error-recovery patterns, and verification flow. Without this in the user's project CLAUDE.md, agents working on the project don't know which plugin tools to prefer.

1. **Symlink-inherited worktree preflight.** If `<cwd>/.rn-agent` is a symlink (`[ -L .rn-agent ]`), the corpus is inherited from a sibling core checkout (the documented git-worktree pattern: `.rn-agent` — and usually `CLAUDE.local.md` — symlinked back to core so every worktree shares one action corpus and one manual). Run two checks before anything is written:
   - **Scaffold health (protects Steps B/C):** resolve the target (`readlink`) and confirm it exists and contains `.scaffold-version` and `dev-bridge.ts`. If it doesn't, STOP the whole setup here with: *"inherited scaffold at `<target>` is missing or stale — run `/setup` in the core checkout first, then re-run here."* Steps B/C inject imports of `./.rn-agent/dev-bridge`; running them against a broken inherited scaffold leaves the worktree with code that cannot resolve, and Step D's guard below will (correctly) refuse to repair a symlinked corpus.
   - **Manual short-circuit (Step A only):** the symlink alone does NOT prove the manual is loaded — the SessionStart hook links `.rn-agent` but does not create `CLAUDE.local.md`. Skip the rest of Step A only when the marker `## React Native Development (rn-dev-agent)` is present in `<cwd>/CLAUDE.local.md`, with the note: *"manual inherited via CLAUDE.local.md from `<resolved core path>`; skipping template injection."* Do NOT append the template to `CLAUDE.md` in that case — the manual is already loaded from `CLAUDE.local.md`, and appending would duplicate the entire block; a stale inherited manual is refreshed in the core checkout, not through the worktree. If the marker is absent, offer to complete the worktree wiring by symlinking the core checkout's `CLAUDE.local.md` into the worktree (preferred — keeps one shared manual); only fall back to the normal injection path below if the user declines.
2. Check whether `CLAUDE.md` exists in the current working directory.
3. Read `${CODEX_PLUGIN_ROOT}/CLAUDE-MD-TEMPLATE.md`. The template body to inject is everything AFTER the first `---` separator line — the lines before that separator are author-facing instructions for the template itself, not for the user's project. Find the separator dynamically (don't trust a hardcoded line number; the preamble may grow).
4. Inject or refresh:
   - **No CLAUDE.md exists**: create one with the template body.
   - **CLAUDE.md exists, no rn-dev-agent block**: append the template body (look for the marker `## React Native Development (rn-dev-agent)` — if it's missing, append).
   - **CLAUDE.md exists, marker present**: sync-check the injected block against the current template instead of skipping blindly:
     1. Extract the project's injected block: it starts at the marker heading and ends at the `<!-- rn-dev-agent:template-end -->` sentinel line (inclusive) when present. Legacy injections predate the sentinel — for those, the block ends just before the next `## ` heading after the marker, or at EOF. (The template body contains exactly one `## ` heading, so a second one is user content, not template.)
     2. Compare the extracted block to the current template body (e.g. write both to temp files and `diff` them, ignoring leading/trailing blank lines).
     3. **Identical** → skip with a note ("CLAUDE.md template in sync").
     4. **Different** → the block is stale (or locally edited). Show the diff, warn that local edits *inside* the block will be overwritten (content before/after the block is preserved untouched), and ask "Apply this change? [y/n]". On yes, replace exactly the extracted block with the current template body — a legacy block gains the end sentinel in the process, so future refreshes are precisely delimited.
5. Show the diff before writing. After writing, confirm with the user.

### B. NavigationContainer ref — fiber-walk-first, bridge fallback

`cdp_navigate` and `cdp_nav_graph go` need a navigation ref to drive. The plugin's CDP-injected helpers (`__RN_AGENT.findNavRef()`) walk three globals + the React fiber tree + the `useNavigationContainerRef()` hooks chain and find the ref automatically for any project using React Navigation's blessed `<NavigationContainer ref={navigationRef}>` pattern. **Most apps need NO source mutation.** This step probes whether instrumentation is required and, if it is, prefers the dev-bridge pattern (1 call site in `App.tsx`) over the prior surgical patches.

#### Step B.1 — Probe (only if Metro + simulator are up)

If `cdp_status` returned `ok: true` in Phase 1, run a one-shot probe:
```
cdp_evaluate("typeof __RN_AGENT?.findNavRef === 'function' ? (__RN_AGENT.findNavRef() ? 'ok' : 'miss') : 'no-helpers'")
```
- `'ok'` → fiber walk found the ref. **Skip the rest of Step B with a note**: *"Nav ref auto-discovered via fiber walk; no instrumentation needed."* This is the common case for any project using React Navigation 6+ with `<NavigationContainer ref={…}>`.
- `'miss'` → helpers loaded but fiber walk found nothing. Continue to Step B.2.
- `'no-helpers'` → CDP not connected / app not bundled yet. Continue to Step B.2 conservatively.

If Metro / simulator are down (Phase 1 marked them DEFERRED), skip the probe and continue to Step B.2.

#### Step B.2 — Existing instrumentation? Skip (idempotent).

Grep `App.tsx` and the project's app entry candidates for any of:
- `globalThis.__NAV_REF__` (any assignment form)
- `__RN_DEV_BRIDGE__` (registration via the dev-bridge)
- The legacy `onReady` patch shape (`onReady={() => { if (__DEV__) globalThis.__NAV_REF__ = ...`)

If any match exists, skip with a note: *"Nav ref instrumentation already present; leaving in place."* Don't auto-migrate to the bridge pattern (cross-file `navigationRef` exports break under module-scope → hook moves; tracked as a follow-up `/migrate-bridge` story).

#### Step B.3 — Search for `<NavigationContainer>` and propose the bridge pattern.

```bash
grep -rln "NavigationContainer" --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" . 2>/dev/null | grep -vE "node_modules|\.expo|build|dist"
```

- **Expo Router project** (no `<NavigationContainer>` found, but `app/_layout.tsx` exists with `Stack`/`Slot` from `expo-router`): skip with a note. The fiber walk handles this via React Navigation's internal hooks chain — Step B.1's probe should have returned `'ok'`. If it returned `'miss'`, the project may need the `useDevExpoRouter()` hook (see follow-up issue) — surface that gap rather than mutating `app/_layout.tsx`.
- **No `NavigationContainer` and no Expo Router**: skip with a note. The plugin's nav tools won't work; user is on a non-React-Navigation router (rare).
- **Exactly one `NavigationContainer`**: propose the bridge pattern. The user's source change is two lines:

  ```typescript
  import { getBridge } from './.rn-agent/dev-bridge';

  // Inside the component (or at module scope, alongside the existing ref):
  getBridge()?.registerNavRef(navigationRef);
  ```

  No `__DEV__` guard at the call site — `getBridge()` returns null in production and the optional chain is a no-op. The dev-bridge file (shipped by Step D, `.rn-agent/dev-bridge.ts`) handles the `globalThis.__NAV_REF__ = ref` assignment internally, gated by `__DEV__`.

  Three sub-cases by where the existing `navigationRef` lives:
  - **Module-scope ref** (React Navigation's blessed pattern, most common): add the `getBridge()?.registerNavRef(navigationRef)` line right after the `createNavigationContainerRef()` call. Single line, no JSX changes.
  - **`useRef`-inside-component**: add `getBridge()?.registerNavRef(navigationRef.current)` inside `useEffect(() => { … }, [navigationRef])` so the ref is registered after `<NavigationContainer ref={…}>` populates `navigationRef.current`.
  - **No ref at all (function-component root)**: propose adding both the `createNavigationContainerRef()` at module scope AND the bridge call. Bigger diff than the other two cases — this is the only case the prior `/setup` was the simpler option, but the bridge form is still 1 import + 1 line of registration.

- **Multiple `NavigationContainer`s**: list them, ask which one is root, propose the bridge call only for that one.

Show the diff before writing.

### C. Zustand store exposure — single bridge call, no auto-managed file

`cdp_store_state` reads Zustand stores via `globalThis.__ZUSTAND_STORES__`. Unlike navigation refs, Zustand stores have no fiber-walkable signal — there's no equivalent of "auto-discover via fiber tree." So this step always proposes some user code change when Zustand is present, but the change is now a single bridge call instead of a per-store global assignment.

1. Search for Zustand-style store creation:
   ```bash
   grep -rlnE "from ['\"]zustand['\"]" --include="*.ts" --include="*.tsx" . 2>/dev/null | grep -vE "node_modules|\.expo|build|dist|\.next"
   ```
2. **No Zustand found**: skip with a note.
3. **Existing instrumentation? Skip (idempotent).** Grep the app entry for `globalThis.__ZUSTAND_STORES__` or `getBridge()?.registerStores`. If present, leave it alone.
4. **Stores found, no instrumentation yet**: collect the exported hook names (typically `useFooStore`, sometimes raw `fooStore`). Propose adding to the app entry (`App.tsx`, `App.ts`, `index.ts`, `app/_layout.tsx` for Expo Router):

   ```typescript
   import { getBridge } from './.rn-agent/dev-bridge';
   import { useFooStore } from './stores/foo';
   import { useBarStore } from './stores/bar';

   getBridge()?.registerStores({
     foo: useFooStore,
     bar: useBarStore,
   });
   ```

   No `__DEV__` guard at the call site — the bridge handles it internally and `getBridge()` returns null in production (the optional chain is a no-op).

   **Why a single call over an auto-generated `.rn-agent/stores.ts`:** an auto-managed file inside `.rn-agent/` would import from `../src/stores/...`, which is a dependency direction that violates D1208's spirit (the auto-generated artifact reaches outside its own folder) and breaks silently when the user moves a store file. Keeping the registration in the user's `App.tsx` puts the store imports next to the rest of their app entry and the IDE catches renames immediately.

5. Show the diff before writing.

### D. `.rn-agent/` directory scaffold

The plugin reads and writes only inside `<cwd>/.rn-agent/`. Without this directory, every plugin tool that persists state (action recordings, learned flows, nav-graph cache, sidecars) fails with `ENOENT` on first use. This step creates it from a versioned template.

The template lives at `${CODEX_PLUGIN_ROOT}/templates/rn-agent/` and contains: `README.md`, `.gitignore`, `.scaffold-version`, `skeleton.yaml`, `dev-bridge.ts`, `globals.d.ts`, `vercel-rules.config.json`, `actions/.gitkeep`, `fixtures/.gitkeep`, `proposals/.gitkeep`.

`dev-bridge.ts` and `globals.d.ts` are the user-facing surface for Steps B + C — `dev-bridge.ts` exposes `getBridge()?.registerNavRef(...)` / `registerStores(...)` (DEV-only via `__DEV__` guard) and `globals.d.ts` declares the global types so user code can call them without casts.

`vercel-rules.config.json` is the user-editable opt-in/opt-out surface for the Vercel rule audit hook (`/rn-dev-agent:check-vercel-rules`). It defines `enabledCategories`, `severityOverrides`, `baselinePath`, and `auditHook.enabled`. Default config enables all categories; severity is taken from upstream rule frontmatter.

1. **Detect existing scaffold.** **Symlink guard first:** if `<cwd>/.rn-agent` is a symlink (`[ -L .rn-agent ]`), the corpus is inherited from a sibling core checkout (git-worktree pattern). Resolve the target (`readlink`), read the target's `.scaffold-version`, and skip the scaffold/partial-add steps (D.1a–D.5) with the note: *"scaffold v<X> inherited via symlink from `<target>`; skipping."* Never first-time-scaffold over a symlink and never partial-add into a symlinked corpus — the files are shared with the core checkout, so scaffold updates belong there (run `/setup` in the core checkout instead). **Step D.6 (tsconfig include touch-up) still runs**: `tsconfig.json` is a per-worktree file, so the `.rn-agent/dev-bridge.ts` + `.rn-agent/globals.d.ts` include entries must be checked in THIS worktree even when the scaffold itself is inherited. Otherwise, treat `<cwd>/.rn-agent/` as already scaffolded if ANY of these signals are present:
   - `.rn-agent/.scaffold-version` exists (canonical marker)
   - Any of `.rn-agent/state/`, `.rn-agent/recordings/`, `.rn-agent/snapshots/`, `.rn-agent/diag/` exist (runtime dirs created by tools — proof the plugin has run)
   - `.rn-agent/actions/` contains any `*.yaml` file
   - `<cwd>/.rn-agent/` exists as a directory at all (even if empty — falls into the partial-add path so we don't try to `mv tmp dst` over it)
   
   If already scaffolded: read the version from `.scaffold-version` and compare to `${CODEX_PLUGIN_ROOT}/templates/rn-agent/.scaffold-version`. If they match → skip with a one-liner (`scaffold v<X> already in place`). If they differ → enter **partial-add path** (Step 1a below). Bump `.scaffold-version` on apply.

   **Step 1a — partial-add path.** List the relative paths of every file under `${CODEX_PLUGIN_ROOT}/templates/rn-agent/` and check which are missing from `<cwd>/.rn-agent/`. **Filter the missing set first**: for any path ending in `.gitkeep`, look at the parent directory in the destination. If the parent already exists AND contains any non-`.gitkeep` file, drop the marker from the missing set — its sole purpose (keeping an empty directory git-trackable) is already satisfied by real content, and copying it would add visual noise next to artifacts (issue #123). For each remaining missing file, copy it individually (e.g. `cp -RL "${CODEX_PLUGIN_ROOT}/templates/rn-agent/<relpath>" "$CWD/.rn-agent/<relpath>"`, creating any missing parent directories with `mkdir -p` first). Do NOT use the `mv tmp dst` pattern from Step 2 — `mv` of a directory onto an existing directory creates `dst/tmp/...` rather than merging, leaking nested junk. After copying the missing files, write the new version into `<cwd>/.rn-agent/.scaffold-version`.

2. **First-time scaffold.** Build the destination atomically:
   ```bash
   mkdir -p "$CWD/.rn-agent.tmp-$$"
   cp -RL "${CODEX_PLUGIN_ROOT}/templates/rn-agent/." "$CWD/.rn-agent.tmp-$$/"
   ```
   The `/.` suffix on the source ensures dotfiles (`.gitignore`, `.scaffold-version`) are included; `cp -RL` dereferences any symlinks. After copy, rename atomically:
   ```bash
   mv "$CWD/.rn-agent.tmp-$$" "$CWD/.rn-agent"
   ```
   If anything fails partway through, delete the tmp dir and surface the error — the user's project state is untouched.

3. **Two-prompt confirmation** (matches the per-step UX of A/B/C):
   - **Prompt 1 (low-risk meta files):** show file list — `README.md`, `.gitignore`, `.scaffold-version`, `actions/.gitkeep`, `fixtures/.gitkeep`, `proposals/.gitkeep`. Ask "Apply this change? [y/n]". On `n`, skip the entire step.
   - **Prompt 2 (user-editable code/config):** show inline previews of `skeleton.yaml`, `dev-bridge.ts`, `globals.d.ts`, and `vercel-rules.config.json`. Ask "Apply this change? [y/n]". On `n`, skip the user-editable files only — the meta files still get written.

   The two prompts let the user accept meta scaffolding while reviewing or declining each user-editable file individually if they already have an equivalent in their project.

4. **Post-write assertion.** Confirm `<cwd>/.rn-agent/.gitignore` and `<cwd>/.rn-agent/.scaffold-version` both exist. If the copy silently dropped them (some `cp` invocations skip dotfiles), surface the failure.

5. **Bootstrap nudge.** After successful scaffold, tell the user that `skeleton.yaml` ships with `appId: REPLACE_ME` and an empty `screens: {}` — they should set `appId` to their bundle ID (from `app.json` or `Info.plist`) and populate `screens:` by running `cdp_component_tree({ filter: '...' })` on each route while the app is running, then copying the testIDs into the file. (`/rn-dev-agent:nav-graph scan` populates `nav-graph.yaml`, not `skeleton.yaml` — the two artifacts are distinct.)

6. **tsconfig.include touch-up.** `dev-bridge.ts` and `globals.d.ts` live outside the user's typical `src/` root. Read `<cwd>/tsconfig.json` (if present) and check the `include` array. If `.rn-agent/` is not covered (typical tsconfig has `"include": ["src", ...]`), propose adding `".rn-agent/dev-bridge.ts"` and `".rn-agent/globals.d.ts"` to the include array so TypeScript type-checks the bridge file and picks up the global type augmentation in `globals.d.ts`. Without this step, `getBridge()?.registerNavRef(...)` calls compile but the global types are lost and IDE autocomplete on `globalThis.__NAV_REF__` etc. doesn't work. Show the diff; ask before writing.

### E. Verification

Run `cdp_status` to confirm the plugin can reach the app post-injection. If the app is currently running on a simulator and Metro is up, this should return `ok: true` with all features green. If not, surface the failure and ask the user to start Metro / boot a simulator first.

## Output

Present a summary table at the end:

| Step | Status | Notes |
|------|--------|-------|
| Diagnostics | PASS / PARTIAL (optional rows missing) / FAIL (aborted) | row counts |
| CLAUDE.md template | INJECTED / REFRESHED (was stale) / SKIPPED (in sync) / SKIPPED (symlink-inherited) / SKIPPED (user declined) | path |
| Nav ref | INJECTED / N/A (Expo Router) / SKIPPED (user declined) | filename:line |
| Zustand stores | INJECTED / N/A (no Zustand) / SKIPPED (user declined) | filename:line, store count |
| `.rn-agent/` scaffold | CREATED / PARTIAL (added missing files) / SKIPPED (already current) / SKIPPED (symlink-inherited) / SKIPPED (user declined) | scaffold version, file count |
| CDP reachable | OK / FAIL (Metro not running, etc.) | tool count |

End with:
- If all PASS: "Onboarding complete. Try `/rn-dev-agent:rn-feature-dev <feature description>` to start."
- If anything SKIPPED: list the skipped items and a one-line "to enable later, re-run `/rn-dev-agent:setup`".
- If FAIL: list the actionable next step.

## Idempotency

Re-running `/rn-dev-agent:setup` on an already-onboarded project must be safe:
- CLAUDE.md template: detects the marker, diffs the injected block against the current template, refreshes only when stale (with diff + confirmation) — in-sync blocks are skipped.
- Nav ref: detects existing `globalThis.__NAV_REF__` assignment, skips.
- Zustand: detects existing `globalThis.__ZUSTAND_STORES__` assignment, skips.
- `.rn-agent/` scaffold: reads `.rn-agent/.scaffold-version`. If equal to the template's version, skips. If older, lists template files missing from the project and offers to add only those (never overwrites existing files). Presence of any runtime dir (`state/`, `recordings/`, `snapshots/`, `diag/`) or any `actions/*.yaml` also counts as proof the scaffold has run, even if `.scaffold-version` is missing.
- Symlink-inherited worktree: `.rn-agent` is a symlink to a sibling core checkout; the wiring is complete when the manual marker also lives in `CLAUDE.local.md`. Step A skips template injection only when that marker is present (and offers to complete the symlink wiring when it isn't); Step D skips scaffold/partial-add but still checks the worktree's own `tsconfig.json` include. A missing/stale inherited scaffold halts setup before Steps B/C with a pointer to the core checkout. Nothing in the shared corpus is ever mutated from the worktree.

Tell the user up-front when nothing needs to be injected.

## Anti-patterns — do NOT do these in the injection phase

1. Modify any file without showing the diff first.
2. Inject without checking for the existing marker — duplicating the template would bloat the user's CLAUDE.md.
3. Skip the user-confirmation prompt — they may have customized their `NavigationContainer` setup in a way the auto-injection would clobber.
4. Wrap the `getBridge()?.registerNavRef(...)` / `registerStores(...)` call sites in a `if (__DEV__)` block. The dev-bridge file (Step D scaffolds `.rn-agent/dev-bridge.ts`) handles the `__DEV__` gate internally and returns `null` in production — wrapping again at the call site makes the `getBridge()?.` optional chain a dead branch in dev and breaks the documented Steps B.3 / C.4 examples. Trust the bridge's internal guard.
5. Use `xcrun simctl` / `adb` for diagnostics — Phase 1 delegates to the `rn-setup` skill, which uses the proper detection commands.
6. Overwrite any file inside `<cwd>/.rn-agent/` during partial-add. The user may have hand-edited `skeleton.yaml`, `actions/*.yaml`, or `nav-graph.yaml` between scaffolds — only add files that don't already exist.
7. Use `cp -r src/* dst/` for the scaffold copy. The glob skips dotfiles on some shells; `.gitignore` and `.scaffold-version` would silently disappear. Use `cp -RL src/. dst/` (note the trailing `/.`) or Node's `fs.cpSync(src, dst, { recursive: true })`.
8. Symlink `templates/rn-agent/` to the workspace test-app's `.rn-agent/`. Marketplace packaging would break and the workspace's app-specific testIDs would leak into every consumer project.
9. Scaffold, partial-add, or template-append through a symlink-inherited worktree (`.rn-agent` is a symlink; the manual marker lives in `CLAUDE.local.md` when wiring is complete). The shared corpus belongs to the sibling core checkout — mutating it from a worktree duplicates the manual or corrupts the corpus. Short-circuit per Steps A.1 / D.1, but DO still run the per-worktree tsconfig touch-up (D.6) and DO halt before Steps B/C when the inherited scaffold is missing or stale.

## When NOT to use `/rn-dev-agent:setup`

- The user just wants to check what's installed → `/rn-dev-agent:doctor` (diagnostic only, no project mutation).
- The user already onboarded their project → re-running is safe but not necessary.
- The user is trying to debug a runtime issue → `/rn-dev-agent:debug-screen` is the right tool.
