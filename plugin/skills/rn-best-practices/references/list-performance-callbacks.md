---
title: Hoist callbacks to the root of lists
impact: HIGH
impactDescription: Fewer re-renders and faster lists
tags: lists, performance, callbacks, memoization
---

## Hoist Callbacks to the Root of Lists

When passing callback functions to list items, create a single instance of the
callback at the root of the list. Items should then call it with a unique
identifier.

**Incorrect (creates a new callback on each render):**

```typescript
return (
  <LegendList
    renderItem={({ item }) => {
      // bad: creates a new callback on each render
      const onPress = () => handlePress(item.id)
      return <Item key={item.id} item={item} onPress={onPress} />
    }}
  />
)
```

**Correct (a single function instance passed to each item):**

```typescript
const handleItemPress = useCallback((id: string) => {
  handlePress(id)
}, [handlePress])

return (
  <LegendList
    renderItem={({ item }) => (
      <Item key={item.id} item={item} onPress={handleItemPress} />
    )}
  />
)
```

The item component receives the stable `handleItemPress` reference. Inside the
item, call `onPress(id)` with its own ID:

```typescript
const Item = memo(function Item({ item, onPress }) {
  const handlePress = useCallback(() => onPress(item.id), [onPress, item.id])
  return <Pressable onPress={handlePress}><Text>{item.title}</Text></Pressable>
})
```
