---
command: setup
description: Full onboarding for a new project — runs /doctor diagnostics, then injects the CLAUDE.md template + nav-ref instrumentation + Zustand store exposure so the plugin works without the user having to read documentation.
argument-hint: 
---

Run the rn-dev-agent onboarding flow. Two phases: diagnose what's installed, then inject the project-side wiring the plugin needs. Most users don't read the README — this command does the wiring for them.

## Phase 1 — Diagnose

Invoke the `rn-setup` skill (same as `/rn-dev-agent:doctor`). Walk all 10 prerequisite checks and present the table.

**Abort thresholds.** Only the rows that block ALL plugin functionality count as critical for onboarding:

- **CRITICAL (abort if any fail)**: Node.js version, CDP bridge dependencies, agent-device CLI. Without these the plugin can't run AT ALL. Show the install commands and ask the user to run them, then re-run `/rn-dev-agent:setup`.
- **DEFERRED (warn but continue)**: Metro dev server, iOS/Android simulator/emulator, CDP connection. A clean-clone user running `/setup` immediately after `git clone` typically hasn't started Metro or booted a simulator yet — that's a normal onboarding state, not a failure. The CLAUDE.md / nav-ref / Zustand injection steps don't need Metro running. Phase 2 Step D verification (cdp_status) WILL skip with a note if Metro+simulator aren't up; the user can come back to it later.
- **OPTIONAL (note, continue)**: ffmpeg, physical-device prerequisites when no devices connected.

## Phase 2 — Inject project instructions

Once diagnostics pass, perform the four injection steps below. **Each step must show the proposed change to the user (diff or new-file content) BEFORE writing.** Ask "Apply this change? [y/n]" and wait for confirmation. Skipped steps are recorded but don't abort the flow.

### A. CLAUDE.md project instructions

The plugin's full operating manual lives at `${CLAUDE_PLUGIN_ROOT}/CLAUDE-MD-TEMPLATE.md`. It documents the operating modes (Exploration/Debugging/Verification), tool selection guidance, multi-device routing escape hatches, anti-patterns, error-recovery patterns, and verification flow. Without this in the user's project CLAUDE.md, agents working on the project don't know which plugin tools to prefer.

