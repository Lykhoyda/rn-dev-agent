# Keyboard-occlusion guard — Phase 1 (Maestro `hideKeyboard` injection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `generateMaestro()` emit `- hideKeyboard` before any button tap that follows text entry, so generated/saved Maestro action flows stop having bottom-pinned taps land on the soft keyboard.

**Architecture:** A pure, order-only transform *inside* `generateMaestro()` — the single chokepoint every generated/saved Maestro flow passes through. While walking the `RecordedEvent[]` stream we track one boolean (`keyboardLikelyUp`); a `type` event raises it, and before emitting a `tap`/`long_press` we inject a `hideKeyboard` step (and an audit comment) when it is up, then lower it. `hideKeyboard` is already allowlisted and is a no-op when no keyboard is showing; Maestro taps are selector-based so the next selector re-resolves after dismiss (zero stale-coordinate risk).

**Tech Stack:** TypeScript (compiled `src` → `dist` via `tsc`), Node's built-in test runner (`node --test`), `assert/strict`. Tests are authored as `.js` in `test/unit/` and import from the built `dist/`.

## Global Constraints

- Node.js >= 22 LTS.
- No new dependencies; `hideKeyboard` is already in `maestro-validator.ts` `ALLOWED_COMMANDS`.
- Use explicit type imports (`import type { ... }`).
- No unnecessary comments in code.
- The only function changed in `src` is `generateMaestro`. Do NOT touch `RecordedEvent`, the recorder, `save-as-action`, `maestro-validator`, `repair-engine`, `runNative`, or the native runners (those are Phase 1.5 / Phase 2).
- The audit marker is emitted as a **preceding full comment line** (matching the generator's existing `# navigated:` / `# NOTE:` style), never a trailing inline comment.
- A changeset is REQUIRED (touches `scripts/cdp-bridge/src/`) and MUST bump **both** `rn-dev-agent-cdp` and `rn-dev-agent-plugin` (CI guard `scripts/require-changeset.sh`, #364).
- Marker comment text (verbatim, used by every task): `# rn-dev-agent: keyboard-occlusion guard (#356)`
- Build+test commands (verbatim):
  - Targeted: `cd scripts/cdp-bridge && npm run build && node --test test/unit/test-recorder-generators.test.js`
  - Full suite: `cd scripts/cdp-bridge && npm test`

---

## File Structure

- **Modify:** `scripts/cdp-bridge/src/tools/test-recorder-generators.ts` — only `generateMaestro` (currently lines 165–264). Add the `keyboardLikelyUp` state, the pre-tap injection in the `tap` and `long_press` cases, the flag-raise in the `type` case, and the flag-reset in the `navigate` case.
- **Modify (tests):** `scripts/cdp-bridge/test/unit/test-recorder-generators.test.js` — append `#356` test cases (existing tests must keep passing).
- **Create (changeset):** `.changeset/keyboard-occlusion-guard-phase1.md`.

---

### Task 1: Core injection — `hideKeyboard` before a tap that follows text entry

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/test-recorder-generators.ts` (`generateMaestro`, ~165–264)
- Test: `scripts/cdp-bridge/test/unit/test-recorder-generators.test.js`

**Interfaces:**
- Consumes: existing `generateMaestro(events: RecordedEvent[], opts?: GenerateOpts): string`; event shape `{ type: 'tap'|'type'|'long_press'|'navigate'|'submit'|'swipe'|'annotation', testID?, label?, value?, t, ... }`.
- Produces: same signature, unchanged. New emitted lines `# rn-dev-agent: keyboard-occlusion guard (#356)` + `- hideKeyboard` inserted before a `tap`'s `- tapOn:` when the keyboard is up.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cdp-bridge/test/unit/test-recorder-generators.test.js`:

```js
test('#356 Maestro: hideKeyboard injected before a tap that follows type', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'tap', testID: 'submit', t: 2 },
  ]);
  assert.match(out, /# rn-dev-agent: keyboard-occlusion guard \(#356\)/);
  const hk = out.indexOf('- hideKeyboard');
  const input = out.indexOf('- inputText:');
  const submitTap = out.indexOf('id: submit');
  assert.ok(hk > -1, 'hideKeyboard should be injected');
  assert.ok(hk > input, 'hideKeyboard comes after the inputText');
  assert.ok(hk < submitTap, 'hideKeyboard comes before the submit tap');
  const emailTap = out.indexOf('id: email');
  assert.ok(
    !out.slice(0, emailTap).includes('- hideKeyboard'),
    'the focusing tap of the type step is NOT guarded',
  );
});

test('#356 Maestro: no hideKeyboard when a tap is not preceded by type', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'submit', t: 1 }]);
  assert.ok(!out.includes('- hideKeyboard'), 'no keyboard, no injection');
});

test('#356 Maestro: single hideKeyboard for type then two taps', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'tap', testID: 'next', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  const count = (out.match(/- hideKeyboard/g) || []).length;
  assert.equal(count, 1, 'flag cleared after first guarded tap');
  assert.ok(out.indexOf('- hideKeyboard') < out.indexOf('id: next'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/test-recorder-generators.test.js`
Expected: the three `#356` tests FAIL (no `- hideKeyboard` in output); all pre-existing `M6` tests PASS.

- [ ] **Step 3: Implement the minimal change in `generateMaestro`**

In `scripts/cdp-bridge/src/tools/test-recorder-generators.ts`, inside `generateMaestro`, immediately after `const consumedNavIndices = new Set<number>();` add the state:

```ts
  // #356: track whether the soft keyboard is likely up so we can dismiss it
  // before a button tap (a bottom-pinned tap otherwise lands on the keyboard).
  let keyboardLikelyUp = false;
```

Replace the `case 'tap':` block body with:

```ts
      case 'tap': {
        const sel = maestroSelector(ev);
        if (sel) {
          if (keyboardLikelyUp) {
            lines.push('# rn-dev-agent: keyboard-occlusion guard (#356)');
            lines.push('- hideKeyboard');
            keyboardLikelyUp = false;
          }
          lines.push(`- tapOn:\n    ${sel}`);
        } else lines.push('# tap: missing testID/label');
        const hit = lookaheadNavigate(events, i);
        if (hit) {
          lines.push(
            `# navigated: ${stripNewlines(hit.event.from ?? '?')} -> ${stripNewlines(hit.event.to)}`,
          );
          const next = nextSelector(events, hit.index, maestroSelector);
          if (next) lines.push(`- assertVisible:\n    ${next}`);
          consumedNavIndices.add(hit.index);
        }
        break;
      }
