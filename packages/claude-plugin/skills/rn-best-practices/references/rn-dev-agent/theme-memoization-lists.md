---
title: Consume Theme Hooks Inside List Items, Not in renderItem
impact: HIGH
impactDescription: prevents full list re-render on theme changes
tags: lists, performance, hooks, theme, memoization
---

## Consume Theme Hooks Inside List Items, Not in renderItem

When using theme hooks (e.g., `useThemeColors()`, `useColorScheme()`) with
virtualized lists, call the hook inside the memoized list item component —
not in the parent and passed as a prop.

**Incorrect (theme object as prop defeats memo):**

```tsx
function TaskList({ tasks }: { tasks: Task[] }) {
  const colors = useThemeColors()

  const renderItem = useCallback(({ item }: { item: Task }) => (
    <TaskRow task={item} colors={colors} />
  ), [colors])

  return <FlashList data={tasks} renderItem={renderItem} />
}

const TaskRow = memo(function TaskRow({ task, colors }: Props) {
  return (
    <View style={{ backgroundColor: colors.card }}>
      <Text style={{ color: colors.text }}>{task.title}</Text>
    </View>
  )
})
```

`colors` is a new object reference on every render (hooks return fresh objects).
This makes `renderItem` unstable (recreated when `colors` changes), which forces
FlashList to re-render ALL visible items. `memo()` on TaskRow is defeated because
the `colors` prop is a new reference.

**Correct (theme consumed inside the item):**

```tsx
function TaskList({ tasks }: { tasks: Task[] }) {
  const renderItem = useCallback(({ item }: { item: Task }) => (
    <TaskRow task={item} />
  ), [])

  return <FlashList data={tasks} renderItem={renderItem} />
}

const TaskRow = memo(function TaskRow({ task }: { task: Task }) {
  const colors = useThemeColors()
  return (
    <View style={{ backgroundColor: colors.card }}>
      <Text style={{ color: colors.text }}>{task.title}</Text>
    </View>
  )
})
```

Now `renderItem` has zero dependencies and never changes. Each `TaskRow` calls
`useThemeColors()` independently — when the theme changes, all items re-render
(which is correct), but when data changes, only affected items re-render.

**This pattern applies to any hook that returns objects:**
- `useThemeColors()` / `useColorScheme()`
- `useWindowDimensions()`
- `useAnimatedStyle()` results passed as props
- Custom hooks that return `{ ... }` objects

The rule: if a hook returns an object and you're using it in a list, call
the hook inside the item component, not the parent.
