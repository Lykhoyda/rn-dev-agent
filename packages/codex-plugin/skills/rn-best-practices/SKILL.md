---
name: rn-best-practices
user-invocable: false
paths:
  - "**/*.{ts,tsx,js,jsx}"
  - "**/package.json"
description: >
  This skill should be used when writing or reviewing React Native / Expo
  code — before writing list rendering, animations, data fetching, component
  APIs, navigation, or image/media UI — and when asked to "review best
  practices", "check performance", "optimize renders", "review list
  rendering", "check animation patterns", "review state management",
  "audit UI", "review composition", "review for production readiness",
  "check React Native conventions", "performance audit".
---

# React Native Best Practices — Procedural Adapter

This installed Codex skill routes through the packaged 118-rule
`rules.index.json` plus package-local rn-dev-agent reference files. Do not
assume an rn-dev-agent source checkout or a `third_party/` tree. Query only the
index entries relevant to the code being written/reviewed; `title`, severity,
triggers, and `applicable_when` are the installed metadata contract.

## Index

The routing surface is `skills/rn-best-practices/rules.index.json`. Each entry:
```json
{ "id": "react-native-skills/list-performance-virtualize",
  "title": "Use a list virtualizer for any list",
  "category": "react-native-skills",
  "platform": "RN",
  "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "triggers": ["FlatList", "FlashList", "ScrollView"],
  "upstream_path": "third_party/vercel-labs/agent-skills/skills/.../list-performance-virtualize.md",
  "checkable": true | false,
  "checkerRule": "no-touchable-new-code" | null
}
```

Query with `jq` or read directly. Filter by `platform: "RN"` for React Native
work; `platform: "both"` for composition rules; `platform: "web"` only for
web React when applicable.

## Always check (inline, regardless of category)

These cause **runtime crashes**. Check on every review pass. Do not delegate.

### Falsy-`&&` rendering crash
`{x && <Comp />}` where `x` could be `0`, `""`, or `NaN` renders the falsy
value as a string in RN. **Bad:** `{count && <Badge />}` (renders "0").
**Good:** `{count > 0 && <Badge />}` or ternary. Full rule:
`third_party/vercel-labs/agent-skills/skills/react-native-skills/rules/rendering-no-falsy-and.md`

### Bare strings outside `<Text>`
A string as a direct child of `<View>` is a runtime crash on RN.
**Bad:** `<View>Hello</View>`. **Good:** `<View><Text>Hello</Text></View>`.
Full rule: `.../rules/rendering-text-in-text-component.md`

### Components defined inside components
Defining `const Child = () => …` inside `function Parent()` creates a new
component type every render. RN remounts it, destroying state, native views,
animations, scroll position, focus. **Bad:** inline function components inside
parents. **Good:** define outside, pass data via props. Full rule (web/RN):
`.../skills/react-best-practices/rules/rerender-no-inline-components.md`

---

## Procedural lookup — query the index BEFORE writing each category

Use these procedures whenever you're about to write or review code in the
listed scope. Load the matched packaged index entries. `upstream_path` is
provenance metadata and may not exist in a marketplace package; do not try to
read it unless working in a source checkout. Package-local custom references
under `references/rn-dev-agent/` remain readable.

### Before writing list rendering (FlatList, FlashList, SectionList, ScrollView+map)

1. From `rules.index.json`, select entries where `id` starts with
   `react-native-skills/list-performance-` (8 rules).
2. Read every entry with `severity: CRITICAL` or `HIGH` (typically 5-6 rules).
3. Apply rule recommendations to the code under design/review.
4. Cite rule ID in code comments only when the choice is non-obvious
   (e.g., why `keyExtractor` returns a non-id field).

Most common applicable rules: `list-performance-virtualize`,
`list-performance-inline-objects`, `list-performance-callbacks`,
`list-performance-item-memo`.

### Before writing animations (Reanimated, react-native-gesture-handler, Animated)

1. Select entries where `id` starts with `react-native-skills/animation-`
   (3 rules) OR `react-native-skills/react-compiler-reanimated-`.
2. Read every CRITICAL/HIGH rule.
3. Common pitfalls: animating layout props (`width`, `height`, `top`) instead
   of GPU-friendly `transform`/`opacity`; `useAnimatedReaction` for derived
   values where `useDerivedValue` is faster.

### Before writing data fetching / async flow (useEffect+fetch, React Query, SWR, parallel awaits)

1. Select entries where `id` starts with `react-best-practices/async-` OR
   contains `query-cache` (custom rule).
2. Read every CRITICAL/HIGH rule.
3. Common pitfalls: sequential `await` on independent calls (use
   `Promise.all`); imperative cache reads (use reactive query hooks).

