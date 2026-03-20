---
name: rn-best-practices
description: >
  React Native and Expo best practices for building performant mobile apps. Use
  when reviewing React Native code, designing component architecture, implementing
  features, optimizing list performance, implementing animations, working with
  native modules, checking for performance issues, auditing UI components,
  reviewing state management, or checking production readiness. Triggers on
  "review best practices", "check performance", "optimize renders", "review list
  rendering", "check animation patterns", "review state management", "audit UI",
  "check for crashes", "review for production readiness", "check React Native
  conventions", "performance audit".
---

# React Native Best Practice Rules

36 rules from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (MIT License)
plus 3 rn-dev-agent rules discovered through story testing.
Each rule has full incorrect/correct code examples in `references/<rule-name>.md`.

---

## Rule Index

Scan this table first. Load the corresponding reference file for any rule
category present in the code under review.

| ID | Rule | Impact | Reference File |
|----|------|--------|----------------|
| 1.1 | Never use `&&` with potentially falsy values | CRITICAL | `references/rendering-no-falsy-and.md` |
| 1.2 | Wrap strings in `<Text>` components | CRITICAL | `references/rendering-text-in-text-component.md` |
| 2.1 | Avoid inline objects in renderItem | HIGH | `references/list-performance-inline-objects.md` |
| 2.2 | Hoist callbacks to the root of lists | HIGH | `references/list-performance-callbacks.md` |
| 2.3 | Keep list items lightweight | HIGH | `references/list-performance-item-expensive.md` |
| 2.4 | Stable object references before lists | CRITICAL | `references/list-performance-function-references.md` |
| 2.5 | Pass primitives to list items for memoization | HIGH | `references/list-performance-item-memo.md` |
| 2.6 | Use a list virtualizer for any list | HIGH | `references/list-performance-virtualize.md` |
| 2.7 | Use compressed images in lists | HIGH | `references/list-performance-images.md` |
| 2.8 | Use item types for heterogeneous lists | HIGH | `references/list-performance-item-types.md` |
| 3.1 | Animate transform and opacity only | HIGH | `references/animation-gpu-properties.md` |
| 3.2 | Prefer useDerivedValue over useAnimatedReaction | MEDIUM | `references/animation-derived-value.md` |
| 3.3 | Use GestureDetector for animated press states | MEDIUM | `references/animation-gesture-detector-press.md` |
| 4.1 | Never track scroll position in useState | HIGH | `references/scroll-position-no-state.md` |
| 5.1 | Use native navigators (native-stack, native tabs) | HIGH | `references/navigation-native-navigators.md` |
| 6.1 | Minimize state variables; derive values | MEDIUM | `references/react-state-minimize.md` |
| 6.2 | Use fallback state instead of initialState | MEDIUM | `references/react-state-fallback.md` |
| 6.3 | Use dispatch updaters for state depending on current value | MEDIUM | `references/react-state-dispatcher.md` |
| 7.1 | State must represent ground truth | HIGH | `references/state-ground-truth.md` |
| 8.1 | Destructure functions early in render (React Compiler) | HIGH | `references/react-compiler-destructure-functions.md` |
| 8.2 | Use .get()/.set() for Reanimated shared values | LOW | `references/react-compiler-reanimated-shared-values.md` |
| 9.1 | Measure views with onLayout, not measure() | MEDIUM | `references/ui-measure-views.md` |
| 9.2 | Modern styling: borderCurve, gap, boxShadow | MEDIUM | `references/ui-styling.md` |
| 9.3 | Use contentInset for dynamic ScrollView spacing | LOW | `references/ui-scrollview-content-inset.md` |
| 9.4 | Use contentInsetAdjustmentBehavior for safe areas | MEDIUM | `references/ui-safe-area-scroll.md` |
| 9.5 | Use expo-image for all images | HIGH | `references/ui-expo-image.md` |
| 9.6 | Use Galeria for image galleries and lightbox | MEDIUM | `references/ui-image-gallery.md` |
| 9.7 | Use native menus (zeego) for dropdowns | HIGH | `references/ui-menus.md` |
| 9.8 | Use native modals over JS bottom sheets | HIGH | `references/ui-native-modals.md` |
| 9.9 | Use Pressable instead of TouchableOpacity | LOW | `references/ui-pressable.md` |
| 10.1 | Use compound components over polymorphic children | MEDIUM | `references/design-system-compound-components.md` |
| 11.1 | Install native dependencies in app directory | CRITICAL | `references/monorepo-native-deps-in-app.md` |
| 11.2 | Use single dependency versions across monorepo | MEDIUM | `references/monorepo-single-dependency-versions.md` |
| 12.1 | Import from design system folder | LOW | `references/imports-design-system-folder.md` |
| 13.1 | Hoist Intl formatter creation | LOW | `references/js-hoist-intl.md` |
| 14.1 | Load fonts natively at build time | LOW | `references/fonts-config-plugin.md` |
| 15.1 | Use reactive query hooks, not imperative cache reads | HIGH | `references/query-cache-reactive.md` |
| 15.2 | Avoid Reanimated layout animations in virtualized lists | HIGH | `references/reanimated-in-lists.md` |
| 15.3 | Consume theme hooks inside list items, not in renderItem | HIGH | `references/theme-memoization-lists.md` |

