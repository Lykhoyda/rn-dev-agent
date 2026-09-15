---
title: Avoid Reanimated Layout Animations in Virtualized Lists
impact: HIGH
impactDescription: prevents recycling breakage and layout jumping
tags: reanimated, lists, performance, animation
---

## Avoid Reanimated Layout Animations in Virtualized Lists

Do not use Reanimated `entering`, `exiting`, or `layout` animations on items
inside `FlatList`, `FlashList`, or `LegendList`. Layout animations break list
recycling — the virtualizer cannot reuse views that have active animation
state, causing massive performance drops and layout jumping.

**Incorrect (layout animations on list items):**

```tsx
function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <FlatList
      data={tasks}
      renderItem={({ item }) => (
        <Reanimated.View
          entering={SlideInRight}
          exiting={FadeOut}
          layout={Layout.springify()}
        >
          <TaskRow task={item} />
        </Reanimated.View>
      )}
    />
  )
}
```

Each item gets its own animation state. When the virtualizer recycles a view
(scrolls off-screen item into a new position), the animation state from the
previous item persists, causing:
- Layout jumping as spring animations fight the virtualizer
- Stale entering animations replaying on recycled views
- Memory leaks from animation worklets that never clean up

**Correct (no layout animations on list items):**

```tsx
function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <FlatList
      data={tasks}
      renderItem={({ item }) => <TaskRow task={item} />}
    />
  )
}
```

**If you need animated list items**, use one of these approaches:

1. **Animated header/footer** — apply `entering` only to the list header or
   sticky elements, not individual items:

```tsx
<Animated.View entering={FadeInDown}>
  <Text>Tasks ({tasks.length})</Text>
</Animated.View>
<FlatList data={tasks} renderItem={renderItem} />
```

2. **LayoutAnimation for batch updates** — use React Native's `LayoutAnimation`
   for insert/delete animations that work with the virtualizer:

```tsx
import { LayoutAnimation } from 'react-native'

function addTask(task: Task) {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
  dispatch(addTask(task))
}
```

3. **Animated opacity/transform on individual items** — use `useAnimatedStyle`
   with shared values (not `entering`/`exiting` props) for per-item animations
   that don't conflict with recycling:

```tsx
const TaskRow = memo(function TaskRow({ task }: { task: Task }) {
  const opacity = useSharedValue(0)
  useEffect(() => { opacity.value = withTiming(1) }, [])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return <Animated.View style={style}><Text>{task.title}</Text></Animated.View>
})
```
