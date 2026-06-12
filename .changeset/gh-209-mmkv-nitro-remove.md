---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`cdp_mmkv` delete and boolean reads now work on the Nitro react-native-mmkv line (GH #209).

- `delete` was calling `mmkv.delete(key)` — a JS-wrapper-class method that doesn't exist on the raw Nitro hybrid object the tool actually talks to (`createHybridObject('MMKVFactory').createMMKV(...)`), whose spec exposes `remove(key)`. The generated expression now prefers `remove()`, falls back to `delete()` for wrapper-shaped objects, and reports a named error (instead of a bare TypeError) when neither exists. This unblocks first-class auth/storage resets for logged-out replays on iOS — previously a raw `cdp_evaluate` escape hatch every time.
- `get` with `type: 'boolean'` emitted `mmkv.getBool(key)`, which exists on no MMKV surface (hybrid object and wrapper both spell it `getBoolean`) — broken since the tool shipped. Now fixed.
- The follow-up enhancement from the issue (a `clearKeys:` action-YAML directive for self-contained auth-gated replays) is tracked as GH #286.
