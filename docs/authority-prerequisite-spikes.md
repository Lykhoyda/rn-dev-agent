# Parallel-session authority prerequisite spikes

Issue #582 makes four mechanisms prerequisites for strict authority. A failed or unavailable
mechanism returns a named error; none has a warning-only authority fallback.

## Node 22 SQLite substrate

The owned worker launch adds `--experimental-sqlite` for Node versions where the module is
flag-gated and preloads a warning filter. The filter removes only:

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

All unrelated warnings remain visible. The spike was exercised with Node 22.12.0:

```text
node -e "require('node:sqlite')"                       -> ERR_UNKNOWN_BUILTIN_MODULE
node --experimental-sqlite <probe>                    -> node22
node --experimental-sqlite --import <filter> <probe>  -> node22 + unrelated warning preserved
```

`probeAuthorityStore()` reports `AUTHORITY_STORE_UNAVAILABLE` when SQLite cannot load.
`openAuthorityStore()` throws the same named error and never substitutes JSON or lockfiles.

## Metro and initial-bundle binding

The Metro adapter composes with both Expo and bare React Native serializer configuration:

```text
existing modules-before-main
          │
          ▼
signed authority module ─► initial app bundle ─► runtime marker
          │
          └── session + Metro instance + worktree + app + platform + build generation
```

The spike composed with `@expo/metro-config` 57.0.7 and
`@react-native/metro-config` 0.86.0 while preserving their existing custom serializers.
The generated module uses only `globalThis`, so it is independent of Hermes bridge mode.

Fast Refresh does not rerun the initial serializer hook. The marker therefore proves only
coarse initial-bundle Metro/session/worktree provenance. It explicitly reports
`sourceFidelity: not-proven`; it does not claim HMR revision or source-content fidelity.
When signing is unavailable, Metro receives an unsigned `unavailable` marker and continues
building, while authoritative tools return `BUNDLE_HANDSHAKE_UNAVAILABLE`.

## Portable process-birth identity

Process identity is derived from the OS and hashed:

- macOS: `ps` process start plus `kern.boottime`
- Linux: `/proc/<pid>/stat` start ticks plus kernel boot ID
- Windows: PowerShell `StartTime` ticks

Unreadable or malformed identity returns `null`. Ownership comparison treats `null` as a
mismatch, so PID reuse or insufficient permission cannot be reported as a live matching owner.

## Literal package-script integration

The previewed integration replaces only recognized `ios` and `android` scripts with a
project-local sentinel adapter and records the original argv in a reversible manifest.
Shell operators and unknown session-aware command shapes are refused.

The session plan uses the current CLI contracts:

| CLI | Exact device | Metro |
| --- | --- | --- |
| Expo iOS/Android | `--device` | `--port`, `RCT_METRO_PORT`, `--no-bundler` |
| Bare React Native iOS | `--udid` | `--port`, `RCT_METRO_PORT`, `--no-packager` |
| Bare React Native Android | `--deviceId` | `--port`, `RCT_METRO_PORT`, `--no-packager` |

The copied adapter is self-contained. If no session binding exists, it executes the recorded
original argv plus user arguments unchanged, so literal `pnpm ios` and `pnpm android` continue
to work after the plugin is unavailable. When a binding exists, conflicting device, platform,
or port arguments fail with `SESSION_BUILD_IDENTITY_CONFLICT`.

For a bound session, the adapter first validates or starts the package-local Expo/bare Metro
CLI on the allocated port. It binds the actual listening PID, portable birth token, serving
root, and random Metro instance—not merely the launcher shim—before preparing the build.
Managed cleanup requires a signed management proof and the same launcher birth identity.

## Executable evidence

The contracts are covered by:

- `test/unit/session/authority-store.test.js`
- `test/unit/sqlite-warning-filter.test.js`
- `test/unit/session/metro-authority.test.js`
- `test/unit/session/process-birth.test.js`
- `test/unit/session/build-adapter.test.js`
- `test/unit/session/package-integration.test.js`
- `test/unit/session/managed-metro.test.ts`