### Before designing component APIs (boolean props, compound vs polymorphic, ref forwarding)

1. Select entries where `category: "composition-patterns"` (8 rules) OR
   `id` ends with `compound-components` (1 RN rule).
2. Read every CRITICAL/HIGH rule.
3. Common pitfalls: 5+ boolean props on one component (use compound
   components); `forwardRef` in React 19 code (just receive `ref` as a prop);
   render-props where `children` composition would work.

### Before writing navigation code (createStackNavigator, Tabs, modal presentation)

1. Select entries where `id` starts with `react-native-skills/navigation-` OR
   matches `rn-dev-agent/navigation-*`.
2. Read every CRITICAL/HIGH rule.
3. Custom rule alert: on Bridgeless + react-native-screens, `presentation:
   'transparentModal'` causes routing failures — see
   `references/rn-dev-agent/navigation-transparent-modal.md`.

### Before writing image/media UI (Image, modals, gallery, safe areas, Pressable)

1. Select entries where `id` starts with `react-native-skills/ui-` (9 rules).
2. Read every CRITICAL/HIGH rule, plus `ui-pressable` even when LOW (it's a
   convention enforcement, not a perf issue).
3. Common pitfalls: `Image` from react-native (use `expo-image`); JS-rendered
   bottom sheets (use native modals); `Touchable*` in new code.

---

## rn-dev-agent custom rules

These four rules are NOT in the upstream Vercel set — they were discovered
through rn-dev-agent story testing on Bridgeless RN 0.76.x. They survive
every upstream sync at `references/rn-dev-agent/`:

| File | Trigger context |
|---|---|
| `references/rn-dev-agent/navigation-transparent-modal.md` | Bridgeless + react-native-screens routing |
| `references/rn-dev-agent/query-cache-reactive.md` | React Query — imperative reads |
| `references/rn-dev-agent/reanimated-in-lists.md` | Reanimated layout animations inside virtualized lists |
| `references/rn-dev-agent/theme-memoization-lists.md` | Theme hooks consumed inside `renderItem` |

These also appear in `rules.index.json` under `category: "rn-dev-agent"`.

---

## Verification surface (where the deterministic checks live)

A subset has automated grep checking through the packaged
`../../scripts/check-vercel-rules.mjs`. Codex has no Claude edit hook; invoke
`$rn-dev-agent:check-vercel-rules` explicitly or use `--ci` in a project gate.
Currently 3 rules are `checkable: true` in the index:

- `react-native-skills/ui-pressable` → `no-touchable-new-code`
- `react-native-skills/list-performance-inline-objects` → `no-inline-renderitem-literals`
- `react-native-skills/rendering-no-falsy-and` → `no-falsy-jsx-and`

Block-on-violation behavior lives in `--ci` mode. For a manual full-project
audit use `$rn-dev-agent:check-vercel-rules`; the empty request maps to
`--all`.

---

## Common rationalizations (do not accept these from yourself)

| Excuse | Reality |
|--------|---------|
| "It's just a 10-item list, I don't need FlashList" | Apps grow. Today's 10 items become tomorrow's 1000. Use FlashList from the start — cost is near-zero, upgrade later is painful. |
| "Inline arrow functions in renderItem are fine for this case" | Every parent re-render produces a new function reference; every list item re-renders. Use `useCallback` — one extra line. |
| "The `&&` pattern is clear enough here" | `items.length && <Content/>` renders "0" when items is `[]`. Always use `items.length > 0 ? … : null`. Crash vector. |
| "I'll handle SafeAreaView later" | Later never comes. Every screen needs safe-area handling from day one — affects hit targets, not just visuals. |
| "User asked for a simple feature — skip the rule review" | Simple features ship. Bad patterns become codebase conventions. Always review at Phase 4 (Architecture) and Phase 6 (Review). |
| "I'll use `Touchable*` everywhere — it's familiar" | `Touchable*` is deprecated. Use `Pressable` — it's the supported API and has built-in pressed/hovered states. |
| "I need to migrate the whole codebase to follow rule X" | Scope discipline. Apply rules to NEW code and code you're already touching. Don't refactor adjacent files. |

## Red flags — stop and reconsider

- About to approve code with `&&` falsy-value patterns
- About to approve a list component that isn't `FlashList` or `FlatList` with proper memoization
- About to approve inline objects or functions inside `renderItem`
- About to approve a screen without `SafeAreaView` or `edges` prop
- About to approve `Touchable*` in new code (should be `Pressable`)
- About to approve `Intl.DateTimeFormat` called inside render (hoist to module level)
- About to approve a component with 5+ boolean props (use compound components)