```

In the `case 'type':` block, set the flag when an input is actually emitted:

```ts
      case 'type': {
        const sel = maestroSelector(ev);
        if (sel) {
          lines.push(`- tapOn:\n    ${sel}`);
          lines.push(`- inputText: ${JSON.stringify(ev.value)}`);
          keyboardLikelyUp = true;
        } else {
          lines.push(`# type: missing testID/label, value=${JSON.stringify(ev.value)}`);
        }
        break;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/test-recorder-generators.test.js`
Expected: all `#356` tests from this task PASS; all `M6` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/test-recorder-generators.ts scripts/cdp-bridge/test/unit/test-recorder-generators.test.js
git commit -m "feat(356): inject hideKeyboard before taps following text entry (Maestro generator)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Reset conditions + `long_press` parity

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/test-recorder-generators.ts` (`generateMaestro`)
- Test: `scripts/cdp-bridge/test/unit/test-recorder-generators.test.js`

**Interfaces:**
- Consumes: the `keyboardLikelyUp` state introduced in Task 1.
- Produces: `navigate` clears the flag; `long_press` is guarded the same way as `tap`; `submit` leaves the flag unchanged.

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('#356 Maestro: navigate resets keyboard state (no injection after nav)', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'navigate', from: 'A', to: 'B', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  assert.ok(!out.includes('- hideKeyboard'), 'navigation dismisses the keyboard');
});

test('#356 Maestro: consecutive types inject once before the final tap', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'first', value: 'x', t: 1 },
    { type: 'type', testID: 'second', value: 'y', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  const count = (out.match(/- hideKeyboard/g) || []).length;
  assert.equal(count, 1, 'one injection for the trailing button tap');
  const secondTap = out.indexOf('id: second');
  assert.ok(
    !out.slice(0, secondTap).includes('- hideKeyboard'),
    'the focusing tap of the second type is not guarded',
  );
  assert.ok(out.indexOf('- hideKeyboard') < out.indexOf('id: submit'));
});

test('#356 Maestro: submit (Enter) does not reset keyboard state', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'submit', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  const hk = out.indexOf('- hideKeyboard');
  assert.ok(hk > -1, 'still guarded after submit');
  assert.ok(hk < out.indexOf('id: submit'));
});

test('#356 Maestro: long_press following type is guarded', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'long_press', testID: 'avatar', t: 2 },
  ]);
  const hk = out.indexOf('- hideKeyboard');
  assert.ok(hk > -1, 'long_press is guarded too');
  assert.ok(hk < out.indexOf('- longPressOn:'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/test-recorder-generators.test.js`
Expected: the `navigate` and `long_press` tests FAIL; `consecutive types` and `submit` tests PASS already (Task 1 behavior). All prior tests still PASS.

- [ ] **Step 3: Implement the reset + long_press injection**

In `generateMaestro`, replace the `case 'long_press':` block body with:

```ts
      case 'long_press': {
        const sel = maestroSelector(ev);
        if (sel) {
          if (keyboardLikelyUp) {
            lines.push('# rn-dev-agent: keyboard-occlusion guard (#356)');
            lines.push('- hideKeyboard');
            keyboardLikelyUp = false;
          }
          lines.push(`- longPressOn:\n    ${sel}`);
        } else lines.push('# long_press: missing testID/label');
        const hit = lookaheadNavigate(events, i);
        if (hit) {
          lines.push(
            `# navigated: ${stripNewlines(hit.event.from ?? '?')} -> ${stripNewlines(hit.event.to)}`,
          );
          const next = nextSelector(events, hit.index, maestroSelector);
          if (next) lines.push(`- assertVisible:\n    ${next}`);
          consumedNavIndices.add(hit.index);
        }
        break;
      }
