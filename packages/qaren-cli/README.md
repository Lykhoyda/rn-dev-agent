# qaren — plan-based React Native QA CLI

`qaren check` owns a QA run against the current app worktree: it leases a
simulator, prepares the app and Metro, starts the TypeScript screen child,
walks a Markdown plan, writes evidence, and tears down owned resources.
QaReN is still in development; this checkout is not the published 1.x MCP plugin.
The scenario-based preparation verbs remain available for explicit iOS,
NUC Android and USB Android setup experiments.

## Build

```sh
corepack yarn install --immutable
corepack yarn build:core
cargo build --manifest-path packages/qaren-cli/Cargo.toml --locked
```

Run these commands from the repository root. The binary is
`packages/qaren-cli/target/debug/qaren`; its screen child uses the generated
`packages/qaren-core/dist/`. Set `QAREN_RUNTIME` to its absolute path when running
the binary from another location. See [Check a plan](#check-a-plan) for when
`TYPESAFE_API_KEY` is required.

## Check a plan

From the app's directory, supply `.qaren/config.yaml` and a Markdown plan:

```sh
qaren check --plan-file plan.md --device <simulator-UUID> --json
```

The configuration keys, defaults and validation are owned by
[`src/config.rs`](src/config.rs). iOS requires `appId` and `devClientScheme`;
only `pnpm` is supported as the app package manager. `--config` selects another
configuration file. `check` currently supports iOS simulators only;
`--platform android` refuses with `PLATFORM_UNSUPPORTED`.

Plans contain a `## QA` section, named `###` blocks, numbered actions and
`✓` checks. See the executable
[literal](../qaren-core/test/fixtures/plans/literal.md) and
[phrase](../qaren-core/test/fixtures/plans/phrases.md) fixtures and the
[parser](../qaren-core/src/qa/plan.ts) for accepted grammar. Quoted press and fill
targets resolve observed labels or test IDs locally; multiple eligible matches
refuse with `TARGET_AMBIGUOUS`, without a Jev tie-break, even if the target adds
positional words such as `Tap "Save" at the bottom`.

A check is literal only when its entire payload is one quoted string:
`✓ "Welcome"`. Text outside the quotes, as in
`✓ The heading shows "Welcome" and no error is visible`, makes the whole
expectation a phrase check. Phrase press, fill and wait targets, phrase
scroll-until targets, phrase checks and unrecognised verbs require
`TYPESAFE_API_KEY`. They run the fixed Jev readiness probe even when another
line is unparseable; a missing or rejected key refuses `JEV_UNREACHABLE` before
device selection or leasing. Plans with only quoted targets and literal checks
make no Jev calls and need no key; recognised back, dialog and fixed-scroll
steps also stay model-free.

Unparseable lines refuse before allocation; unresolved screen targets refuse during the walk.
Native platform presence establishes observed presence, not complete visual exposure
or an accessibility heading role. Heading predicates require qualified heading evidence;
unsupported visual or layout claims remain uncertain.
Phrase waits capture fresh screen and presence evidence on every poll, even when the
screen appears unchanged; prior observations do not establish current presence.

Phrase presses require complete native and React coverage and proven React-to-native
associations. Native text, images and plain views are excluded from press candidates
only when complete React host evidence accounts for every interactive host and no
associated React evidence suggests that node is interactive. A React role alone
does not grant press capability; a proven host press handler or native button,
switch or link does. Unknown capability or missing positive platform presence
refuses with `SCREEN_EVIDENCE_INCOMPLETE` rather than guessing a target.
The [screen projection](../qaren-core/src/qa/screen.ts) owns this policy.

Private input capture is required before walking a screen. If it cannot be
established safely, the walk refuses with `PRIVATE_INPUT_CAPTURE_UNKNOWN` without
reinjection or a public-tree fallback. Observed input values are masked before
Jev requests; private values are also masked in reporting. Once sensitive input
pixels are observed, screenshots are withheld for the rest of the walk.
Masks preserve identity for comparisons and do not prove unobserved value content.

```text
plan preflight -> device selection -> lease + durable run record
               -> app preparation -> screen proof -> walk -> teardown
```

By default `check` borrows the only booted simulator, or the booted target
selected by `--device`. `--boot-device --device <simulator-UUID>` opts into
booting that exact iOS simulator under the lease. `--fresh-install` opts into
removing the selected app and its data, proving absence, then installing it
under the same lease. Both opt-ins require strict admission before mutation.
Cleanup leaves the borrowed simulator running and keeps the installed app.
iOS preparation proves app-local Expo generic-build support, or uses an
explicitly configured Xcode workspace (see
[CLI-owned iOS build routes](#cli-owned-ios-build-routes)), builds a finite
simulator bundle, and starts the app on the selected simulator with a separate
Metro process group. If finite-build cleanup is unknown, the build lock and
device lease remain claimed for `qaren cleanup`. The developer
[check gate](../../scripts/gate-qaren-check.sh) forwards the boot opt-in with
`QAREN_BOOT_DEVICE=1` alongside `QAREN_DEVICE_UDID`.

iOS artifact verification requires an Expo Dev Launcher image supporting
`--initialUrl` and refuses bundles containing `main.jsbundle`. Symbol and string
probes filter output before capture, allowing large debug images without raising
the 16 MiB capture limit; failed probes or missing required evidence still refuse.
The verification contract is owned by [`src/adapters/ios.rs`](src/adapters/ios.rs).

### iOS admission and cleanup

Strict admission observes known automation patterns for the selected simulator.
A driver targeting it is busy; a driver can coexist only when kernel executable
identity and exact arguments prove that it targets other simulators exclusively.
An unscoped Maestro MCP controller can coexist when its Java executable and
exact MCP arguments are attested; its command-line spelling alone is insufficient.
Unknown identity, scope, process-table completeness or inspection outcome refuses.
The scan cannot exclude uncooperative automation inside an otherwise admitted
process and is not an external coordination lease.

Drivers and unresolved process identities share one candidate budget and one
scan deadline. Oversized arguments require bounded kernel path inspection that
returns an outcome without exporting argument content. Budget exhaustion refuses
instead of admitting a partial scan. The limits and classification rules are
owned by the [strict scanner](../qaren-core/src/runners/external-runner-detect.ts)
and [kernel observer](src/process_observation.rs).

Runs and evidence live under `~/.qaren/runs/<run-id>/`; device leases use
`QAREN_LOCK_ROOT` or `~/.qaren/locks`. The walk writes `ledger.json` and
`report.md` when it reaches reporting; the receipt names available artifacts.
Cleanup proves owned process-group and exact-simulator runner-host absence
before releasing the lease. Present or unknown hosts retain it. A dead lease
holder is reclaimed only through that run's cleanup; a live or unprovable holder
refuses `DEVICE_BUSY`. Recover a retained run with `qaren cleanup <run-id>`;
do not delete locks to bypass unresolved ownership.

### Walk timing

`ledger.json` adds a `timing` object to each walked attempt row, in milliseconds.
`captureMs`, `resolveMs` (decision), `actMs`, `postCaptureMs` and `otherMs`
partition `total`, the elapsed window between consecutive row timestamps
(starting at the walk for the first row). `nativeMs`, `reactMs` and optional
`presenceMs` detail reads within capture; `jevMs` details judgment time within
decision, including HTTP retries and their backoff. These breakdowns overlap
the partition and must not be added to `total`. Post-action captures start
after an authorized dispatch; captures after a dispatch refused before
authorization remain in `captureMs`.

The ledger's `speed` summary groups timed action/check rows by plan line and
kind, summing every retry, passing and failing attempt into one logical-step
duration, even when a capture refusal changes the block name. `stepMedianMs`
and nearest-rank `stepP95Ms` cover all those logical steps; `steps`, `passed`
and `failed` count them, with the last attempt determining whether a step
passed. `walkMs` sums all timed row windows, not app preparation or teardown.
`report.md` prints these summary values under Run details; inspect the ledger
for individual timing breakdowns.

Without timed rows, `speed` is omitted. With timed rows but no timed actions
or checks, counts are zero and percentiles are omitted (shown as `n/a` in the
report). An interrupted child without a final result retains row evidence
but omits `speed`. Timing is passive: it does not alter verdicts, actions or
budgets, and the CLI drops malformed timing rather than rejecting the ledger.
The [row timing implementation](../qaren-core/src/qa/row-timing.ts) owns
aggregation; [CLI decoding](src/core.rs) and [report rendering](src/report.rs)
own consumption.

## Preparation verbs

These scenario-based verbs retain the preparation receipt contract below;
`check` adds `pass` / `fail` results (exit 0 / 1), with typed refusals exiting 4.

### Usage

```sh
qaren prepare <scenario.yaml> [--json] [--dry-run]
qaren prewarm <scenario.yaml> [--json]
qaren status  <run-id> [--json]
qaren complete <run-id> <build-log> [--json]   # cooperative handoff only
qaren cleanup <run-id> [--json]
qaren cleanup <run-id> [--json] --remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id>
```

Every syntactically valid preparation invocation writes exactly one `qaren/1` JSON
receipt to stdout; argument/usage errors are the sole exception — they exit
`2` with help on stderr and an empty stdout. All human-readable narration
goes to stderr. Exit codes: `0` ready / cleaned / planned / working /
prewarmed, `1` failed, `2` usage, `3` unknown, `4` refused (contended
device or build lock, missing prewarm authorization, unprovable ownership,
unconfirmed app removal, or rejected cooperative-handoff evidence).

`--remove-app` and `--confirm-remove-app` must be supplied together and only
on `cleanup`; a missing flag or confirmation value, or use on another verb,
is a usage error (exit `2`, no receipt).

`status`, `cleanup` and `complete` load the host-level run record described
under [iOS admission and cleanup](#ios-admission-and-cleanup). `--dry-run` on `prepare`
validates the scenario + candidate and emits the planned command sequence
(listener/readiness poll probes elided) without allocating anything.

```
prepare ──► validate (scenario schema, candidate git sha, lockfile sha256)
        ──► prereqs  (tools present, metro port free)
        ──► plan     native fingerprint + cache state ──► reuse | incremental | clean
                     (decision + evidence recorded; non-reuse takes the
                      host-level build serialization lock)
        ──► allocate  iOS:  simctl create qaren-<run-id> + bootstatus -b
                      NUC:  ssh <host> ~/bin/android-farm start <slot> qaren-<run-id>
                            ssh -N -L 127.0.0.1:<p>:127.0.0.1:<p>  (owned pid)
                            run-scoped adb server on adb_server_port with the
                            farm host's vendor key (fetched over ssh, 0600,
                            deleted at cleanup); adb connect 127.0.0.1:<p>
                            through it — never the Mac's global adb server
                      USB:  exclusive claim lock usb-<serial> (refuse if held)
                            run-scoped --one-device <serial> adb server on
                            adb_server_port; device must probe `device`
        ──► build+launch   iOS: finite generic Expo or explicit Xcode workspace build
                             → verify simulator bundle → install on owned UDID
                             → separate owned Metro → launch verified bundle
                          Android: pnpm exec expo run:android --port <port>
                             (serial pinned via ANDROID_SERIAL + the
                             one-device server; CI=1)
        ──► verify   port owner pgid == spawned pgid, /status responds,
                     app installed + running on the owned device
        ──► ready    receipt + durable host-level run.json

(With `build.owner: qaren` the chain branches after `allocate`: no
build+launch — prepare re-verifies the candidate, issues `handoff.json`, and
finishes at phase `handed_off`; see the cooperative handoff section below.)
```

## Scenarios

Scenarios are versioned (`schema: qaren/1`), narrow, and strictly validated
(unknown fields rejected). Five checked-in examples:

- [`scenarios/ios-simulator.yaml`](scenarios/ios-simulator.yaml) — Mac iOS
  simulator (device type + runtime pinned, Metro on 8791).
- [`scenarios/nuc-android.yaml`](scenarios/nuc-android.yaml) — NUC Android
  emulator slot 1 via the `~/bin/android-farm` lease contract (Metro on 8792).
- [`scenarios/usb-android.yaml`](scenarios/usb-android.yaml) — a physical
  USB Android phone by explicit serial (Metro on 8794).
- [`scenarios/cooperative-ios.yaml`](scenarios/cooperative-ios.yaml) /
  [`scenarios/cooperative-usb-android.yaml`](scenarios/cooperative-usb-android.yaml)
  — `build.owner: qaren` handoff mode (see below).

### CLI-owned iOS build routes

The default route requires the app-local Expo CLI to advertise generic build-only mode, `--no-bundler` and `--output`. For older Expo CLIs, explicitly select an existing native workspace and its Xcode scheme in the app's `.qaren/config.yaml` (or an external `check --config` file):

```yaml
appId: com.example.app
devClientScheme: exp+example
ios:
  build:
    workspace: ios/Example.xcworkspace
    scheme: Example
```

For `prepare`, the same pair belongs under `build.ios_workspace` in the scenario, alongside `build.owner: cli`. Workspace paths are relative to the app root, remain under `ios/`, and must resolve through plain directories to an existing `.xcworkspace` with a plain `contents.xcworkspacedata` file. No scheme discovery, Expo upgrade or automatic fallback after a failed build occurs. An iOS section in shared `check` config does not select this route for Android.

This route runs `xcrun xcodebuild` in Debug against the generic iOS Simulator destination, with signing and the React Native packager launch disabled. Products and DerivedData are isolated under the run directory. The existing finite-build process group and lock remain authoritative; only a clean exit with proven group shutdown can proceed to single-bundle verification, exact-device installation, separate Metro and launch. A missing or ambiguous app, wrong bundle/platform/scheme or unsupported dev-client launcher still fails before installation. Workspace and scheme selection participate in the native cache fingerprint; omitting the opt-in preserves existing Expo cache keys.

**Native preparation remains explicit.** Supply a workspace whose native dependencies and generated inputs are ready for Xcode. QaReN retains its existing clean/incremental policy: an unproven generated native directory is regenerated through owned `expo prebuild --clean`, then the workspace is revalidated before compilation; a git-visible native tree is not regenerated. The workspace route adds no CocoaPods synchronization or codegen command of its own, and workspace existence is not proof that those inputs are current after a dependency update. A build failure is reported, not retried through another backend.

After verified cache publication and proven build-group shutdown, successful workspace builds retire their run-local products and DerivedData. Failed builds, failed publication or unresolved cleanup retain outputs; symlinked retirement roots are not followed. Unknown build-group cleanup continues to retain the build lock and device lease for `qaren cleanup`.

### Cooperative handoff mode (`build.owner: qaren`)

With `build.owner: qaren` (workspace issue #34), `prepare` stops after
allocation: validate → deps → native fingerprint → allocate (run-scoped
simulator, or exclusive USB claim lock with **no adb server and no device
contact**) → re-verify the candidate → issue a typed
`handoff.json` (`qaren-handoff/1`) and finish at phase `handed_off` with
result `ready` — **meaning allocated and handed off; nothing is built,
installed, or launched by qaren**. The qaren session then performs the
one authoritative managed build/install against the exact allocated device,
and `qaren complete <run-id> <build-log>` binds the session's signed build
receipt to the run identity, refusing missing, stale, ambiguous, mismatched,
foreign, replayed, or late evidence (exit 4). In handoff mode,
`deadlines.build_seconds` is one wall-clock validity window starting at the
typed handoff's `issued_at`; retries never reset it. Handoff scenarios carry no `metro:`,
no `android_usb.adb_server_port`, and no `dev_client_scheme` — the session
owns those lifecycles — and the farm adapter is refused (the leased emulator
is unreachable from the session's global adb server). Cleanup is unchanged:
qaren removes exactly the allocation it recorded and never touches the
session's Metro or build. The full chain, ownership table, trust boundary,
and temporary policy live in
[`docs/qa/cooperative-qa.md`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/qa/cooperative-qa.md).

### Project-scoped real apps

`candidate.worktree` (optional, absolute path) points qaren at an external
project instead of the workspace containing the scenario. The path must BE a
git toplevel — a subdirectory of some larger repo is refused
(`CANDIDATE_PATH_INVALID`) so a run can never bind to files outside the
project it named. Project caches live under `<worktree>/.qaren/`, and the
fingerprint enumerates only that worktree. Run records remain host-level;
`status`/`cleanup` load them by run id without requiring the app directory.
qaren never discovers, enumerates, or couples other projects.
`candidate.project_root: .` selects a project living at the worktree root.
Because `.qaren/` is qaren's own state, it is excluded from the candidate
cleanliness and drift comparison — an external project does not need to
gitignore it, and a clean worktree stays provably clean while qaren writes
its project caches there.

`candidate.dev_client_scheme` names the app's registered dev-client URL scheme (e.g. `exp+example`), not its Xcode scheme; it is required for CLI-owned iOS builds and cached dev-client reuse. `check` calls this field `devClientScheme`. Bundle verification checks both the registered scheme and the built dev-client launcher before installation.

### Physical USB Android

`android_usb: { serial, adb_server_port }` is a separate, exclusive
allocation path (exactly one of `android:` / `android_usb:` per scenario).
The serial must be a plain physical-device serial — `emulator-*` and
loopback forms are rejected at validation, so the farm path's
structural guarantees never weaken. At allocate time the device is claimed
by an atomic host-level lock (`$QAREN_LOCK_ROOT` or `~/.qaren/locks`,
`usb-<serial>`); any existing claim — even one whose holder is provably
dead — is a structured refusal (`DEVICE_CLAIM_CONTENDED`, exit 4), never an
adoption. All qaren processes competing for a device must share the same
lock root (the per-user default covers the single-operator dev-machine
model). A run-scoped `--one-device <serial>` adb server (host adb key
pinned explicitly) is the only path to the phone; `expo run:android` routes
through it via `ADB_SERVER_SOCKET` + `ANDROID_SERIAL`. An `unauthorized` or
`offline` device is a structured `DEVICE_UNAVAILABLE` failure. Cleanup
releases the claim only after every resource that can still address the
device (reverse mapping, adb server, and the build/Metro process group that
drives adb through that socket and serial) is proven removed or absent.

Every device, Metro port, bundle id, candidate revision, project root, and
artifact directory is explicit — in the scenario, the run record, or the
receipt. The scenario-based preparation verbs never select `booted`, a default device,
or "first available". `candidate.revision: HEAD` records the exact sha; a pinned
40-char sha refuses to run against any other checkout state.

## Native-fingerprint build selection

`prepare` chooses the fastest semantically valid build path and records the
decision — `reuse`, `incremental`, or `clean` — with its reason and evidence
in the run record, the prepare/status receipts (`build` field), and dry-run
plans. Speed never overrides provability: anything unprovable falls back to
a clean build, and a stale or unverifiable binary is never claimed.

**Fingerprint (`rnfp1:<sha256>`).** A sorted manifest of `(path, sha256)`
over the native inputs git considers part of the candidate (tracked plus
untracked-not-ignored — generated CNG `ios/`/`android/` dirs are build
outputs, not inputs): `package.json`, `pnpm-lock.yaml`, `app.json`,
`app.config.*`, `eas.json`, `react-native.config.*`, `plugins/**`,
`assets/**`, `patches/**`, tracked platform dirs (minus build outputs),
files referenced by relative path from a static `app.json` (icons, splash,
service files, local config plugins), the traced transitive relative-import
closure of those local plugins (common static `import`/`require` forms; the
scan is a declared best-effort contract, not a JS parser), and the native
surfaces (`package.json`, `*.podspec`, `expo-module.config.json`, `ios/`,
`android/`) of `file:`/`link:` local dependencies inside the worktree.
Symlinks hash their link text plus in-worktree target content. Anything
that cannot be enumerated or bound — dynamic `app.config.*`, unresolvable
local refs, out-of-worktree symlink targets, `workspace:` deps — marks the
fingerprint **incomplete**, which forbids cached reuse (visible in the
decision evidence). qaren is pnpm-only; other package managers' lockfiles
are out of contract.

**Decision.** Cache state lives at
`<worktree>/.qaren/native-cache/<platform>-<app_id>.json`
(`qaren-native-cache/1`), bound to the exact worktree, platform, app id,
fingerprint, and building candidate sha:

1. **Reuse** — state matches this worktree/platform/app, fingerprints are
   equal and complete, the cached artifact's content hash verifies, its
   kind matches the platform, and `dev_client_scheme` is configured. The
   verified dev client is installed (`simctl install` / `adb install -r
   -d`), Metro is spawned candidate-bound (`expo start --port`), and the
   dev client is deep-linked onto it (package-constrained `am start` on
   Android). Fresh candidate JS always comes from Metro; the evidence
   records which candidate built the binary and which serves JS — native
   compatibility is proven by the fingerprint, never inferred from the sha.
2. **Incremental** — reuse is invalid (fingerprint changed, artifact
   stale/missing/unverified, no scheme, incomplete fingerprint) but the
   worktree-keyed caches are provably this project's: the state binds this
   exact worktree/app and any generated native dir was created by a
   recorded qaren build. `expo run:*` recompiles over the existing
   `ios/`+Pods+`ios/build` / gradle caches.
3. **Clean** — mandatory whenever compatibility is unprovable: no/corrupt
   state, cross-worktree state, unproven generated-dir provenance, or
   `build.strategy: clean`. A generated (git-ignored) native dir is
   regenerated via `expo prebuild --clean` (expo's own CNG contract); a
   git-visible native dir is candidate input and is never deleted — clean
   there means dropping the derived build outputs (`ios/build`,
   `android/build`, `android/app/build`, `android/.gradle`).

After a successful build the dev client (single `.app` bundle / debug apk)
is content-hashed and copied under
`.qaren/native-cache/artifacts/<platform>/`, and the state is refreshed
with the readiness-rechecked fingerprint (native-input drift during the
build fails the run as `CANDIDATE_DRIFTED`). An ambiguous artifact (zero or
several bundles) skips caching with a recorded reason — never a guess. The
artifact cache is bounded: recording a new build prunes the same
platform+app's directories for older fingerprints, so only the latest
reusable dev client is kept on disk.

**Build serialization.** Native builds (incremental and clean) take a
host-level `native-build-<platform>` lock before allocation. A live holder
is a structured refusal (`BUILD_CONTENDED`, exit 4). Android can adopt a
provably dead holder's lock. iOS refuses an existing lock until its run's
cleanup proves the finite build group retired; a dead CLI alone is insufficient.
The lock is released after preparation or by cleanup only when owned build
authority is retired.

**Credential-authorized dependency prewarming.** Under `deps.policy:
require-prewarm`, `qaren prewarm <scenario>` is the one deliberate network
moment (the default `install` policy keeps today's behavior: prepare's own
`pnpm install` may reach the network): run it while registry credentials
are available; it runs `pnpm fetch` + `pnpm install
--frozen-lockfile` (CI, stdin-null) and persists only
`{worktree, project, lockfile sha256, timestamp}`; failure summaries follow the
[diagnostic redaction contract](#preparation-ownership-and-safety-rules).
A scenario with `deps.policy: require-prewarm` then refuses to prepare without a matching record
(`DEPS_NOT_PREWARMED`) and installs with `--offline`, so no mid-run
credential prompt can ever occur.

**Prepared simulator lanes (evaluated, deferred).** Keeping a booted,
pre-warmed simulator between runs would save the ~36s create+boot phase.
The evaluation: a maintained lane needs an owner (who deletes it when its
runtime/device-type pins change), a freshness rule (recreate on runtime
update or after N days), and an ownership marker distinguishing it from
user simulators — all solvable with the existing run-scoped-name machinery.
It is deferred because native compile dominates whenever it is not already
cached (the 2026-08-17 clean run spent 5m 42s building vs 5m 25s
allocating) and a persistent simulator weakens the "no resource outlives
its run" cleanup story. Once compile is short the balance flips — the
incremental run spent 1m 31s in allocate against 1m 03s in
build_and_ready — so revisit this once live reuse is measurable.

## Preparation ownership and safety rules

- **On the farm path, physical USB phones are structurally unreachable.**
  Every device-addressing adb call carries `-s 127.0.0.1:<port>` (plus
  `ANDROID_SERIAL` on the expo build), and every adb call — including the
  expo build's own — routes through the run-scoped adb server via
  `ADB_SERVER_SOCKET`; the Mac's global adb server is never used. Serials are
  validated against the loopback-tunnel form before any adb call; farm output
  naming a non `emulator-*` serial is rejected at parse time. A physical
  phone is reachable only through the separate `android_usb` adapter, which
  requires its exact serial in the scenario, an exclusive uncontended claim
  lock, and its own run-scoped `--one-device` server — the two adapters
  never blend (a scenario naming both is invalid).
  `adb connect`/`disconnect` name their endpoint positionally — `-s` is not
  applicable to them. The emulator guest only trusts the farm host's adb key,
  so the private server authenticates with that key (`ADB_VENDOR_KEYS`),
  fetched once over ssh into the run directory and deleted at cleanup.
- **Private key fetch output is withheld from diagnostics.** The farm key
  fetch uses private capture: failure details in `run.json` and the receipt
  report only exit status and timeout state with `[private output withheld]`,
  and neither captured stream is written to durable logs. Only a successful,
  nonempty fetch writes the cleanup-tracked, mode-0600 vendor key file.
  Parser input stays raw in memory. Persisted operational identities
  (paths, ids, pids, ports and lock directories) are written exactly;
  output-derived record fields use `OutputText`, masked on construction and
  load. Command summaries inspect both streams, and ledger and receipt
  evidence strings keep whole-string withholding when they contain
  `private key` (case-insensitive), using
  `[output withheld: contained private key material]`. Command logs keep
  per-byte whole-command withholding: a mention truncates that command's
  output and drops subsequent bytes. API-key redaction still applies to
  retained diagnostics and logs. Key bodies with no private-key mention,
  or copied before the mention arrives, cannot be withheld by this rule.
- **Local listeners are never adopted.** The farm-advertised adb port is
  preflighted free on this host *before* the lease is claimed (a local
  emulator commonly owns 5555), and a listener on the tunnel or private adb
  server port only counts once its pgid equals the group qaren just spawned —
  a foreign listener is a structured failure before any `adb connect`, so a
  `ready` receipt can never name a NUC lease while a local emulator answers.
- **Cleanup is ownership-gated.** A simulator is deleted only when UDID *and*
  run-scoped name (`qaren-<run-id>`) both match (a pending allocation whose
  create crashed before the UDID was learned is recovered by its unique
  run-scoped name, refusing on ambiguity). A process group is signalled only
  when the recorded leader's birth time (`ps lstart`) still matches, or the
  recorded port (Metro, tunnel, or private adb server) is owned by a pid whose
  pgid equals the recorded group (the leader-died-children-live case); a group
  recorded without identity is `unresolved`, never guessed absent, and after a
  kill the port must be positively free or foreign before `removed` is
  claimed. The farm slot is stopped only when the live lease holder equals
  this run's holder *and* the forward is proven gone — either the tunnel
  resource cleaned, or its recorded local port probing positively free.
  A foreign, shared, or indeterminate port retains the lease so the
  forwarded port cannot expose the next lease. A `cleaned`
  verdict that cannot be persisted downgrades to `failed` with a retry.
  Anything unprovable is a structured refusal (`OWNERSHIP_UNPROVEN`, exit 4)
  — never a guess.
- **App removal is opt-in, confirmed, and bound to the run record.** Plain
  Android `cleanup` never touches the installed app: stopping the farm AVD
  keeps its userdata, so the dev client this run installed survives the lease (and a
  `cleaned` receipt says nothing about it). `--remove-app` adds one
  `app_install` leg, executed before Android resource teardown while the
  lease, tunnel and private adb server are still alive, and only on the
  leased Android emulator route
  (USB, iOS and records without a farm lease are refused before any cleanup
  command runs; CLI git-root discovery precedes record loading). It requires
  `--confirm-remove-app <run-id>/<remote-serial>/<app-id>`
  naming exactly the loaded record's run id, recorded `emulator-*` serial
  and candidate app id — a mismatch is `APP_REMOVAL_NOT_CONFIRMED` (exit 4)
  with nothing touched, so a typo costs a re-run, not the lease. The
  removal deletes the app *and its data* (`adb uninstall`, no `-k`) through
  the run's own `-s <loopback serial>` + `ADB_SERVER_SOCKET` path; the
  target is never a supplied serial, app id or ambient `adb devices`.
  Immediately before the uninstall the leg re-proves, in order: durable
  install provenance in `run.json` (`resources.app_install`, written by
  `prepare` after a `Success` cached `adb install` or a ready build through
  the run's server when the built APK was hashed, bound to the run's app id,
  serial, server port and APK artifact sha256 — legacy records without it
  are refused), the recorded serial matching the farm port's tunnel endpoint,
  the live farm tuple (holder, AVD, serial, adb port, `state=device`), tunnel
  and adb server birth identities, `get-state` = `device`, a successful `pm path`
  read with empty stderr and exactly one user `/data/app/**/base.apk` result
  (split/multiple APKs, system paths, traversal and shell metacharacters are
  refused), and `sha256sum` of that base.apk equal to the recorded artifact
  hash — a matching hash alone is not ownership,
  the successful-install binding is required too. Any miss refuses or leaves
  the leg `unresolved` with **no uninstall issued**. After the uninstall,
  absence is proven on the same live connection by two reads: `pm path`
  completing with an exit code, no `package:` line and empty stderr
  (silent exit `1` is accepted for an unknown package), and `pm list
  packages <app-id>` exiting `0` with empty stderr and without the exact
  `package:<app-id>` line; substring siblings such as `<app-id>.dev` do not
  count. A timeout, failed read or any stderr from either probe leaves
  absence unknown. `removed` requires both uninstall `Success` and proven
  absence; a still-present package or unproven absence is `unresolved`.
  If both probes prove absence before uninstall, the leg is `absent` and
  records uninstall as `not issued`.
  The attempt (timestamp, observed installed sha256, complete captured
  exit/stdout/stderr and timeout evidence for uninstall / `pm path` /
  package list) is persisted to `run.json` at `resources.app_install.removal`
  before any lease release; a save failure makes the leg `unresolved` and
  retains the farm lease while independent owned local cleanup continues.
  The receipt echoes it in `outcomes.app_removal_*`, with the observed hash
  in `outcomes.app_installed_sha256`. The leg folds into the existing verdict:
  a refused or unresolved removal keeps the receipt off `cleaned` and the
  phase off `cleaned` while the other
  resources still clean up in their normal order (reverse mapping,
  connection, server, key, tunnel-before-lease). A repeat after a proven
  removal reports `absent` from the record without re-addressing a device
  that may belong to another lease. A persisted unresolved attempt refuses
  another removal even if the lease is still owned; its evidence is retained
  without new package probes or upgrading historical unknown. Refusals before
  the removal boundary never overwrite a persisted attempt. Installing with
  `adb install -r` over an existing package does not prove fresh app data.
- **Claims are durable before they exist.** The run directory is claimed with
  an exclusive `mkdir`, so two same-second `prepare`s can never share a run id
  (`RUN_ALREADY_EXISTS`), and every external allocation is persisted to
  `run.json` *before* the command that creates it runs — the farm lease before
  `android-farm start`, the simulator (run-scoped name, empty udid) before
  `simctl create`. A crash mid-allocation leaves the claim discoverable by
  `cleanup` instead of orphaned.
- **`status` never repairs and never lies.** It derives ready / working /
  failed / cleaned / unknown from the durable `run.json` plus bounded live
  probes, and gates dependent probes on proven ownership (a foreign-named
  simulator or dead tunnel makes dependent probes `inconclusive`, not a
  false `fail`). The farm lease probe requires the full recorded slot
  identity — holder, AVD, serial, adb port, and a ready state — before any
  device probe runs, and a `failed` run's receipt carries the originally
  recorded `next_action` instead of a blanket cleanup hint.
- **All waits are bounded** (scenario `deadlines`, validated to 30..=7200s).
  In-process waits use a monotonic clock and timed-out commands are killed by
  process group. The cross-process cooperative handoff uses its persisted
  UTC `issued_at` plus `build_seconds` as one wall-clock validity window;
  retries never reset it, and an unprovable backwards clock refuses.
- **Provenance is rechecked at readiness.** The candidate sha, worktree
  cleanliness, the worktree fingerprint (sha256 of `git status --porcelain`
  with entries under qaren's own `.qaren/` state directory excluded),
  and lockfile hash are re-verified immediately before `ready`;
  drift during the build fails the run (`CANDIDATE_DRIFTED`) instead of
  emitting a receipt that misattributes the built app.
- `cleanup` is idempotent: a second run re-probes, finds everything absent,
  and returns `cleaned` again without signalling anything after successful
  cleanup; app-removal retries follow the persisted-evidence rules above.

## What a worker does

```sh
packages/qaren-cli/target/debug/qaren prepare packages/qaren-cli/scenarios/ios-simulator.yaml --json
# → parse .result == "ready", read .metro.endpoint + .device, attach agents
packages/qaren-cli/target/debug/qaren status  <run-id> --json   # truthful current state
packages/qaren-cli/target/debug/qaren cleanup <run-id> --json   # ownership-safe teardown
# opt-in: also remove the app this run installed (and its data) from the leased emulator
packages/qaren-cli/target/debug/qaren cleanup <run-id> --json --remove-app \
  --confirm-remove-app <run-id>/<remote-serial>/<app-id>   # e.g. <run-id>/emulator-5554/com.rndevagent.testapp
```

On failure the receipt carries a bounded `failure.code`, log-tail evidence,
and exactly one safe `next_action` — no invented setup steps.

## Measured results (2026-08-12, M-series Mac + NUC11TNKi5 over Tailscale)

Both real happy paths first ran end-to-end on an earlier revision (see the
re-proof below for the pinned proof head), from a cold worktree (no
`node_modules`, no `ios/`/`android/` dirs, no prior simulator or lease). The
worker typed exactly one command per phase.

| journey | verb | wall clock | subprocesses | outcome |
| --- | --- | --- | --- | --- |
| iOS sim (Mac) | prepare | 5m 13s | 129 | `ready` (validate 0.8s, deps 8s, sim create+boot 36s, build+launch+verify 268s) |
| | status | 1.4s | 7 | `ready`, 5/5 probes pass |
| | cleanup | 6.0s | 11 | `cleaned` (metro + simulator removed) |
| | cleanup again | 0.4s | 4 | `cleaned` (all absent; nothing signalled) |
| Android (NUC slot 1) | prepare | 2m 34s | 111 | `ready` (allocate incl. emulator boot 35s, build+launch+verify 118s) |
| | status | 1.0s | 12 | `ready`, 8/8 probes pass |
| | cleanup | 9.6s | 27 | `cleaned` (connection, server, vendor key, metro, tunnel, lease removed) |
| | cleanup again | 0.7s | 5 | `cleaned` (all absent) |

Independent post-cleanup verification: Metro/adb-server/tunnel ports free,
zero `qaren-*` simulators, a foreign booted simulator untouched, both farm
slots `lease=free state=down`.

After the tunnel-port ownership corrections (adb-port preflight, listener
pgid gating, port-proven tunnel cleanup, vendor key tracked as its own
resource), both journeys were re-proven end-to-end on the same hosts with
warm caches: iOS (local Mac) prepare 1m 57s / 72 subprocesses → `ready`,
status 5/5, cleanup `cleaned`, idempotent re-cleanup `cleaned`; NUC Android
prepare 37s / 48 subprocesses → `ready`, status 8/8, cleanup removed all six
resources, idempotent re-cleanup `cleaned`. The same independent
post-cleanup verification passed again. Receipts, device screenshots, and
the rendered proof card live in
[`docs/proof/2026-08-12-qaren-exact-head/`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/proof/2026-08-12-qaren-exact-head/PROOF.md);
every receipt there is pinned to the head that produced it (`f3e1e43`), which
predates the later corrections documented above — lease release keyed on the
tunnel port, worktree-fingerprint drift, monotonic deadlines, the atomic
run-id claim, and persist-before-allocate.

### Build-selection timing evidence (2026-08-17, local Mac)

Clean and incremental iOS simulator journeys were measured at candidate
`75a8e76` (`git_dirty: false`) once the internal Data volume recovered to
~26 GiB free. Receipts, screenshots, and short videos:
[`docs/proof/2026-08-17-qaren-issue-24/`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/proof/2026-08-17-qaren-issue-24/PROOF.md).

| journey | prepare total | deps | allocate | build_and_ready | decision |
| --- | --- | --- | --- | --- | --- |
| clean (`build.strategy: clean`) | 11m 27s | 19s | 5m 25s | 5m 42s | `clean` |
| incremental (warm ios/ + DerivedData, no verified cached `.app`) | 2m 35s | 0.3s | 1m 31s | 1m 03s | `incremental` |

Both prepares reached `ready` with 5/5 status probes; cleanup removed
Metro + the run-scoped simulator and was idempotent. The USB phone was
not used. An unedited placeholder serial is a validate-time
`SCENARIO_INVALID` (0 commands, no device contact). Scenario bytes used
for the iOS timings are archived next to the receipts so the pinned
`packages/qaren-cli/scenarios/ios-simulator.yaml` file was not mutated.

Fingerprint-matched **reuse** did not run: Expo SDK 56 `expo run:ios`
does not pass `-derivedDataPath`, so the `.app` lands in
`~/Library/Developer/Xcode/DerivedData/…/Debug-iphonesimulator/` while
`locate_built_artifact` looks at `ios/build/Build/Products/Debug-iphonesimulator`.
Each ready receipt records `artifact_cache` skipped for that missing
path; a post-cleanup auto `--dry-run` at the same SHA still planned
`incremental`. Hermetic tests still cover reuse including
stale/missing/mismatched artifacts. Do not treat an emulator or a
planted binary as a substitute.

`/Volumes/DNA` (~1.8 TiB free) was authorized for task-scoped
DerivedData but was not writable from the worker (`Operation not
permitted`); the timings above used the default Xcode location on the
internal volume after space recovered. Simulator device data still
cannot be redirected without mutating the shared CoreSimulator store.

### Build-selection timing evidence (2026-08-13) — recorded proof gap

Representative before/after timings for the reuse / incremental / clean
paths could not be produced on the exact candidate that day: the host ran
out of disk during the attempts (an iOS clean journey needs ~8-10 GiB for
pods, DerivedData, and a booted simulator; ~5-8 GiB were available). Two
real attempts on the dedicated simulator lane produced the intended
*failure* evidence instead, each a bounded structured receipt with the
decision recorded and ownership-safe recovery:

| attempt | decision recorded | outcome |
| --- | --- | --- |
| clean #1 | `clean` (no cache state; `ios/` regenerated via prebuild) | `BUILD_FAILED` at `pod install` with ENOSPC log-tail evidence after validate 0.8s / deps 0.6s / plan 0.08s / allocate 119s |
| clean #2 | `clean` | `SIMULATOR_BOOT_FAILED` (bootstatus timed out under disk pressure) after validate 0.8s / deps 0.3s / plan 0.09s |

Both runs were then cleaned with `qaren cleanup`: simulator and build
serialization lock removed, Metro port verified free, zero `qaren-*`
simulators left, and a second cleanup returned `cleaned` idempotently —
partial-failure recovery held on real hardware (abrupt-interruption
recovery is covered by the hermetic cleanup tests, not by these runs). The `plan`
timing (fingerprint + decision) is ~85ms and the decision/evidence
appeared in every receipt. Clean and incremental timings at a later head
are in the 2026-08-17 section above; live reuse remains blocked on the
Expo 56 DerivedData path mismatch recorded there.

Real failure categories observed while iterating (each a bounded structured
receipt, never a hang or a half-configured host):

- `ADB_CONNECT_FAILED` — emulator adbd refused the Mac's adb key (led to the
  vendor-key private-server design).
- `FARM_UNREACHABLE` — transient Tailscale MagicDNS resolution blip (22s,
  retry succeeded).
- `TUNNEL_FAILED` — adb server `-L` rejects explicit hostnames (fixed).
- `FARM_SLOT_LEASED` — the lease gate refused a slot held by a concurrent
  run's holder in 1.6s (exactly the protection it exists for).
- `BUILD_FAILED` — expo matches `--device` by name, not serial (led to the
  `--one-device` server design); a separate zombie-liveness bug (dead build
  child of a live prepare read as alive) was found by this failure and fixed
  with a `ps stat=` probe.

The verdict on the experiment question — *does one reproducible contract
reduce setup rediscovery?* — is yes on both journeys: after `ready`, an agent
receives the exact device identity, Metro endpoint, and candidate provenance
without ever choosing a device, picking a port, or knowing that pnpm, expo,
adb vendor keys, ssh tunnels, or farm leases exist. All platform knowledge
that previously had to be rediscovered per session (this session alone spent
five Android iterations discovering adb auth/scan/expo-matching behavior) is
now encoded once and replayed deterministically.

## Limitations (recorded, not papered over)

- **Farm stop is check-then-stop, not compare-and-stop.** The
  `~/bin/android-farm` contract takes only a slot for `stop`. qaren verifies
  the lease holder immediately before stopping; the race window is closed in
  practice because `android-farm start` refuses while any lease file exists,
  so no legitimate actor can re-lease between the check and the stop. A
  compare-and-stop verb would need a farm-side change, out of scope here.
- **PID identity is birth time (`ps lstart`), not command line.** pnpm shims
  exec-transition (`sh` → `node`) after capture, so command-line comparison
  would misclassify our own Metro as foreign and strand resources. Same-second
  pid reuse on macOS is the accepted residual risk.
- **ANDROID_HOME is an environment prerequisite.** The resolved adb path is
  validated at prepare time and recorded in the run record; status/cleanup
  reuse the recorded path, never the ambient env.
- **`status` trusts a `cleaned` phase** without re-probing; cleanup only sets
  it after every resource verified removed/absent, and re-running cleanup
  re-verifies.
- **App removal limitations:** see the opt-in contract under
  [Ownership and safety rules](#preparation-ownership-and-safety-rules).
- **Crash-durability**: `run.json` writes are atomic (temp + rename) but not
  fsync'd; power loss during a write can lose the newest phase transition.
  Acceptable for a dev-machine tool.
- Android preparation uses `expo run:android`: its spawned process owns
  Metro and stays alive after `ready`. iOS uses the finite-build contract under
  [Check a plan](#check-a-plan).
- app_id validation is one shared grammar (dot-separated `[A-Za-z0-9_-]`
  segments), not per-platform store rules; invalid-but-well-formed ids fail
  later as visible `BUILD_FAILED`.
- The historical Expo SDK 56 artifact-discovery gap in the timing evidence
  predates the current finite iOS build path. Those measurements do not validate
  this implementation; exact-head device acceptance remains separate.

## Comparing against the manual approach

The baseline is what agents do today before any live test: discover a
simulator/emulator, pick a Metro port, remember `pnpm install`, build with the
right flags, wait an unknown time, and verify readiness ad hoc — typically
8-15 exploratory tool calls with high variance, rediscovered every session
(see `docs/proof/pr680-android-lane/` for how much setup archaeology a single
Android lane took). To reproduce the comparison:

1. Time a fresh manual setup of the same scenario (count every command).
2. Run `qaren prepare … --json` on a clean host and read `timings_ms` +
   `commands_executed` from the receipt.
3. Compare failure handling: force a failure (occupy the Metro port, lease the
   farm slot) and compare "structured receipt with one next_action" against
   manual diagnosis time.