1. Check whether `CLAUDE.md` exists in the current working directory.
2. Read `${CLAUDE_PLUGIN_ROOT}/CLAUDE-MD-TEMPLATE.md`. The template body to inject is everything AFTER the first `---` separator line — the lines before that separator are author-facing instructions for the template itself, not for the user's project. Find the separator dynamically (don't trust a hardcoded line number; the preamble may grow).
3. Inject:
   - **No CLAUDE.md exists**: create one with the template body.
   - **CLAUDE.md exists, no rn-dev-agent block**: append the template body (look for the marker `## React Native Development (rn-dev-agent)` — if it's missing, append).
   - **CLAUDE.md exists, marker present**: skip with a note ("already injected; re-run after editing CLAUDE-MD-TEMPLATE if you want to refresh").
4. Show the diff before writing. After writing, confirm with the user.

### B. NavigationContainer ref instrumentation

`cdp_navigate` and `cdp_nav_graph go` need `globalThis.__NAV_REF__` set in dev mode. Without it, those tools fail with "Navigation ref not found" and agents have to fall back to `device_deeplink` (which has its own caveats — see #61 verification fidelity).

1. Search the project for `NavigationContainer`:
   ```bash
   grep -rln "NavigationContainer" --include="*.tsx" --include="*.ts" --include="*.jsx" --include="*.js" . 2>/dev/null | grep -vE "node_modules|\.expo|build|dist"
   ```
2. **No NavigationContainer found**: skip with a note. Likely Expo Router (uses `Slot`/`Stack` from `expo-router` which does its own ref management) — `cdp_navigate` should still work via Expo Router's nav state hook.
3. **Exactly one NavigationContainer**: read the file and detect which of the three setup shapes it has, then patch ONLY what's missing:
   - **Shape 1: existing `createNavigationContainerRef()` at module scope (preferred — React Navigation's blessed pattern).** Look for `import { createNavigationContainerRef }` and a top-level `const navigationRef = createNavigationContainerRef<...>()`. If present, only inject the `onReady` handler:
     ```typescript
     <NavigationContainer
       ref={navigationRef}
       onReady={() => {
         if (__DEV__) globalThis.__NAV_REF__ = navigationRef.current;
       }}
     >
     ```
     If the user already has an `onReady` handler, AUGMENT it (add the `if (__DEV__)` line) rather than replace it.
   - **Shape 2: existing `useRef` inside a function component.** Look for `const navigationRef = useRef<NavigationContainerRef<...>>(null)`. Add or augment the `onReady` handler the same way.
   - **Shape 3: no navigationRef at all (function-component root).** Add the full snippet:
     ```typescript
     // Recommended: createNavigationContainerRef at module scope. Works in
     // class components too and matches React Navigation's docs.
     import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
     
     export const navigationRef = createNavigationContainerRef<any>();
     
     // Inside the component:
     <NavigationContainer
       ref={navigationRef}
       onReady={() => {
         if (__DEV__) globalThis.__NAV_REF__ = navigationRef.current;
       }}
     >
     ```
   - **Shape 4: class-component root (rare, legacy apps).** Detect via `class App extends React.Component` or similar. Same module-scope `createNavigationContainerRef()` pattern as Shape 3 — class components can't `useRef` at the top level, so don't suggest the function-component variant.
4. **Multiple NavigationContainers**: list them, ask which one is the root and instrument that one (skip nested modal/stack containers — they don't need the global ref).
5. Show the diff before writing.

### C. Zustand store exposure

`cdp_store_state` reads Zustand stores via `globalThis.__ZUSTAND_STORES__`. Without this, only Redux + React Query are auto-detected; Zustand is invisible.

1. Search for Zustand-style store creation:
   ```bash
   grep -rlnE "from ['\"]zustand['\"]" --include="*.ts" --include="*.tsx" . 2>/dev/null | grep -vE "node_modules|\.expo|build|dist|\.next"
   ```
2. **No Zustand found**: skip with a note.
3. **Stores found**: collect the exported hook names (typically `useFooStore`, sometimes raw `fooStore`). Find the project's app entry point (`App.tsx`, `App.ts`, `index.ts`, `app/_layout.tsx` for Expo Router). Propose adding to that file:
   ```typescript
   import { useFooStore } from './stores/foo';
   import { useBarStore } from './stores/bar';
   // ... import every Zustand store
   
   if (__DEV__) {
     globalThis.__ZUSTAND_STORES__ = {
       foo: useFooStore,
       bar: useBarStore,
       // ... map each store to a short name
     };
   }
   ```
4. Show the diff before writing.

### D. Verification

Run `cdp_status` to confirm the plugin can reach the app post-injection. If the app is currently running on a simulator and Metro is up, this should return `ok: true` with all features green. If not, surface the failure and ask the user to start Metro / boot a simulator first.

## Output

Present a summary table at the end:

| Step | Status | Notes |
|------|--------|-------|
| Diagnostics | PASS / PARTIAL (optional rows missing) / FAIL (aborted) | row counts |
| CLAUDE.md template | INJECTED / SKIPPED (already present) / SKIPPED (user declined) | path |
| Nav ref | INJECTED / N/A (Expo Router) / SKIPPED (user declined) | filename:line |
| Zustand stores | INJECTED / N/A (no Zustand) / SKIPPED (user declined) | filename:line, store count |
| CDP reachable | OK / FAIL (Metro not running, etc.) | tool count |

End with:
- If all PASS: "Onboarding complete. Try `/rn-dev-agent:rn-feature-dev <feature description>` to start."
- If anything SKIPPED: list the skipped items and a one-line "to enable later, re-run `/rn-dev-agent:setup`".
- If FAIL: list the actionable next step.

## Idempotency

Re-running `/rn-dev-agent:setup` on an already-onboarded project must be safe:
- CLAUDE.md template: detects the marker, skips.
- Nav ref: detects existing `globalThis.__NAV_REF__` assignment, skips.
- Zustand: detects existing `globalThis.__ZUSTAND_STORES__` assignment, skips.

Tell the user up-front when nothing needs to be injected.

## Anti-patterns — do NOT do these in the injection phase

1. Modify any file without showing the diff first.
2. Inject without checking for the existing marker — duplicating the template would bloat the user's CLAUDE.md.
3. Skip the user-confirmation prompt — they may have customized their `NavigationContainer` setup in a way the auto-injection would clobber.
4. Inject the nav-ref or store-exposure snippets without the `if (__DEV__)` guard — exposing nav refs / store hooks in production is a real footgun.
5. Use `xcrun simctl` / `adb` for diagnostics — Phase 1 delegates to the `rn-setup` skill, which uses the proper detection commands.

## When NOT to use `/rn-dev-agent:setup`

- The user just wants to check what's installed → `/rn-dev-agent:doctor` (diagnostic only, no project mutation).
- The user already onboarded their project → re-running is safe but not necessary.
- The user is trying to debug a runtime issue → `/rn-dev-agent:debug-screen` is the right tool.
