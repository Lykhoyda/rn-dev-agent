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

Run these commands from the repository root with Node satisfying the
[core package's engines requirement](../qaren-core/package.json) and Rust/Cargo
available. The binary is
`packages/qaren-cli/target/debug/qaren`; its screen child uses the generated
`packages/qaren-core/dist/`. Set `QAREN_RUNTIME` to its absolute path when running
the binary from another location. See [Check a plan](#check-a-plan) for when
`TYPESAFE_API_KEY` is required.

### Plugin runtime installation

The plugin's [runtime installer](../qaren-plugin/scripts/ensure-qaren.sh)
supports Apple silicon Macs with Node 24 or newer on PATH. Once the matching
release asset is available, run it from the installed plugin directory:

```sh
bash scripts/ensure-qaren.sh --install
bash scripts/ensure-qaren.sh --print-bin
```

`--install` verifies the tarball's SHA-256 and byte length against the plugin's
[`runner-manifest.json`](../qaren-plugin/runner-manifest.json) before installing
under `~/.qaren/runtime/<version>/`. `--install --from-file <tarball>` uses a
local asset with the same verification. Re-run `--install` to recover an
interrupted installation. The installed binary discovers its adjacent runtime;
it does not require the source checkout's `dist/` or `QAREN_RUNTIME` override.

The SessionStart hook only runs `--print-bin`; it never downloads. That mode
always exits 0 and prints either the verified binary path, an install or repair
instruction, or nothing, so its exit status alone does not prove installation.
Use the reported binary path for CLI commands; installation does not add it to PATH.
This development checkout's manifest does not imply that a QaReN release asset
has been published; use the source build above while that asset is unavailable.

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
positional words such as `Tap "Save" at the bottom`. A text element that is the
sole text descendant of matching labelled controls links to the nearest one.
When that control is among the matches, the text and matching outer wrappers
collapse into it, whether an outer wrapper is hittable or not. Separate controls
in distinct subtrees with the same label still refuse as ambiguous. The
[label-echo tests](../qaren-core/test/unit/qa/label-echo.test.ts) cover both cases.
The refusal lists
each candidate without its label or value: kind, testID or `no-id`, and the
rounded frame.

### Fill verification and keyboard fallback

Fills use strict native value verification first. A strict fill replaces the
field's content: the bound input is cleared before typing, and verification
expects exactly the plan text. Keyboard fallback typing also replaces: see below.
A secure field reads back
only as masked, so a fill into a secure target passes on the runner's stable
`secure-masked` verdict; every other strict fill requires an exact read-back,
and a screen change alone never verifies a fill. During discovery, a quoted
iOS fill can use keyboard fallback when no observable native input resolves, or
strict binding refuses `NO_TEXT_INPUT_TARGET` before any text mutation for a
non-native-input target. Phrase fills and stored replay selectors do not use
this fallback; ambiguous targets and potentially mutated fills still fail.

React-only input projections still count when matching a quoted strict fill,
so a native input and a React-only input sharing its testID refuse as
`TARGET_AMBIGUOUS` before any tap. A strict fill never acts on a React-only
input: when one is the only match, an accessibility-hidden input represented
only in React evidence returns `TARGET_NOT_FOUND`, allowing the guarded
native-wrapper fallback without scrolling. A genuine offscreen native input still requests scrolling; an onscreen
native input resolves strictly.

Tap-based fallback requires one onscreen, enabled, nonsecure native element
carrying a unique testID, with no matching observable native input or secure node.
The keyboard-down path requires proof that the keyboard is hidden before the
single tap. Every binding after the tap, including refreshed strict bindings,
must uniquely resolve the original testID or its `-pressable` wrapper-base
identity; a matching label cannot
substitute for that identity. If the same input becomes natively observable,
strict verification resumes. Otherwise the keyboard must become visible and
the target must remain eligible. React evidence that the intended input is
unfocused vetoes typing, and so does an unavailable React read, because the
field must be cleared first (below).

When the keyboard is already up, iOS fallback types only with positive React
proof that the intended input is focused. With an eligible target, QaReN taps it,
recaptures once, rebinds the same identity and then requires that proof. Without
a target, it requires that no secure or disabled element carries the quoted
testID and React reports that exact input focused. The guard and proof use the
quoted ID unchanged, including a literal `-pressable` suffix. Only an
observed wrapper in the tap path establishes a wrapper-to-base identity mapping.
Both keyboard-up paths require a second positive React focus read immediately
before native typing. A false, unbound, unreadable or failed read at either proof
stage types nothing; failure of the pre-dispatch read returns
`NO_TEXT_INPUT_TARGET` with no mutation. An unknown keyboard state still refuses.
Each walker focus decision logs one value-free `fallback-focus` line.

QaReN then clears the focused field and types once without final value validation.
Clearing needs a readable React value on the proven-focused input: a non-empty
value is deleted with keystrokes. Immediately before replacement typing, a
React read of the same testID must report both an empty value and positive focus.
An unreadable or uncontrolled value refuses before clearing with
`NO_TEXT_INPUT_TARGET`. Failed clearing or a missing empty-and-focused proof
refuses with `TEXT_ENTRY_UNVERIFIED` and sends no replacement text. Successful
clearing records an observed mutation; any later replacement failure retains
`mutation: observed` and returns `TEXT_ENTRY_UNVERIFIED`, without safe-retry
guidance, even if the runner reports no replacement mutation or only a possible
one. Fields already empty keep the existing typing-failure behavior. Secure fields
clear the same way. The [focused replacement tests](../qaren-core/test/unit/device-fill-focused-replace.test.ts)
cover these guards and mutation reporting.
A successful keyboard step records a passing row with reason `UNVERIFIED_FILL`,
allowing later plan steps to continue; it does not establish the field's final
value. Failed keyboard typing is not retried. Before the fallback tap or
no-target typing dispatch, the value is protected under the
[shared masking rules](#input-value-masking), and screenshots are withheld for the rest
of the walk. The block remains unsaved,
including when the tap leads back to strict verification. The eligibility and
identity rules are owned by the [resolver](../qaren-core/src/qa/resolve.ts) and
covered by the [fallback tests](../qaren-core/test/unit/qa/keyboard-fallback.test.ts).

### Plan checks and screen evidence

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
or an accessibility heading role. Heading predicates require qualified evidence:
an associated declared heading role, a platform-observed typographic title larger
than and above its body siblings, or an observed iOS navigation bar title. The
navigation bar itself remains a plain container. Requests for an accessibility
or declared heading require the declared role; typography and navigation titles
cannot satisfy that requirement. Qualification is owned by
[React heading association](../qaren-core/src/qa/host-typography.ts) and
[native navigation titles](../qaren-core/src/qa/native-presence.ts), with predicate
eligibility in the [resolver](../qaren-core/src/qa/resolve.ts).
Unsupported visual or layout claims remain uncertain.
Phrase waits capture fresh screen and presence evidence on every poll, even when the
screen appears unchanged; prior observations do not establish current presence.

Literal checks, quoted waits and quoted scroll-until targets exclude native text
outside the intersection of the Application screen rectangle and every retained
ScrollView, Table, CollectionView and Window ancestor rectangle, on both axes.
Screen and scroll-container clipping apply even when a node has no Window
ancestor, including captures with the keyboard up. Missing or invalid rectangles
skip only that clip; Application and Window rectangles must also have positive
size. A text input (`TextView`, `TextField`, `SecureTextField` or `SearchField`)
with any positive-size ancestor wholly outside the screen is offscreen even when
its own frame reports on-screen geometry. Other nodes follow only the screen,
Window and scroll clips, so on-screen rows under a stale off-screen container stay
visible; on-screen ancestors do not clip overflowing children. Partly overlapping nodes remain eligible. iOS interactive snapshots retain
content-less Window nodes with their real frames and ancestry to supply geometry.
Mounted text beyond the cumulative bounds cannot satisfy the plan until it enters
those bounds. Offscreen inputs remain in the privacy inventory for masking.
This geometric filter does not prove complete visual exposure or occlusion; its
implementation is owned by [native presence](../qaren-core/src/qa/native-presence.ts).

Passive capture diagnostics are computed and emitted for the same captured screen
only after the walker establishes acquisition admission and passes the required
native acquisition and presence checks. Incomplete, unattested, over-budget,
acquisition-expired or presence-refused observations emit neither line. Each
diagnostic is attempted once per admitted screen, with computation and sink errors
contained independently. Diagnostic work does not consume acquisition-admission
time or reset evidence freshness; later evidence-use deadlines still apply.
Both lines are private investigative evidence, not a root-cause or PASS claim;
they change no visibility, screenshot withholding, masking, eligibility or ledger
decision.

Each admitted complete native capture within the capture budget writes one value-free
`viewport-diagnostic` line, bounded to 2 KB, to the private run log
`logs/core.log`. It records integer-rounded Application and Window rectangles,
counts and capped symptom samples with Window ancestry and origins, and the count
plus up to ten in-app nodes the visibility rules excluded, each with its rule
(`anc`, `scroll` or `window`) and the deciding ancestor's type and rectangle; it
excludes labels, identifiers, values and other nodes' sizes.
The [diagnostic implementation](../qaren-core/src/qa/native-presence.ts)
owns its field layout.

A qualifying capture whose own privacy verdict marks its pixels sensitive also
writes one value-free `sensitive-pixels` line, at most 512 bytes including the log
prefix, to `logs/core.log`. It counts the stored private strings, secure elements
and input values, plus a histogram of the native types that show a stored value.
Types outside a fixed public list, and elements without a native node, count as
`Other`. It also samples up to four carriers as value-free shapes: type code,
scroll-bar label class, value class and length bucket, rounded width and height,
parent type code, identifier presence and value source. Unlisted type names are
not emitted. Samples are dropped before histogram entries to keep the line within
the byte limit. It excludes value text, label text, identifiers and testIDs. The
[diagnostic implementation](../qaren-core/src/qa/privacy.ts) owns its field layout.

Phrase presses require complete native and React coverage and proven React-to-native
associations. Native text, images and plain views are excluded from press candidates
only when complete React host evidence accounts for every interactive host and no
associated React evidence suggests that node is interactive. Only recognized
control and input roles contribute interactive-role evidence; heading, image,
`none`, `presentation`, text, summary and unknown roles do not. A positive host
press handler still establishes press capability regardless of role. A React role alone
does not grant press capability; a proven host press handler or native button,
switch or link does. Unknown capability or missing positive platform presence
refuses with `SCREEN_EVIDENCE_INCOMPLETE` rather than guessing a target.
The [screen projection](../qaren-core/src/qa/screen.ts) owns this policy.

The native snapshot is the privacy boundary before walking a screen. Capture
refuses with `PRIVATE_INPUT_CAPTURE_UNKNOWN` unless native completeness is attested;
the refusal reports only a value-free node count and fixed cause codes. Native
acquisition failures also refuse without reinjection or a public-tree fallback.
Native input classification follows the [screen projection](../qaren-core/src/qa/screen.ts),
including Other or unknown nodes carrying nonempty values regardless of React evidence,
with one exception: native `Other` elements matching the iOS system vertical or
horizontal scroll-bar label and carrying a percentage, such as
`Vertical scroll bar, 3 pages` with `42%`. The label match is case-insensitive,
allows an optional page count, and trims surrounding whitespace; the percentage
has one to three digits, an optional single decimal digit after `.` or `,`, an
optional single whitespace character such as the no-break space iOS may insert,
then `%`. The projection keeps the
label and omits this native value, so the indicator alone does not trigger
screenshot withholding. Other valued generic elements, malformed lookalikes,
React input evidence and secure fields remain protected. The accepted residual
risk is that an app element mimicking both patterns can expose its percentage
in captured pixels. The shared patterns in
[privacy.ts](../qaren-core/src/qa/privacy.ts) own the exact matching rule;
[regression cases](../qaren-core/test/unit/qa/sensitive-pixels-diagnostic.test.ts)
cover indicators, lookalikes and adjacent protected fields.
iOS fast snapshots retain nodes with distinct readable values even when their type,
label, identifier and origin match; deduplication compares those fields separately.
The React digest adds semantics: a deadline, malformed-payload, validation or
transport failure degrades React coverage to unknown without retrying capture.
Operations requiring complete React evidence still refuse when that coverage is
unavailable. Capture deadlines, budgets and item deadlines remain unchanged.

React-only elements expose no label, placeholder or value strings in the screen
projection. The React walk excludes provably inactive screen routes and native
hosts with `display: none` before collecting their semantic or descendant text
evidence. Validated React Native frozen descriptors remain readable; arbitrary
getters are not invoked, and an unreadable inactivity flag does not prune a subtree.
Unreadable display overrides or styles beyond the array or nesting scan budgets
resolve as unknown and do not establish `display: none`; later readable overrides
within the budgets still determine display.
Style arrays use the last present property: an explicit `undefined` or `null`
resets an earlier `display: none`, while an absent property leaves it unchanged.
The reset preserves descendant text evidence. The same distinction applies to
`display` and style-based `pointerEvents` in exact-ID interaction eligibility;
a reset clears the earlier style restriction without proving native visibility.

### Input value masking

Observed input values are masked before Jev requests. Private observed values and
concealed fallback values also receive fragment protection in reporting and every
outbound model request. A visible token is concealed when it contains a protected
value, is a substring of at least four characters, belongs to adjacent
single-character boxes whose concatenation matches at least two characters of a
protected value. A lone single character is never masked by itself, so plan list
numbers such as `3.` stay readable. The current screen's box context also applies when masking individual
output fields. Tokens joined by `-`, `_`, `.` or `@` are judged whole. In model
requests only a real element's structured testID is exempt from fragment masking;
marker-looking text in labels, values, placeholders, instructions and criteria is
masked normally. Short values and
fragments never rewrite it, so `address1` stays readable when `1` is protected,
but a testID containing a whole protected value of three or more characters is
concealed. For saved-action admission, see [Saved blocks](#saved-blocks).
Isolated shorter fragments of long
secrets remain readable: `is` stays visible for `existing-secret`, while `secr`
is concealed. A protected `1234` masks each of the four digit boxes shown side by side.

Complete values can retain opaque identity tokens for model comparisons; these
tokens disclose no content, length, format, order or validity. Concealed fragments
(`•••`) never count as assertion evidence, and a phrase check or visibility
expectation containing one remains uncertain. The
[privacy implementation](../qaren-core/src/qa/privacy.ts) owns masking, with
[fragment regression cases](../qaren-core/test/unit/qa/split-digit-privacy.test.ts).
Once sensitive input pixels or a protected value's visible echo are observed,
screenshots are withheld for the rest of the walk. Masks do not prove unobserved
value content.
Typed values outside protected fills that are shorter than three characters
and were never observed as private input values can remain plaintext in
unquoted reporting text; model masking
matches them only as separate tokens. This known limitation is tracked in ANT-283.

iOS interactions check app existence immediately and wait only when the app is
missing; availability and foreground checks remain in place. When the privacy
gate permits a row screenshot, the walk requests a full-screen image from the
running iOS runner and copies it into the run evidence directory. Lost or unknown
app-process identity withholds screenshots. Runner refusal, an invalid screenshot
path or a failed copy leaves the row without a screenshot and logs a value-free
unavailable reason; iOS QA never falls back to unrestricted simulator capture.

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

Before each iOS launch, `prepare` writes the app's Expo dev-menu preferences with
`simctl spawn <udid> defaults write <app-id>`: no floating action button, no menu
at launch, onboarding finished. A failed write is recorded as
`dev_menu_defaults: unconfirmed` and the launch continues. At walk start the core
also hides the floating button through Expo's `DevMenuPreferences` module and
reads the setting back, disables the shake gesture, and closes an open menu.
Apps without the preferences module skip that setting change but still require
native clearance evidence. The shared clearance mechanism accepts only a complete
native snapshot with neither a floating button nor an open dev menu in front,
briefly re-reading while overlays settle. An unconfirmed floating-button hide
or failure to obtain complete clearance evidence within those reads refuses
the walk with `DEV_MENU_HIDE_UNVERIFIED` before the first step.

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

### Saved blocks

Block IDs come from their `###` titles; a headingless block uses the plan's `#`
title, or `plan` when absent. The [parser's `slugify`](../qaren-core/src/qa/plan.ts)
lowercases the title, replaces runs outside `a-z` and `0-9` with hyphens, trims
edge hyphens and uses `plan` if empty. Slugs within the
[action-store length limit](../qaren-core/src/domain/path-safety.ts) stay unchanged.
Longer slugs use a prefix followed by a hyphen and the first 16 hexadecimal
characters of the full normalized slug's SHA-256, fitting that same limit.
The title stays unchanged; the filename, M7 `id`, `plan` header and replay lookup
use the same bounded ID. Existing valid actions are not renamed. Duplicate full
normalized slugs or distinct titles producing the same bounded ID refuse the
whole plan during preflight, before device allocation or action writes.

New files for passing `###` blocks use `<app>/.qaren/actions/<slug>.yaml`, where
`<app>` is the directory holding `.qaren/config.yaml` (with an external `--config`,
the checked working tree). The file is a Maestro-shaped action: each plan line as a
comment, then the commands with the exact `testID` (or, without one, the label) the
step used. On the next run a block whose plan lines, platform and app are unchanged
is replayed by those stored identities through the same walk, without Jev for quoted
targets or literal checks; phrase checks still ask Jev. A stored identity that no
longer resolves uniquely before that step authorizes any mutation re-walks
the block from that line; earlier completed steps are kept. Once that step authorizes
a mutation, its selector failure is terminal. On PASS only the commands under that
line and later ones are rewritten, and every `✓` comment stays byte-identical. A failing check is a FAIL and
is never re-walked or rewritten. Timeout recovery remains deferred (see
[Step recovery](#step-recovery)); app-process changes stay terminal. A failing block is never saved;
blocks that passed earlier in the run remain saved. A step without a `testID`
or label, a phrase wait, a fill into a secure or private input, or an attempt at
[keyboard fallback](#fill-verification-and-keyboard-fallback) leaves the block
unsaved and the ledger says why without naming any value; ordinary fills keep their
plan literal in the saved block. A previously saved block replayed against a now-private
input also reports withholding without rewriting or deleting the existing action.
Discovered or patched block writes are deferred until the walk finishes. Values
protected by private observations or keyboard fallback anywhere in the same run
are checked under the [shared masking rules](#input-value-masking), including
fragment protection. A matching block title, header field, raw comment, fill
literal, literal assertion, stored selector or serialized YAML withholds the
block rather than rewriting its bytes. Admission derives adjacent-character
context from the block's serialization inputs. The value-free reason is
`contains a protected plan-typed value` in `blocks_not_saved`, including when the
value was observed rather than typed. Existing saved actions are not removed.

For quoted waits and scroll-until steps, a testID is stored only when exactly one
captured element carries it, including offscreen elements in that count. A shared
testID falls back to unique painted text; without either unique identity the block
remains unsaved. A stored text selector must match exactly
one onscreen painted contribution. Equal text or button labels at different native
rectangles count separately, even when consecutive equal lines appear only once
in the assertion view. Identical native twins count once; container and image labels
do not add painted contributions. When no painted contribution matches, uniqueness
falls back to onscreen label carriers. An ambiguous target without a unique testID
can satisfy discovery but leaves the block unsaved; replay treats the ambiguous
stored text as a broken selector under the recovery rules above.

Replay requires the canonical block format emitted by
[`serializeBlock`](../qaren-core/src/qa/blocks.ts); edited or incompatible files
take the discovery path. Before overwriting an existing action, saving requires its
`plan` header to match the block ID and its full normalized title to match the incoming
title, using the normalization described above before length bounding. A colliding
short and long title therefore leaves the existing file byte-identical; same-title
patches remain allowed. A collision or unsafe corpus leaves the passing block unsaved
with a reason in `blocks_not_saved`.
Saving holds the existing action-write lock across extension selection, title ownership
checking and publication, so concurrent saves of colliding titles preserve the winner's
file. Both `.yaml` and `.yml` identities share this lock.

The ledger's `path` is `walk`, `replay` or `replay→walk@<line>` (the first re-walked
plan line), and each block reports `source` `discovered`, `replayed` or `patched`. The
receipt lists `blocks_written`, `blocks_not_saved` (block and reason) and, as a
diagnostic that never changes the verdict,
`worktree_drift`: app-root paths whose `git status` changed during the walk, outside
`.qaren/actions`. This status-only diagnostic is separate from the
[candidate provenance check](#candidate-provenance), which can fail the run.

Block names in final ledger rows, block results, reports and `blocks_not_saved`
use display masking. Machine fields `blocksWritten` in the core result and
`blocks_written` in the receipt retain canonical slugs for file lookup and PR
block preservation; replay identifiers also remain unchanged.

`qaren actions list [--json]` and `qaren actions show <slug>` read the
action corpus of the current directory. Both `.yaml` and `.yml` are supported;
existing files retain their extension when patched. A slug with both extensions
refuses inspection and is not overwritten by `check`. Symlinked corpora and
action files are refused. Inspection header validity and defaults follow the
[core header parser](../qaren-core/src/domain/reusable-action.ts); `list` skips
invalid headers and `show` refuses them.

PR runs copy saved blocks to the run's `blocks/` directory with their original
extension and bytes. See [Test a pull request](#test-a-pull-request) for branch
writeback validation and fallback comments.

On iOS the walk also fails `APP_PROCESS_CHANGED` when the app's process changes between
captures (a crash or restart), or a snapshot or platform-presence capture reports
`app-not-running`. Generic platform-presence runner failures retain the
`NATIVE_CAPTURE_UNAVAILABLE` refusal. An initial capture that does not report the process
refuses `APP_PROCESS_UNKNOWN`; a runner built from an older checkout needs a rebuild
(`RN_RUNNER_BUILD=local`).

### Step recovery

An observed React Native red box fails the current step immediately, including
during login replay, with safely masked visible error-screen text in `failure.seen`.
It is checked before accepting a step or refusing incomplete semantic evidence,
and never triggers recovery.

An action whose screen did not change after its one retry, a step target that
does not resolve, or a phrase check still unsure after its re-ask
gets at most one deterministic recovery, then the step runs once more from a fresh
capture. The order is owned by [`recover.ts`](../qaren-core/src/qa/recover.ts): a
recognized system dialog in front is accepted; a dev menu or floating button in
front is cleared through the shared [overlay clearance mechanism](#check-a-plan);
and when `loginMarker`
(`{ id: <testID> }` or `{ text: <label> }`) is on screen, the
saved block `loginBlock` (`.qaren/actions/<loginBlock>.yaml`, saved for this app and
platform) replays by its stored identities. The two keys are set together, with
exactly one nonempty marker `id` or `text`. A missing, unreadable or incompatible
login block fails when login recovery is needed. A second
failure of the same step fails it, recovery never runs inside the login replay, and
capture, Jev, process, replay-miss and cancellation refusals are never recovered. The
ledger's `recoveries` counts recoveries that let the step retry; `escapes` and `llmTurns`
stay `0`. Login fills are masked like plan fills and withhold the video.

Recovery requires admitted screen evidence. iOS phrase steps behind a system or
permission alert can refuse `SCREEN_EVIDENCE_INCOMPLETE` before recovery because
platform presence excludes that system surface; phrase-step dialog recovery is
best-effort. Android dialog recovery is not supported by `qaren check` in this
release (see [Check a plan](#check-a-plan)). An action reporting `tapped: false`
or `executed: false` establishes no action proof and cannot count as a recovery.

Dev-overlay recovery must re-prove clearance before retrying the step. A failed
clearance or a non-executing hide with no overlay to clear fails the step.

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

### Candidate provenance

The shared [candidate comparison](src/candidate.rs) rechecks the commit,
lockfile hash and worktree fingerprint. The fingerprint hashes normalized
NUL-delimited Git status records plus affected file contents, symlink targets,
absence and executable permission bits, so editing an already-dirty file is
still detected. Repository-root `.qaren/` state is excluded, as are direct
`.yaml` and `.yml` action files under the selected app root's `.qaren/actions/`.
Changes outside these exclusions, including a nested app's `.qaren/config.yaml`
or source files, and renames crossing the excluded boundary remain candidate
changes.

Preparation rechecks provenance before emitting `ready`; `check` and `pr`
recheck it before and after the walk. Detected drift fails with
`CANDIDATE_DRIFTED` and cannot return PASS; an already-cancelled walk retains
`RUN_CANCELLED`. Passing blocks already saved remain available. See the
[publication refusal contract](#test-a-pull-request) before publishing; re-run
against an unchanged candidate to obtain attributable evidence.

## Test a pull request

```sh
qaren pr <number|url> --plan-file plan.md --device <simulator-UUID> --json
qaren publish <run-id> --verdict-file verdict.md --json
```

`qaren publish` rejects runs whose persisted failure is `CANDIDATE_DRIFTED` or
`RUN_CANCELLED`, before uploading, posting comments, removing `needs-qa` or
writing back blocks. `RUN_CANCELLED` returns `result: refused` with exit 4;
`CANDIDATE_DRIFTED` returns `result: failed` with exit 1. Saved actions already
on disk remain untouched.

`qaren pr` runs the same pipeline as `check`, from the app's directory with the
same `.qaren/config.yaml` and plan, but walks a detached worktree at the pull
request head under `~/.qaren/runs/<run-id>/wt`. It refuses unless origin's
`pull/<n>/head` is the head GitHub reports and the worktree is clean at that
commit, both before the lease and again before the walk. Fetch verification uses
a per-run local ref rather than shared `FETCH_HEAD`, so concurrent PR runs
verify their own fetched commits. On iOS the simulator
screen is recorded from just before the walk to just after it and encoded to
`media/video.mp4` (H.264, 30 fps); without `ffmpeg`, or when a capture cannot
start, the run continues and the receipt's `video` outcome says why. The local
recording stays complete; `qaren publish` uploads only
`media/video-published.mp4`, a copy that starts when the walk proved the app's
bundle and passed [overlay clearance](#check-a-plan), so launcher, server-picker,
relaunch and dev chrome frames before admission never reach the pull request.
Without an admission time or a successful trim, or when an app process change,
launcher/server-picker fallback, floating button or open dev menu is observed
after admission, no video is uploaded, even if recovery clears the overlay and
the retry passes. Blocks the walk saved are copied to `blocks/` before the
worktree is removed. If the pull
request moved during the run, the receipt names the tested commit in
`tested_older_commit`. Like `check`, `pr` currently refuses Android with
`PLATFORM_UNSUPPORTED`.

Normal teardown and dead-owner recovery remove the PR worktree only after
cleanup proves the recorded build, core and Metro producers removed or absent.
Any retained, refused or unresolved producer outcome keeps the worktree recorded
for `qaren cleanup <run-id>`. Metro cleanup requires proven process-group absence
after reaping owned children; a free port or dead launcher alone is insufficient.
Present or unknown group evidence retains Metro ownership and any applicable lease.

An unproven recorder shutdown retains recorder ownership and the device lease,
including when recording startup fails. Teardown retries an unresolved stop;
the receipt's `cleanup.recorder` reports that final outcome. If shutdown remains
unresolved, recover with `qaren cleanup <run-id>` as described under
[iOS admission and cleanup](#ios-admission-and-cleanup).

`qaren publish` posts one comment: the sentence from `--verdict-file`, the
tested commit, an eligible available video, the plan with ✓/✗ per walked line,
an available failing screenshot and collapsed run details. Plan lines come only
from the walk's own rows, never from the raw plan file, so typed values stay out.
The hostname, home directory, user name, absolute paths, device UUIDs, the run's
device ids, serials and ports (recorded privately in `pr.json` as
`identityValues`) and private network addresses are removed from the comment.
Known identity values shorter than three UTF-8 bytes are not masked. Matching
ignores ASCII case and rejects matches next to ASCII letters, digits or hyphens;
a recorded port number also masks the same number elsewhere in the text. It then
removes the `needs-qa` label only if the current head is the tested head; otherwise
`publication.json` and the receipt record `retained-head-changed`.

A saved block is published only verbatim, and only when the walk was eligible
for publication (no fill/type step and no private value observed) and the
machine redaction would leave the block unchanged. Any other block stays in the
run's `blocks/` directory and is never rewritten; `publication.json` and the
receipt record `withheld <slug>: <reason>`. Published blocks are committed to the
pull request branch with a `Qaren-Run: <run-id>` trailer, using your own git
identity and a push lease on the tested commit. Every effective origin push URL
reported by Git must match the pull request's repository. Mixed, unknown or
unproved destinations prevent a push. When the branch moved, the pull request
comes from a fork, or destination verification fails, a second comment carries
the admitted blocks' YAML instead. Writeback refuses an ambiguous slug or a
destination with the other extension rather than creating a second sibling.

Before retrying an unpushed block commit, publication verifies that its sole
parent is the tested commit, its changes affect only currently admitted block
paths, and those files contain the admitted verbatim bytes without ambiguous
`.yaml`/`.yml` siblings. A matching cached commit is reused; otherwise a new
commit is built from the tested head using only currently admitted blocks.
The replacement does not descend from the rejected cached commit. Every newly
created commit, including a replacement, passes the same parent, path and exact
Git-blob byte checks before it can be pushed. Git filters or line-ending conversion
that change the saved bytes cause fallback to the verbatim blocks comment; QaReN
does not normalize the bytes or change `.gitattributes`. The same push lease
still applies; a failed commit or push falls back to the blocks comment.
When all blocks are withheld or privacy admission fails, no block commit is
pushed. A cached commit already at the remote branch head is reconciled as
published only when Git's effective origin fetch URL also matches the pull
request's repository and readback succeeds. A mirror, unknown destination or
failed lookup cannot prove publication; the verified push or fallback path
remains available. Reconciliation neither rewrites history nor claims earlier
content passed the current privacy gate.

Each step is recorded in `publication.json`. Before retrying an attempted post,
publication looks for the run's comment marker and adopts an existing comment.
If no comment was posted, it regenerates `comment.md` from the current verdict
file and walk rows, or `blocks-comment.md` from blocks admitted by the current
publication gate, applying current identity redaction before upload. Cached
bodies are not reused. Already-posted comments are neither edited nor deleted.

Publication holds an exclusive file-descriptor lock on `publish.lock`; a
concurrent publisher fails until the holder exits. The file remains after release;
its existence does not mean publication is active. Do not delete it to bypass
contention.

Video publication eligibility and a value-free withholding reason are persisted
in `pr.json`. A plan containing any fill/type step or a walk whose screenshot
privacy disallowed capture keeps the recording local. Missing, unknown or
unreadable eligibility also withholds the video; the comment explains why, without
changing the run verdict. Local recordings contain raw pixels. Transient prefilled
values between captures remain a limitation for 2.1; there is no continuous privacy
monitoring or pixel redaction.

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
   recorded qaren build. iOS follows the
   [CLI-owned build routes](#cli-owned-ios-build-routes); Android recompiles
   with `expo run:android` over the existing Gradle caches.
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
  — never a guess. When a core is recorded and the recorded qaren owner's
  process identity is proven still alive, `cleanup` refuses the whole run
  before any resource teardown and leaves `run.json` unchanged; finish or
  stop that run first. If the owner identity is unknown or missing, only
  core cleanup is refused; other cleanup legs and record persistence proceed
  under their existing ownership checks. A dead owner or reused owner PID
  permits core cleanup under its existing process-group proofs. Runs without
  a recorded core retain their existing cleanup behavior, including build
  cleanup.
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
  The attempt (timestamp, observed installed sha256, and command evidence
  for uninstall / `pm path` / package list) is persisted to `run.json` at
  `resources.app_install.removal` before any lease release; command evidence
  follows the diagnostic redaction contract above. A save failure makes the
  leg `unresolved` and retains the farm lease while independent owned local
  cleanup continues.
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
- **Provenance is rechecked at readiness.** See the shared
  [candidate provenance contract](#candidate-provenance) for fingerprint
  inputs, output exclusions and drift failures.
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
