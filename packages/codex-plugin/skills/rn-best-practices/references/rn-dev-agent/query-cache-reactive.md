---
title: Use Reactive Query Hooks, Not Imperative Cache Reads
impact: HIGH
impactDescription: prevents stale search/filter results
tags: react-query, tanstack, cache, state
---

## Use Reactive Query Hooks, Not Imperative Cache Reads

Never use `queryClient.getQueryData()` inside `useMemo` or render logic. It is
an imperative snapshot that does not trigger re-renders when the cache updates.
Use `useQuery` or a query observer for reactive access.

**Incorrect (non-reactive cache read):**

```tsx
function SearchResults({ query }: { query: string }) {
  const queryClient = useQueryClient()

  const results = useMemo(() => {
    const data = queryClient.getQueryData<FeedData>(['feed'])
    if (!data) return []
    return data.items.filter((item) => item.title.includes(query))
  }, [query, queryClient])

  return <FlatList data={results} renderItem={renderItem} />
}
```

If the feed cache updates in the background (refetch, mutation), `results`
stays stale because `useMemo` doesn't subscribe to the query client.

**Correct (reactive via useQuery):**

```tsx
function SearchResults({ query }: { query: string }) {
  const { data } = useQuery({
    queryKey: ['feed'],
    enabled: false,
  })

  const results = useMemo(() => {
    if (!data) return []
    return data.items.filter((item) => item.title.includes(query))
  }, [query, data])

  return <FlatList data={results} renderItem={renderItem} />
}
```

`useQuery` with `enabled: false` subscribes to the cache without triggering
a fetch. When the cache updates from another component's fetch, this component
re-renders with fresh data.

**Alternative (query observer for non-component code):**

```tsx
const observer = new QueryObserver(queryClient, { queryKey: ['feed'] })
const unsubscribe = observer.subscribe((result) => {
  console.log('Feed updated:', result.data)
})
```

Use `getQueryData` only for one-shot reads outside the render cycle (e.g.,
in event handlers, before navigation, or in optimistic update logic).
