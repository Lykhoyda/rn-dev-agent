# Navigation Debugging Patterns

Known React Navigation issues and workarounds relevant to CDP testing.

---

## B75: Modal→Nested Tab Navigation Fails

**Symptom:** After dismissing a RootStack modal screen via `goBack()`, a subsequent
`navigate('Tabs', { screen: 'TasksTab', params: { screen: 'TaskDetail', ... } })`
lands on the Tabs root instead of the nested screen.

**Root cause:** React Navigation native-stack does not forward nested `params` to
already-mounted tab navigators when navigating from a screen being removed from
the stack. The component unmounts during the dismiss animation, and all closures
(setTimeout, requestAnimationFrame, InteractionManager) are garbage collected.

**Approaches that DO NOT work:**
- `goBack()` + `setTimeout(navigate, 100-600ms)` — component unmounts, callback GC'd
- `goBack()` + `__NAV_REF__.navigate()` — same GC issue
- `navigation.addListener('beforeRemove')` + `requestAnimationFrame` — fires but navigate is swallowed
- `InteractionManager.runAfterInteractions` in useEffect cleanup — same issue
- `CommonActions.reset` with nested params — reaches Tabs but doesn't forward to nested stack
- `presentation: 'modal'` / `'fullScreenModal'` / `'containedTransparentModal'` / `animation: 'slide_from_bottom'` — all exhibit the same behavior

**Approach that WORKS (verified via CDP):**
Calling `__NAV_REF__.navigate()` from **outside** the component lifecycle (e.g., from
`cdp_evaluate` or from a global event bus) after the modal is fully removed from
the navigation state.

**Recommended workaround for app code:**
```typescript
// In App.tsx or a global navigation service:
import { DeviceEventEmitter } from 'react-native';

DeviceEventEmitter.addListener('navigateAfterDismiss', ({ name, params }) => {
  navigationRef.current?.navigate(name, params);
});

// In the modal component:
const onResultPress = (category: string, id: string) => {
  navigation.goBack();
  DeviceEventEmitter.emit('navigateAfterDismiss', {
    name: 'Tabs',
    params: { screen: 'TasksTab', params: { screen: 'TaskDetail', params: { id } } },
  });
};
```

The event listener runs on the App component which is never unmounted, so the
navigate call survives the modal dismiss.

**CDP debugging steps:**
1. `cdp_navigation_state` — check if modal is still in the stack
2. `cdp_evaluate` expression: `globalThis.__NAV_REF__?.getRootState()?.routes.map(r => r.name)` — verify route list
3. `cdp_evaluate` expression: `globalThis.__NAV_REF__?.navigate('Tabs', { screen: 'TasksTab', params: { screen: 'TaskDetail', params: { id: '1' } } })` — test navigation directly from CDP (this always works)

---

## Nested Navigator Navigate Patterns

When navigating to screens inside nested navigators, always provide the full path:

```typescript
// From inside the same tab stack — works:
navigation.navigate('TaskDetail', { id: '1' });

// From a different tab — must specify the full nesting:
navigation.navigate('Tabs', {
  screen: 'TasksTab',
  params: { screen: 'TaskDetail', params: { id: '1' } },
});

// From a modal/overlay screen — use the navigation container ref:
navigationRef.current?.navigate('Tabs', { ... });
```

**CDP tool for this:** `cdp_navigate(screen="TaskDetail", params={ id: "1" })`
uses the injected `navigateTo()` helper which recursively walks the navigation
state to find the target screen at any nesting depth.
