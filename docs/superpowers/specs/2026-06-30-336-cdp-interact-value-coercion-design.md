# #336 — Fix `cdp_interact` value-injection for Controller-wrapped inputs

Date: 2026-06-30
Issue: [#336](https://github.com/Lykhoyda/rn-dev-agent/issues/336)
Status: Design approved — ready for implementation plan

## Problem

`cdp_interact` value-injection corrupts react-hook-form `Controller`-wrapped custom
inputs in two ways (reproduced on iOS bridgeless, RN 0.83 New Arch, Expo 55):

1. **Press → event object.** `cdp_interact press testID=<radio_option>` calls
   `props.onPress({ nativeEvent: {} })`. For a value-bearing control whose `onPress`
   routes to the Controller's `onChange` (radio/chip), the **synthetic event object**
   becomes the field value → Zod fails "received object".
2. **Digit-string → number.** `cdp_interact setFieldValue value="15112345678"` ends up
   calling `setValue(name, 15112345678)` with a **number**, so a `z.string()` schema
   fails "Expected string, received number".

Net: any `Controller`-wrapped custom input (radios, phone, other `onValueChange`
fields) cannot be driven via the preferred JS interaction tier, forcing `device_*`
workarounds.

## Root cause (verified in code)

- **Bug #1:** `scripts/cdp-bridge/src/injected-helpers.ts:1333` —
  `props.onPress({ nativeEvent: {} })`. Correct for a plain button; wrong when
  `onPress` is a value setter expecting the option value.
- **Bug #2:** NOT a coercion in the bridge. `interact.ts` forwards `value` verbatim and
  `JSON.stringify` preserves types; the `setFieldValue` helper
  (`injected-helpers.ts:1533,1577`) passes `opts.value` straight to `setValue`. The
  trap is the **schema**: `index.ts:984` types `value` as
  `z.union([z.string(), z.number(), z.boolean()])`. Because `number` is admitted, a
  digit-string is naturally emitted/parsed as the number `15112345678`, which the
  helper faithfully forwards. The `number`/`boolean` passthrough is an **intentional
  feature** — `test/unit/gh-126-set-field-value.test.js:189` asserts `value:42` /
  `value:true` pass through unchanged — so a fix must preserve it.

## Approach

Both fixes live in the **injected helpers** (deterministic, unit-testable via
`test/unit/helpers/inject-harness.js`). `interact.ts` already forwards `value` for
every action, so there is **no TS handler logic change**. `index.ts` gets schema
*description* updates only (the union stays `string|number|boolean`). Bump
`HELPERS_VERSION` 32 → 33 so on-device helpers re-inject on next use.

### Bug #2 — type-match in `setFieldValue` (injected-helpers.ts, before `setValue` ~1576)

Coerce a number back to string ONLY when the field currently holds a string:

```js
// GH #336: the value union admits `number`, so a digit-string meant as a string
// (phone, codes, IDs) can arrive as a number and fail a z.string() schema. If the
// field currently holds a string but the injected value is a number, coerce to
// string. Number/boolean fields (current value is number/undefined/object) are
// untouched, preserving the intentional gh-126 passthrough.
var coercedToString = false;
if (typeof fieldValue === 'number') {
  var current;
  try { current = formReturn.getValues(fieldName); } catch (e) { current = undefined; }
  if (typeof current === 'string') { fieldValue = String(fieldValue); coercedToString = true; }
}
```

- Phone (default `''`) + injected number → `getValues` returns `''` (string) →
  `"15112345678"`. Fixed.
- gh-126: `getValues('age')` returns `{}`/`undefined` (not a string) → no coercion →
  `42`/`true` unchanged. Preserved.
- Direction is number→string **only** (the reported bug); never string→number. A
  `getValues` throw → no coercion. The result JSON carries `coercedToString` for
  observability.

### Bug #1 — optional `value` on `press` (injected-helpers.ts:1333)

```js
if (action === 'press') {
  if (typeof props.onPress !== 'function') { /* unchanged error */ }
  if (opts.value !== undefined) props.onPress(opts.value);   // GH #336: value-bearing control
  else props.onPress({ nativeEvent: {} });                   // unchanged: plain button
  return JSON.stringify({ success: true, action: 'press', component: typeName,
    testID: selector, ...(opts.value !== undefined ? { value: opts.value } : {}) });
}
```

- `press value="male"` → `onPress("male")` → Controller's `onChange` gets the value,
  not the event. Fixed.
- `press` with no `value` → `{ nativeEvent: {} }` unchanged → existing press behavior
  and tests preserved.
- Press `value` is passed **verbatim** (no `getValues` type-match — press has no form
  `name` to consult). Radio option values are typically non-numeric strings, and the
  caller controls the type.

### Schema / docs (index.ts — describe-only, no type change)

- `value` describe: also used by `press` for value-bearing controls (radios/chips) —
  `onPress` receives the value instead of a synthetic event.
- `action` enum describe: `press` → "calls onPress (with `value` if provided, for
  radio/chip-style value-bearing controls)".

## Components & data flow

- `injected-helpers.ts` — only file with logic changes: `press` block (Bug #1),
  `setFieldValue` block (Bug #2), `HELPERS_VERSION` 32 → 33.
- `index.ts` — `value` + `action` describe strings (Bug #1 documentation).
- `interact.ts` — unchanged (value already forwarded for all actions). Optional: a
  one-line comment noting `value` is now also a press input.
- Tests — `test/unit/gh-336-interact-value-injection.test.js` (new), using the harness.

## Error handling

- `setFieldValue` with a string-typed field + number → silent, correct coercion
  (logged via `coercedToString`). No new error path.
- `press value=...` on a component with no `onPress` → the existing
  "Component has no onPress handler" error, unchanged.
- `getValues` throwing inside the helper is caught → falls back to no coercion (never
  fails the call over a type-match).

## Testing

**Unit (primary, via `inject-harness.js`):**
- Bug #2: string-field (`getValues` → `''`) + number → `setValue` receives
  `"15112345678"` (string) and `coercedToString:true`; numeric field
  (`getValues` → `undefined`/`{}`) + `42` → unchanged number (re-assert gh-126);
  boolean unchanged; injected string → unchanged; `getValues` throws → number
  unchanged.
- Bug #1: `press value="A"` → `onPress` called with `"A"` (assert the arg is the
  string, not an object); `press` with no value → `onPress({nativeEvent:{}})`;
  `press` on a fiber with no `onPress` → error unchanged.

**Device verification (iOS + Android per project workflow):** a screen with an RHF
radio group (drive via `press value=<option>`) and a `z.string()` phone field (drive
via `setFieldValue`) — confirm the form value types are correct and the form submits
without falling back to `device_*`.

## Out of scope

- Dropping `number`/`boolean` from the `value` union (keeps the intentional feature).
- Symmetric string→number coercion for `setFieldValue`.
- `getValues` type-match for press `value` (press has no form `name`).
- Any native `device_*` interaction path — these bugs are JS-injection only.

## Success criteria

- `cdp_interact press testID=<radio> value=<option>` selects the option (Controller
  `onChange` receives the option value, not an event object).
- `cdp_interact setFieldValue name=<phone> value="15112345678"` leaves the field a
  string when the field is string-typed; numeric/boolean injection is unchanged.
- New unit tests cover both bugs and re-assert the gh-126 passthrough.
- `HELPERS_VERSION` bumped so released bridges re-inject.
- Device-verified on iOS + Android.
