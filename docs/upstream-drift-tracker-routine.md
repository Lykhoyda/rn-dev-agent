# Routine — Dependency & upstream drift tracker (rn-dev-agent)

Read-only investigation → file an issue **only on actionable findings**. Cadence: **weekly**.
Persist incremental state in **rolling tracker issue #227** so each run is incremental.

This is a self-contained routine prompt: register it as a scheduled agent (or run it on demand).
It needs the `Lykhoyda/rn-dev-agent` checkout + `gh` access. It does **not** modify code or open PRs.

---

## Why this exists

rn-dev-agent drives a React Native app through machinery it does not own — the Metro
inspector, Hermes' CDP surface, the `@react-native/dev-middleware` origin gates, Maestro's
flow schema, and the `agent-device` CLI. When any of those drift, the plugin breaks for
every user on that toolchain, silently. B177/B178 were exactly this: Expo SDK 56 + RN 0.85
changed the inspector's origin gates and the CDP bridge started returning zero frames.

The expensive lesson from B178: **the changelog was wrong / incomplete.** The real cause
(Expo's *second* `isMatchingOrigin` gate in `createDebugMiddleware`) was only found by
reading the middleware source, not the release notes. So in this routine **changelogs are
SECONDARY sources — verify every claim against the actual file before you classify it.**

## SCOPE (hard constraint)

Read-only investigation + issue/comment creation **only**. Do **NOT** modify code, edit
files, or open PRs. The single mutable artifact you may write to is tracker issue **#227**
(comments / run-log appends) and — only on an actionable finding — a new issue.

---

## Step 1 — CHECK NEW VERSIONS

Record the `last-checked → latest` delta per surface (pull `last-checked` from the baseline
table / latest run-log comment in **#227**). The watched surfaces:

| Surface | Where to look |
|---|---|
| **react-native** | npm `react-native` + GitHub releases/CHANGELOG `facebook/react-native` (track RCs + betas, not just stable) |
| **expo (SDK)** | npm `expo` + GitHub releases `expo/expo` (SDK betas land months before stable) |
| **@react-native/dev-middleware** | bundled by RN — resolve its version from the RN release; releases under `facebook/react-native` (`packages/dev-middleware`) |
| **metro** | npm `metro` + GitHub releases `facebook/metro` |
| **hermes** | shipped inside RN — track via the RN release notes' Hermes bump |
| **maestro** | GitHub releases `mobile-dev-inc/maestro`; also note the installed `~/.maestro-runner/bin/maestro-runner --version` |
| **agent-device** | npm `agent-device` |

Quick commands:

```bash
for p in react-native expo @react-native/dev-middleware metro agent-device; do
  printf "%-32s " "$p"; npm view "$p" version; done
~/.maestro-runner/bin/maestro-runner --version 2>/dev/null | head -1
gh release list --repo facebook/react-native --limit 5
gh release list --repo expo/expo --limit 5
gh release list --repo mobile-dev-inc/maestro --limit 5
```

## Step 2 — MAP EACH CHANGE TO OUR CODE

For every version with a delta, classify each relevant change as **BREAKING / IMPROVEMENT /
NO-IMPACT**. Changelogs are SECONDARY — open the file and verify the claim before classifying.

| Upstream change touches… | Verify against |
|---|---|
| Inspector handshake / origin / CSRF gates | `scripts/cdp-bridge/src/ws-origin.ts` → `metroOrigin()` (must clear BOTH the loopback gate and Expo's `isMatchingOrigin` host-match gate; today `http://127.0.0.1:{port}`) |
| Inspector target discovery (`/json` endpoint, target fields) | `scripts/cdp-bridge/src/cdp/discovery.ts` → `GET /json/list`; depends on `webSocketDebuggerUrl`, `title`, `vm === 'Hermes'`, `description`, `deviceName` (Metro 0.76+), and the `title.includes('Experimental')` exclusion |
| Hermes CDP domain support | `scripts/cdp-bridge/src/cdp/setup.ts` → `Runtime.enable`, `Debugger.enable`, `Network.enable` (+ hook-fallback probe, D626), `Log.enable`, `Profiler.enable`, `HeapProfiler.enable` |
| Fiber-tree / React internals walk | `scripts/cdp-bridge/src/injected-helpers.ts`, `bridge-detector.ts` |
| Profiling (heap / CPU) | `scripts/cdp-bridge/src/tools/profiling.ts` |
| Maestro flow YAML / CLI flags / runner protocol | `scripts/cdp-bridge/src/maestro-invoke.ts` (flow built via `buildMaestroFlow` + `domain/maestro-validator.ts`, `--app-file` per GH #201, runner→CLI tiered dispatch), `scripts/cdp-bridge/src/tools/maestro-run.ts` |
| agent-device verbs / args / protocol (Android) | `scripts/cdp-bridge/src/agent-device-wrapper.ts` (verbs `tap/fill/swipe/scroll/longpress/pinch/snapshot/screenshot/back`; args `--hold-ms`, `interactiveOnly`, `bundleId`), `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` |
| Node minimum version | `scripts/cdp-bridge/package.json` → `engines.node` (`>=22`) |

## Step 3 — BREAKING is any of:

- A Metro `/json/list` **endpoint path change**, target **field rename/removal**, or `vm`
  value change (e.g. `Hermes` → something else) — breaks target discovery.
- A **new or changed origin gate** (a third gate beyond loopback + Expo host-match, or a
  change to what host the inspector accepts) — re-breaks the B177/B178 handshake.
- A **CDP domain we `.enable()` now rejected/removed** by the bundled Hermes
  (`Runtime`/`Debugger`/`Network`/`Log`/`Profiler`/`HeapProfiler`) — breaks introspection.
- An **`agent-device` verb or arg removed/renamed** (`tap`, `fill`, `swipe`, `scroll`,
  `longpress`, `pinch`, `snapshot`, `screenshot`, `back`, `--hold-ms`, `bundleId`) — breaks
  Android device control.
- A **Maestro flow-command schema change** or a **CLI flag we pass removed/renamed**
  (notably `--app-file`) — breaks E2E flow replay.
- A **Node minimum-version bump** above what we declare in `engines`.

## Step 4 — WATCH-LIST (flag immediately if RESOLVED — they un-gate work)

- **`Network.enable` native event delivery on new RN** — if a release makes Hermes emit
  Network events reliably under Bridgeless, we can drop the hook fallback (D626). High value.
- **Fusebox / Bridgeless inspector zero-frame quirks** — any fix to the post-handshake
  zero-CDP-frame class (B177/B178 lineage).
- **maestro-runner iOS `clearState` / `--app-file` gaps** (GH #201) — if upstream closes
  these, the raw-CLI escape path can be removed.

## Step 5 — IMPROVEMENT (list separately from breaking)

A new flag / capability we should adopt: a new CDP domain Hermes now supports, a new Maestro
flow command, a new `agent-device` verb, a faster runner mode, a new RN DevTools feature.

## Step 6 — DEDUP before filing

Search open issues + the rolling tracker **#227**. If a matching open issue/thread already
exists, **comment the new delta** — do NOT open a duplicate. Open a NEW issue only for an
actionable BREAKING or IMPROVEMENT finding.

```bash
gh issue list --repo Lykhoyda/rn-dev-agent --state open --label upstream
```

## Step 7 — IF NOTHING ACTIONABLE

Do NOT create an issue. Append a one-line run-log note to tracker **#227**, e.g.:

> `checked RN X / Expo Y / dev-middleware Z / metro M / maestro N / agent-device A — no impact`

(Auditable runs without backlog noise.)

```bash
gh issue comment 227 --repo Lykhoyda/rn-dev-agent \
  --body "YYYY-MM-DD — checked RN … / Expo … / metro … / maestro … / agent-device … — no impact"
```

Also update the baseline `last-checked` values in #227 when they advance, so the next run is
incremental.

## Step 8 — ISSUE FORMAT (when filing)

- **Title:** `upstream: <surface> <newver> — <breaking|improvement> affecting <area>`
- **Body:**
  - Versions checked (old → new per surface)
  - Verdict (BREAKING / IMPROVEMENT)
  - Table: `change → file:line → severity → recommended action`
  - Improvement opportunities (separately)
  - **What you verified against code/tests** (not just the changelog — cite the file you read)
- **Labels:** `upstream` + `kano:needs-triage` + an `effort:s|m|l` estimate
  (per `docs/kano-model/kano-label-scheme-and-triage.md`).

---

## Run checklist

1. Read the baseline / latest run-log in **#227** for `last-checked` per surface.
2. Step 1 — fetch latest versions; compute deltas.
3. Step 2 — for each delta, open the mapped file and verify; classify.
4. Steps 3–5 — sort findings into BREAKING / WATCH-LIST-resolved / IMPROVEMENT.
5. Step 6 — dedup against open issues + #227.
6. Step 7 or 8 — append a no-impact run-log line to #227, **or** file the actionable issue(s).
7. Advance the `last-checked` baseline in #227.