---

## CRITICAL Rules (inline — always check these)

These cause **runtime crashes**. Check regardless of review scope.

### 1.1 Never Use `&&` with Potentially Falsy Values

`{value && <Component />}` when `value` could be `0` or `""` crashes React Native.
These are falsy but JSX-renderable — RN renders them as text outside `<Text>`.

**Bad:** `{count && <Badge count={count} />}` — renders "0" when count is 0
**Good:** `{count > 0 && <Badge count={count} />}` or `{count ? <Badge /> : null}`

Lint rule: enable `react/jsx-no-leaked-render`.
Full examples: `references/rendering-no-falsy-and.md`

### 1.2 Wrap All Strings in `<Text>` Components

A string as a direct child of `<View>` causes a runtime crash.

**Bad:** `<View>Hello, {name}!</View>`
**Good:** `<View><Text>Hello, {name}!</Text></View>`

Full examples: `references/rendering-text-in-text-component.md`

---

## How to Use This Skill

### During Architecture (Phase 4)
Scan the rule index. For CRITICAL and HIGH rules relevant to the feature being
designed, read the full reference file and apply constraints to the blueprint.

### During Review (Phase 6, Pass 4)
1. Always check CRITICAL rules 1.1 and 1.2 (inline above)
2. Scan code under review for patterns matching HIGH/MEDIUM/LOW categories
3. For each match, read the corresponding `references/<rule>.md` file
4. Report findings with citation: `[RN-2.1] Rule Name — IMPACT`

### During Implementation (Phase 5)
Consult relevant rules before writing code. E.g., when writing a FlatList,
read `references/list-performance-virtualize.md` and `references/list-performance-item-memo.md`.

---

## Categories by Priority

| Priority | Category | Count | Key Patterns to Scan For |
|----------|----------|-------|--------------------------|
| 1 | Core Rendering | 2 | `&&` conditionals, bare strings in Views |
| 2 | List Performance | 8 | FlatList, ScrollView+map, renderItem, inline objects |
| 3 | Animation | 3 | Reanimated, useSharedValue, Animated, width/height animation |
| 4 | Scroll | 1 | useState with scroll position, onScroll |
| 5 | Navigation | 1 | createStackNavigator, JS-based tabs |
| 6 | React State | 3 | useState, derived state, initialState props |
| 7 | State Architecture | 1 | shared values storing visuals instead of state |
| 8 | React Compiler | 2 | .value on shared values, dotting into hook returns |
| 9 | User Interface | 9 | Image, TouchableOpacity, Modal, SafeAreaView, measure() |
| 10 | Design System | 1 | polymorphic children, string children on non-Text |
| 11 | Monorepo | 2 | native deps, version conflicts |
| 12 | Third-Party Deps | 1 | direct imports from node_modules |
| 13 | JavaScript | 1 | Intl formatters in render |
| 14 | Fonts | 1 | useFonts, Font.loadAsync |
