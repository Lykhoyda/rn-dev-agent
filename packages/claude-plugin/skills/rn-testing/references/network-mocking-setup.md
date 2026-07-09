# Network Mocking Setup for React Native Testing

Intercept and mock network requests at the `fetch` level so API-dependent features
can be tested without a live backend.

## App-Side Setup (dev only)

Add to the app entry point (e.g., `App.tsx` or `app/_layout.tsx`):

```typescript
// Patch fetch once — intercepts requests when __RN_AGENT_MOCKS__ is set
if (__DEV__ && !global.__RN_AGENT_FETCH_PATCHED__) {
  global.__RN_AGENT_FETCH_PATCHED__ = true;
  const origFetch = global.fetch;
  global.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const mocks = global.__RN_AGENT_MOCKS__;
    if (!mocks) return origFetch(input, init);

    const url = typeof input === 'string'
      ? input
      : input instanceof Request
        ? input.url
        : input.toString();

    if (mocks[url]) {
      return Promise.resolve(
        new Response(JSON.stringify(mocks[url]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return origFetch(input, init);
  };
}
```

## Injecting Mocks via CDP

Set mocks before navigating to the screen under test:

```
cdp_evaluate:
  expression: 'global.__RN_AGENT_MOCKS__ = { "https://api.example.com/products": [{ id: 1, name: "Test" }] }'
```

## Clearing Mocks

Remove all mocks to restore real network requests:

```
cdp_evaluate:
  expression: 'delete global.__RN_AGENT_MOCKS__'
```

## Multiple URL Mocking

Mock several endpoints at once:

```
cdp_evaluate:
  expression: |
    global.__RN_AGENT_MOCKS__ = {
      "https://api.example.com/products": [{ id: 1, name: "Shoes" }],
      "https://api.example.com/cart": { items: [], total: 0 },
      "https://api.example.com/user": { name: "Test User", email: "test@example.com" }
    }
```

## Error Simulation

Mock a failed response by including `__mockStatus` in the mock value. The
fetch patch must be extended to read this field:

```typescript
// Extended fetch patch — replace the Response creation block with:
if (mocks[url]) {
  const mockData = mocks[url];
  const status = mockData.__mockStatus ?? 200;
  const body = { ...mockData };
  delete body.__mockStatus;
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}
```

Then inject error mocks via CDP:
```
cdp_evaluate:
  expression: 'global.__RN_AGENT_MOCKS__["https://api.example.com/checkout"] = { __mockStatus: 500, error: "Internal Server Error" }'
```
