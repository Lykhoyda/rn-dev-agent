# #356 — Keyboard-occlusion guard, Phase 1: Maestro `hideKeyboard` injection

Date: 2026-06-20
Issue: [#356](https://github.com/Lykhoyda/rn-dev-agent/issues/356) (extracted from #300, item 2)
Status: Design approved — ready for implementation plan

## Problem

When a tap targets a **bottom-pinned control** (a `submit`/`continue` button) while
the soft keyboard is up, the tap lands on the keyboard instead of the button, so the
next screen is never reached. Per the #300 session this was **the single biggest
source of flaky replays**, on **both iOS and Android**. The reporter's proven manual
workaround was to add `- hideKeyboard` before each bottom-pinned tap in the flow.

## Why two phases (and what this phase is NOT)

The bug spans two independent device-control engines that do **not** share a tap path:

| Surface | Execution path | Phase |
|---|---|---|
| Learned-action **replay** (`cdp_run_action` → `maestro_run`) | external **maestro-runner** Go binary (WDA / UIAutomator) — **never** calls `runNative()` | **Phase 1 (this spec)** |
| Live `device_press` / `device_batch` / `cdp_interact` native fallback | `runNative()` → in-tree `rn-fast-runner` / `rn-android-runner` | Phase 2 (separate spec/PR) |

Evidence: `cdp_run_action` delegates to `maestroRun()` (`run-action.ts:278`, retry at
`:551`); `maestro_run` shells out via `execFile(dispatch.binPath, …)`
(`maestro-run.ts:235`). A guard placed in `runNative()` is therefore a **no-op for
action replays**. Because the issue's headline is flaky *replays*, Phase 1 fixes the
**Maestro/L3** path; the in-runner frame-precise guard for live taps is **Phase 2**
(decisions already taken for it: in-runner atomic, frame-precise on both platforms via
iOS `app.keyboards.frame` and Android `UiAutomation.getWindows()` → `TYPE_INPUT_METHOD`
bounds — recorded here so Phase 2 starts from them).

**This phase does NOT** touch `runNative`, the native runners, repair-time injection,
or existing on-disk action files. See "Out of scope".

## Approach

A **pure event-stream transform inside `generateMaestro()`**
(`scripts/cdp-bridge/src/tools/test-recorder-generators.ts`) — the single chokepoint
every generated/saved Maestro flow passes through (`cdp_record_test_generate` and
`save-as-action` both call it). When the generator is about to emit a button tap that
follows text entry, it first emits `- hideKeyboard`.

Why this layer is correct and safe:

1. `hideKeyboard` is already in the validator allowlist (`maestro-validator.ts:105`)
   and is a **no-op when no keyboard is showing** — so over-injection costs only a few
   hundred ms, never correctness.
2. Maestro taps are **selector-based** (`id:` / `text:`), so after the dismiss Maestro
   **re-resolves** the element's (possibly relayouted) position. There is **zero
   stale-coordinate risk** — the precise concern Phase 2's coordinate guard must handle,
   this phase avoids structurally.
3. It is a pure function of `RecordedEvent[]` → `string`, so it is fully unit-testable
   with no device.

## Detection rule

While walking the event stream, maintain one boolean `keyboardLikelyUp`:

- `type` event → keyboard comes up → set `true`.
  (The existing `type` branch emits `- tapOn` to focus + `- inputText: …`.)
- Before emitting a `tap` or `long_press` step: if `keyboardLikelyUp`, emit
  `- hideKeyboard` first, then set `keyboardLikelyUp = false`.
- `navigate` event → new screen → set `keyboardLikelyUp = false`.
- The focusing `tapOn` *inside* a `type` step is **not** guarded (the keyboard is wanted
  there).
- `submit` (`- pressKey: Enter`) leaves the flag unchanged — Enter's dismiss behavior is
  field-type-dependent (single-line submits/dismisses; multiline inserts a newline), so
  bias toward guarding any subsequent tap.

Properties: conservative (may over-inject — harmless) but never misses a
typed-then-tapped sequence, which is the exact reported failure. Deterministic and
order-only — no geometry needed (`RecordedEvent` carries no rects; geometry-gating would
require recorder changes and is an explicit non-goal here).

### Emitted shape

Before:
```yaml
- tapOn:
    id: emailInput
- inputText: "user@example.com"
- tapOn:
    id: submitButton
```
After:
```yaml
- tapOn:
    id: emailInput
- inputText: "user@example.com"
# rn-dev-agent: keyboard-occlusion guard (#356)
- hideKeyboard
- tapOn:
    id: submitButton
```

The marker is emitted as a **preceding full comment line**, matching the generator's
existing comment style (`# navigated:`, `# NOTE:`) — not a trailing inline comment,
which a line-oriented validator could reject. It makes the auto-injection auditable in
the YAML and in PR diffs. The comment text is a static literal (no user-controlled
interpolation), so it needs no `stripNewlines`/`maestroScalar` handling.

## Components & data flow

- **`generateMaestro(events, opts)`** — only changed function. Add the `keyboardLikelyUp`
  state and the pre-tap emission. No new exported symbols required; the rule is internal
  to the walk. (Optionally factor the rule into a small pure helper if it aids testing.)
- No changes to `RecordedEvent`, the recorder, `save-as-action`, `maestro-validator`,
  `repair-engine`, `runNative`, or either native runner.
- `generateDetox` is intentionally untouched (Detox is secondary and its `.typeText`
  path is not the reported failure); noted as optional future parity.

## Error handling

There is no new failure mode: the transform only inserts an allowlisted, idempotent
step. Generated flows continue to pass `parseAndValidateFlow()` unchanged
(`hideKeyboard` is already allowed). If `events` is empty or contains no typed-then-tap
sequence, output is byte-identical to today.

## Testing

**Unit (primary, table-driven over event sequences):**
- typed → tap ⇒ `- hideKeyboard` injected before the tap.
- tap with no preceding type ⇒ no injection.
- type → tap → tap ⇒ injected before the first tap only (flag cleared).
- type → navigate → tap ⇒ no injection (navigate reset).
- type → long_press ⇒ injected before long_press.
- consecutive types (type → type → tap) ⇒ keyboard stays up; injected before the final tap; the focusing `tapOn` of the second `type` is not guarded.
- type → submit → tap ⇒ injected before the tap (submit does not reset).
- existing generator behaviors (navigation lookahead comments, selectors, metadata header, YAML-injection sanitization) remain unchanged — guard against regressions.

**Device verification (both platforms — required by the issue):** record/replay a flow
that fills a text field then taps a bottom-pinned submit and asserts the next screen.
Confirm it was flaky before and replays reliably after, on **iOS and Android**.

## Out of scope (follow-ups)

- **Phase 2** — in-runner frame-precise occlusion guard for live `device_*` taps
  (in-runner atomic; iOS `app.keyboards.frame`; Android `UiAutomation.getWindows()` →
  `TYPE_INPUT_METHOD` bounds). Separate spec/PR, stacked on this one.
- **Phase 1.5** — repair-time injection in `repair-engine.ts` (insert `- hideKeyboard`
  before a patched `tapOn` via body string-surgery) and a one-time **backfill** command
  for existing on-disk action YAMLs (rewrites committed files → opt-in).
- Detox parity; `swipe` / `fill` occlusion handling.

## Success criteria

- Newly generated/saved Maestro action flows emit `- hideKeyboard` before any
  button tap that follows text entry.
- The transform is covered by deterministic unit tests.
- A fill→bottom-pinned-submit flow replays reliably on iOS and Android where it was
  previously flaky.
- No change to generated output for flows without a typed-then-tapped sequence.