```

In the `case 'navigate':` block, reset the flag at the top of the case (before the `consumedNavIndices` early-return):

```ts
      case 'navigate': {
        keyboardLikelyUp = false;
        if (consumedNavIndices.has(i)) break;
        const next = nextSelector(events, i, maestroSelector);
        lines.push(`# navigated: ${stripNewlines(ev.from ?? '?')} -> ${stripNewlines(ev.to)}`);
        if (next) lines.push(`- assertVisible:\n    ${next}`);
        break;
      }
```

(The `submit` case is intentionally left unchanged — Enter's dismiss behavior is field-type dependent, so we keep the flag set and over-guard the next tap.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/test-recorder-generators.test.js`
Expected: ALL tests in the file PASS (`#356` + `M6`).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/test-recorder-generators.ts scripts/cdp-bridge/test/unit/test-recorder-generators.test.js
git commit -m "feat(356): reset keyboard guard on navigate; guard long_press too

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Full-suite regression + changeset

**Files:**
- Create: `.changeset/keyboard-occlusion-guard-phase1.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a changeset bumping `rn-dev-agent-cdp` + `rn-dev-agent-plugin` (patch).

- [ ] **Step 1: Run the full unit suite (regression gate)**

Run: `cd scripts/cdp-bridge && npm test`
Expected: the entire suite PASSES. In particular, generator tests for flows with no typed-then-tapped sequence are byte-identical to before (no stray `- hideKeyboard`). If any pre-existing test now emits an unexpected `- hideKeyboard`, that flow legitimately had a type→tap sequence; confirm the injection is correct and update the expectation only if it is.

- [ ] **Step 2: Create the changeset**

Create `.changeset/keyboard-occlusion-guard-phase1.md`:

```markdown
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(actions): inject `- hideKeyboard` before button taps that follow text entry when generating/saving Maestro action flows (#356, Phase 1). Bottom-pinned taps (submit/continue) previously landed on the soft keyboard during replays — the single biggest source of flaky replays. `generateMaestro` now tracks soft-keyboard state and emits a `hideKeyboard` step before a `tap`/`long_press` that follows an `inputText`, reset on navigation. `hideKeyboard` is a no-op when no keyboard is showing and Maestro re-resolves the selector after dismiss, so the injection is safe. Live `device_*` taps (the in-runner guard) and existing-corpus backfill are deferred to later phases.
```

- [ ] **Step 3: Verify the changeset guard passes locally**

Run: `cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin && CHANGED_FILES="scripts/cdp-bridge/src/tools/test-recorder-generators.ts" bash scripts/require-changeset.sh`
Expected: prints a success line (a `rn-dev-agent-plugin` changeset is present) and exits 0.

- [ ] **Step 4: Commit**

```bash
git add .changeset/keyboard-occlusion-guard-phase1.md
git commit -m "chore(changeset): keyboard-occlusion guard Phase 1 (cdp + plugin patch)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Device verification on iOS + Android (parent session)

> Runs in the **parent session** using the plugin's live MCP tools (`cdp_*`, `device_*`, `maestro_run`, recorder/action tools) against a booted simulator/emulator with Metro running from `../rn-dev-agent-workspace/test-app`. This task is verification, not code — do not dispatch it to a code subagent.

**Interfaces:**
- Consumes: the rebuilt `dist/` from Tasks 1–2.

- [ ] **Step 1: Confirm the running bridge has the rebuilt generator**

Run `cdp_status` and confirm the worker is healthy. Ensure `scripts/cdp-bridge/dist/tools/test-recorder-generators.js` reflects the change (rebuilt in Task 1/2).

- [ ] **Step 2: Produce a flow that exercises the bug (iOS)**

Drive a screen with a text field above the keyboard and a bottom-pinned submit button. Record a walk (fill the field, then tap submit) and save it as an action (or run `generateMaestro` over the recorded events). Confirm the saved/generated YAML contains `# rn-dev-agent: keyboard-occlusion guard (#356)` + `- hideKeyboard` before the submit `- tapOn`.

- [ ] **Step 3: Replay and verify (iOS)**

Replay the action via `cdp_run_action`/`maestro_run`. Expected: the submit tap reaches the next screen reliably (assert the post-submit route/element with `expect_route` or `assertVisible`). Capture a `device_screenshot` of the resulting screen as proof.

- [ ] **Step 4: Repeat on Android**

Boot the Android emulator, repeat Steps 2–3. Expected: same reliable result. (Maestro/UIAutomator interprets `hideKeyboard` identically; this confirms cross-platform parity.)

- [ ] **Step 5: Record the outcome**

Note the before/after (flaky → reliable) in the PR body and in the workspace `ROADMAP.md`/`BUGS.md` per the project logging rules. Save screenshots under the workspace proof dir.

---

## Self-Review

**1. Spec coverage:**
- Approach (transform in `generateMaestro`) → Task 1 + 2. ✓
- Detection rule (type raises; tap/long_press inject+clear; navigate resets; type-focus-tap unguarded; submit no-reset) → Task 1 (raise, tap inject, type-focus unguarded) + Task 2 (navigate reset, long_press, submit no-reset). ✓
- Emitted shape with preceding comment marker → Task 1/2 impl + Task 1 test asserts the marker. ✓
- Testing: unit table of cases → Tasks 1–2; device verification iOS+Android → Task 4. ✓
- Out-of-scope items (Phase 2, repair-time, backfill, Detox, swipe/fill) → untouched; Global Constraints forbids touching those files. ✓
- Changeset bumping both packages → Task 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✓

**3. Type consistency:** Marker string `# rn-dev-agent: keyboard-occlusion guard (#356)` and flag name `keyboardLikelyUp` are identical across Tasks 1 and 2. The `tap` and `long_press` injection blocks are identical in structure. Changeset package names `rn-dev-agent-cdp` / `rn-dev-agent-plugin` match `require-changeset.sh`. ✓

No gaps found.

## Multi-LLM plan review (Codex + Gemini) — clean, no amendments

Reviewed before execution per the project workflow. Both reviewers validated the
detection-rule state machine against the real `generateMaestro` control flow and the
edge cases (swipe/annotation between type and tap; empty `value`; label-only tap;
missing-testID type; `lookaheadNavigate`-consumed navigate; repeated taps), confirmed
the injected `# comment` + `- hideKeyboard` parses clean and passes
`maestro-validator` (`hideKeyboard` ∈ `ALLOWED_COMMANDS`), confirmed the test
assertions are empirically valid (Gemini simulated all cases: 13/13 pass; YAML parsed
with 0 errors), and confirmed the dual-package changeset satisfies
`require-changeset.sh`. Key integration point confirmed safe: resetting
`keyboardLikelyUp` at the top of the `navigate` case does not interfere with
`consumedNavIndices` (the loop visits every index; consumption only suppresses
emission). No BLOCKING/IMPORTANT findings; advisories were non-actionable. Execute as
written.
