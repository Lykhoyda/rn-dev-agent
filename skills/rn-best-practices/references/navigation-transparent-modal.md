---
title: Avoid `presentation: 'transparentModal'` on Bridgeless + react-native-screens
impact: HIGH
impactDescription: silent visual breakage — component tree renders correctly but native view is opaque white
tags: navigation, native-stack, react-native-screens, bridgeless, modal, overlay
---

## Avoid `presentation: 'transparentModal'` on Bridgeless + react-native-screens

On `react-native-screens ~4.4.0` with RN 0.76.7, Expo 52, and Bridgeless mode
(the C++ connection / New Architecture), a `@react-navigation/native-stack`
screen declared with `presentation: 'transparentModal'` renders a fully **white
opaque background** instead of the transparent overlay implied by the name.

### Why this matters

- The failure is **silent at the JS layer**: `cdp_component_tree` shows every
  element with the correct styles (`backgroundColor: 'transparent'`,
  `BlurView`, etc.). The opacity appears only at the native view hierarchy.
- No console error, no RedBox, no navigation state anomaly. Looks fine until
  you open the simulator.
- Equally affects every related presentation mode tested on this combo —
  `'containedTransparentModal'`, `'modal'` + `contentStyle: { backgroundColor: 'transparent' }`,
  `'slide_from_bottom'` with `transparentModal`. They all render white.

### Incorrect

```tsx
// @react-navigation/native-stack on RN 0.76.7 Bridgeless
<Stack.Screen
  name='CommandPalette'
  component={CommandPaletteScreen}
  options={{
    presentation: 'transparentModal',          // ← blank white on Bridgeless
    animation: 'slide_from_bottom',
    contentStyle: { backgroundColor: 'transparent' },
    headerShown: false,
  }}
/>
```

```tsx
// Inside the modal component — relies on the underlying screen being visible
function CommandPaletteScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: 'transparent' }}>
      <BlurView intensity={80} style={StyleSheet.absoluteFill}>
        <FrostedCard>…</FrostedCard>
      </BlurView>
    </View>
  )
}
```

### Correct — dark BlurView canvas (D613 workaround)

Treat the modal as a **dedicated dark surface** — not an overlay over the
caller screen. The glass effect comes from the inner card container, not from
blurring the caller. Matches how iOS Spotlight and VS Code command palette
render.

```tsx
<Stack.Screen
  name='CommandPalette'
  component={CommandPaletteScreen}
  options={{
    animation: 'slide_from_bottom',            // ← opaque full-screen, works
    headerShown: false,
  }}
/>
```

```tsx
function CommandPaletteScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.85)' }}>
      <BlurView
        intensity={80}
        tint='dark'
        style={StyleSheet.absoluteFill}
      />
      <FrostedCard style={{ borderRadius: 24 }}>…</FrostedCard>
    </View>
  )
}
```

### Tested combinations (all fail)

| Setup                                                                        | Result         |
| ---------------------------------------------------------------------------- | -------------- |
| `presentation: 'transparentModal'` + `animation: 'slide_from_bottom'`        | Blank white    |
| `presentation: 'transparentModal'` alone (no animation)                      | Blank white    |
| `presentation: 'transparentModal'` + `contentStyle: { backgroundColor: … }`  | Blank white    |
| `presentation: 'containedTransparentModal'`                                  | Blank white    |
| `animation: 'slide_from_bottom'` (no `transparentModal`) + dark BlurView     | Works ✅       |

### When the rule applies

Check for this pattern when:

- You're on **RN 0.76.x with Bridgeless / New Architecture enabled**
- `react-native-screens` is pinned at **4.4.x–4.19.x** (version ceiling
  untested; upgrade to `4.24.x+` if possible and retest before applying the
  workaround)
- You're using `@react-navigation/native-stack` (not JS stack)
- The visible screen is blank white but `cdp_component_tree` confirms content

### CDP debugging signature

```ts
// 1. Confirm JS render is correct
cdp_component_tree({ testID: 'command-palette' })
// → returns tree with BlurView, FrostedCard, etc. — proves JS is fine

// 2. Confirm navigation stack is correct
cdp_navigation_state()
// → shows the modal route present at top of stack

// 3. Screenshot proves the mismatch
device_screenshot({ path: '/tmp/repro.jpg' })
// → blank white image despite step 1's correct tree
```

If all three signals hold, you're hitting B109.

### Before upgrading react-native-screens

Newer versions (`4.20+`) may have fixed the underlying compositor issue. If
you control dependencies:

1. Upgrade `react-native-screens` to the latest patch in the 4.x line
2. Rebuild the dev client (`npx expo prebuild --clean && eas build --local`)
3. Retest the original `presentation: 'transparentModal'` setup
4. If fixed, delete the workaround and use the native presentation
5. If still broken, file an upstream issue on
   [software-mansion/react-native-screens](https://github.com/software-mansion/react-native-screens/issues)
   with a minimal repro and link back to this document

### Why not a transparent backdrop rendered by the modal itself

Both approaches produce visually similar output, but the dedicated dark canvas
is preferred because:

- **No layer stacking ambiguity**: iOS compositor sees one opaque view instead
  of two stacked translucent surfaces.
- **Animation is cheap**: `slide_from_bottom` on a full-screen opaque view is
  a native iOS transition; a transparent overlay requires the system to
  composite the old screen every frame.
- **Predictable across RN versions**: the workaround survives Bridgeless
  mode changes, Fabric flag flips, and react-native-screens upgrades.

Reference:

- B109 (docs/BUGS.md) — original benchmark discovery
- D613 (docs/DECISIONS.md) — workaround rationale
- [react-native-screens presentation docs](https://reactnavigation.org/docs/native-stack-navigator#presentation)
