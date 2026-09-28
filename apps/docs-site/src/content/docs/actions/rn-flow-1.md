---
title: rn-flow@1 replay dialect
description: The contract for replaying saved actions — which Maestro-format commands compile, how selectors resolve, which domain runs each step, and the budgets every wait uses.
---

Saved actions stay Maestro-format YAML files. `rn-flow@1` is the subset of that
format QaReN replays with its own engine. The TypeScript core compiles a flow
into an immutable plan (`schema: "rn-flow/1"`). The Rust `qaren` crate can
validate and interpret that plan through its library API; a replay CLI command
and host integration are not available yet. Rust never parses YAML itself.

```sh
corepack yarn build:core
node packages/qaren-core/dist/qa/walk.js --compile .qaren/actions/user-login.yaml \
  --platform ios --params '{"TITLE":"Ship it"}'
```

The file and flags may appear in any order after `--compile`; provide exactly
one file. The command prints `{"ok":true,"plan":{…}}` and exits 0, or prints
`{"ok":false,"code":"FLOW_UNSUPPORTED","refused":[{"line":…,"command":…,"reason":…}]}`
and exits 4. A missing file argument, a platform other than `ios` or `android`,
or `--params` that is not a JSON object of strings refuses the same way with
code `FLOW_USAGE`. A second file, unknown flag, or flag without a value also
refuses with `FLOW_USAGE`. The printed plan contains resolved parameter values,
including typed text, so treat compiler output like any other private run data
and keep it out of shared logs.
The `enginePin` header is not read: nothing about a pinned runner version gates
compilation.

## Commands

`launchApp` (`stopApp`, `clearState`), `tapOn`, `doubleTapOn`, `longPressOn`
(`optional`), `assertVisible`, `assertNotVisible` (`optional`), `inputText`,
`eraseText` (count or `charactersToErase`, default 50), `hideKeyboard`, `back`,
`pressKey` (`Enter`, `Back`), `swipe` (`direction`, optional `from` selector,
`duration`, default 400 ms) and `swipeUp` / `swipeDown` / `swipeLeft` /
`swipeRight`, `scroll`, `scrollUntilVisible` (`element`, `direction` default
`DOWN`, `timeout`), `waitForAnimationToEnd` (`timeout`), `extendedWaitUntil`
(`visible` or `notVisible`, `timeout`), `takeScreenshot`, `openLink`,
`stopApp`, `killApp`, `clearState`, and `runFlow` with inline `commands` or a
`file`, optionally guarded by `when: {visible | notVisible}`.

A bare `- eraseText` or `eraseText:` with no value uses the default count;
`charactersToErase: null` refuses.

A top-level action needs an `appId` header. A file-backed `runFlow` must have no
`appId` header. Both require a final, non-empty command list: an absent, empty,
null, scalar, or mapping final document refuses at its location, as does a
command list before `---` or an unexpected header. Malformed YAML refuses with
the parser's line. Every flow also passes the same validator (command allowlist,
denied commands, scalar safety, contained `runFlow` file references).
Command-level refusals carry the command name and line (plus the sub-flow `file`
when the step comes from one); value-level refusals, such as an unsafe scalar,
report the offending command and line. Refused at compile time: a command
outside the list, an unknown key, a coordinate swipe, `retryTapIfNoChange`, or a
value passed to a command that takes none. Nothing falls back to another
engine.

`extendedWaitUntil` compiles to `assertVisible` or `assertNotVisible` with its
own budget. A `runFlow` without `when` is spliced in place; with `when` it is one
`runFlow` step holding its sub-steps.

## Selectors

- `id`: exact `accessibilityIdentifier` on iOS, exact raw resource-id on
  Android.
- `text`: exact equality after trimming, over label then value on iOS and text
  then content-desc on Android. A bare string is a `text` selector.
- `index`: a non-negative integer over the resolved match list.

A text selector containing a regex metacharacter (`. ^ $ * + ? ( ) [ ] { } |`
or `\`) in the authored text is refused; select it by `id` instead, or pass the
text as a parameter, whose value is always literal. Relative selectors
(`below`, `childOf`, …) are refused. A selector carrying both `id` and `text` is
refused as mixed: split it into two steps.

**Resolution.** Collect every node matching the selector in snapshot document
order; map each match to its deepest matching descendant, keeping duplicates so
the list keeps authored positions; apply `index` over that list. Without
`index`, a list holding more than one distinct node refuses as ambiguous and
names the candidates. An `index` out of range fails with the list.

## Parameters

`${NAME}` and `${NAME ?? "fallback"}` are interpolated at compile time from
`--params`; the plan carries resolved values and the interpreter never
interpolates. A placeholder without a value or fallback refuses with its name;
any other `${…}` expression refuses. The regex rule applies to the authored
text, so a parameter value is always literal. Because typed values are resolved
into the plan, a plan file is run-private.

## Domains

| Domain | Steps |
|---|---|
| `react-tree` | iOS only: presence reads (`assertVisible`, `extendedWaitUntil` visible, a `runFlow` `when: visible`) whose selector is exactly `{id}` (no `index`) |
| `lifecycle` | `launchApp` that stops the app (the default) or clears state, `stopApp`, `killApp`, `clearState`, `openLink` |
| `native` | everything else, including every tap, type, erase, swipe, scroll and keyboard step, `launchApp` with `stopApp: false`, and every read on Android |

The React tree holds presence reads by exact `id` only. Absence reads stay
native on every platform: a closed sheet can keep its React nodes mounted, so
only the on-screen snapshot proves it is gone. Every mutation is native,
dispatched once through the runner. `hideKeyboard` is native and carries
`fallbackDomain: "react-tree"`: the JavaScript dismissal tier runs only after
the runner reports `KEYBOARD_DISMISS_FAILED`. `openLink` is lifecycle because no
runner opens URLs.

In v1, exact-id presence domains are fixed at compile time; they do not have a
runtime native fallback. `hideKeyboard` is the only tiered step.

A bare `launchApp` stops and relaunches the app. Lifecycle steps are exactly the
steps a user could not perform by hand (relaunch, clear, kill, deep link), so a
user-path replay refuses any plan that contains one. `launchApp` with
`stopApp: false` only brings the running app forward and stays native.

## Budgets

Every step carries `budgetMs`; the interpreter owns every wait and adapters
never start a second implicit wait.

| Step | Budget |
|---|---|
| lookup (`tapOn`, `doubleTapOn`, `longPressOn`, `assertVisible`) | 17,000 ms |
| `swipe` | 17,000 ms with `from`, else 10,000 ms, plus the swipe's duration |
| optional lookup | 7,000 ms |
| `assertNotVisible` | 7,000 ms, a bounded absence poll, never a single read |
| `extendedWaitUntil` | its `timeout` (default 17,000 visible, 7,000 not visible) |
| `scrollUntilVisible` | its `timeout`, default 20,000 ms |
| `waitForAnimationToEnd` | polls the runner's static predicate, capped at 5,000 ms |
| `runFlow` condition | 0: one observation |
| other native dispatch | 10,000 ms |
| `launchApp`, `openLink`, `clearState` | 15,000 ms |
| `stopApp`, `killApp` | 10,000 ms |

Explicit `timeout` values for `extendedWaitUntil`, `scrollUntilVisible`, and
`waitForAnimationToEnd` must be positive integers.

A timed-out step records what it polled and the last snapshot's near misses.
A tap or type is dispatched once; a transport timeout fails the step as
`dispatched-unknown` and is never re-sent. There is no retry-if-no-change.

## Precondition

Before step 1 the foreground surface must be the app. The Expo dev menu is
dismissed once; any other surface refuses the run.
