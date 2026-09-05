---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Allow the managed-Metro Darwin sandbox to write only the canonical `.cache` directory of the exact `react-native-css-interop` package the app's Metro config resolves, so NativeWind apps earn `managed-sandbox-v1` while every other dependency, source, protected, escaped, and shared-store path stays read-only.
