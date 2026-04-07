# Initialize App Once, Not Per Mount

**Impact: HIGH (avoids duplicate init in Strict Mode / React Compiler)**

Do not put app-wide initialization inside `useEffect([])`. Components can remount (Strict Mode, Suspense boundaries, navigation) and effects will re-run. Use a module-level guard instead.

**Incorrect (runs twice in dev, re-runs on remount):**

```tsx
function App() {
  useEffect(() => {
    analytics.init('key-123')
    crashReporter.start()
    pushNotifications.register()
  }, [])

  return <Navigator />
}
```

**Correct (once per app load):**

```tsx
let didInit = false

function App() {
  useEffect(() => {
    if (didInit) return
    didInit = true
    analytics.init('key-123')
    crashReporter.start()
    pushNotifications.register()
  }, [])

  return <Navigator />
}
```

**Or even better — at module level (no component needed):**

```tsx
// app-init.ts — imported once in entry file
analytics.init('key-123')
crashReporter.start()

// App.tsx
import './app-init'

export default function App() {
  return <Navigator />
}
```

Common React Native cases:
- Analytics SDK initialization (Amplitude, Mixpanel, Firebase)
- Crash reporting setup (Sentry, Bugsnag)
- Push notification registration
- Auth token refresh setup
- Global fetch interceptors / mock setup

Source: [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (MIT License)
