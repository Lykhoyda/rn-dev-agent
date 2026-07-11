# Story 14 — Runner Transport Recovery Implementation Plan (#407)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a runner HTTP response is lost after a command was sent, the client distinguishes "never executed" from "executed, response lost" via a one-shot `status(commandId)` probe against a bounded runner-side outcome journal — recovering the result instead of tearing the session down, and **never** re-sending a mutating command.

**Architecture:** Three coordinated layers. (1) Both native runners (Swift `rn-fast-runner`, Kotlin `rn-android-runner`) keep a bounded in-memory journal of recent command outcomes keyed by a client-supplied `commandId`, and answer a new read-only `status` verb from it. (2) A new pure TS module `transport-recovery.ts` owns the shared policy: which commands are mutating, which failures are ambiguous, and what a probe reply means. (3) Each runner client's `postCommand` attaches a `commandId` to every wire body and, on an ambiguous post-send failure, issues exactly one short-budget probe before falling back to the existing invalidation path unchanged.

**Tech Stack:** TypeScript (Node ≥22, `node:test`), Swift (XCTest bundle, Network.framework server), Kotlin (NanoHTTPD, UIAutomator2 instrumentation).

**Spec:** GitHub issue #407 (maintainer-authored approach). Scope = issue points 1, 2, 3, 5. Point 4 (readiness-preflight recency skip) is explicitly a follow-on and is OUT of scope.

## Global Constraints

- Wire protocol version stays **1** (`RUNNER_PROTOCOL_VERSION` unchanged): `commandId` is an additive request field old runners ignore (Swift `JSONDecoder` and Kotlin `JSONObject` both ignore unknown fields); `status` is a new verb old artifacts answer with `UNSUPPORTED_COMMAND`, which the client treats as probe-unknown.
- `status` IS added to `REQUIRED_IOS_COMMANDS` / `REQUIRED_ANDROID_COMMANDS`, so pre-Story-14 artifacts classify `missing-commands` → the #418 stale-artifact self-heal rebuilds them at next session open. This is the designed upgrade path (precedent: #418 itself).
- Mutating verbs are NEVER auto-resent by the recovery layer, in any branch. The only resend the layer may issue is one read-only resend after a probe replies `completed` with no retained body.
- Journal exclusions: `snapshot` and `screenshot` response bodies are never retained (only their state); retained bodies are capped at 8 KB. Both excluded verbs are read-only, so recovery falls back to the safe resend branch.
- Recovery diagnostics surface as `meta.transportRecovery = { commandId, outcome }` on the recovered `ToolResult` (`outcome: 'recovered' | 'recovered-error' | 'resent'`). The recovery info travels IN the return value of a new `postCommandWithRecovery()` (consumed by `runIOS`/`runAndroid` only) — NEVER module-level state: `fastSwipe` and the Android settle probes also call `postCommand` and must be able to discard recovery info without a dangling note leaking into the next call's meta (multi-LLM review blocker, 2026-07-11). The `resent` outcome is attached only AFTER the resend succeeds.
- Native source of truth: `packages/rn-fast-runner/`, `packages/rn-android-runner/`. Host copies (`packages/{claude,codex}-plugin/scripts/…`) are GENERATED — never hand-edit; regenerate with `yarn build:host-runtimes`.
- `import type { … }` for type-only imports; no unnecessary comments; oxlint + oxfmt clean (pre-push hook enforces); new scripts must be TypeScript (repo TS-only gate); tests import from `../../dist/`, so `yarn build:core` before running them (the `test` script does this).
- Tri-file sync tests must stay green after every task: `gh-383-protocol-sync.test.js`, `gh-418-command-surface-sync.test.js` (TS REQUIRED lists are subsets of native surfaces; Kotlin `SUPPORTED_COMMANDS` must exactly match dispatcher when-branches — so native tasks land the verb before the protocol task adds it to the TS lists).
- Signed commits, one per task, changesets for `rn-dev-agent-core`, `rn-dev-agent-ios-runner`, `rn-dev-agent-android-runner`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/rn-dev-agent-core/src/runners/transport-recovery.ts` (new) | Pure shared policy: mutating-verb set, ambiguity classifier, commandId generator, probe-reply decision function |
| `packages/rn-dev-agent-core/test/unit/story-14-transport-recovery.test.js` (new) | Unit tests for the pure module |
| `packages/rn-android-runner/app/src/main/java/…/CommandJournal.kt` (new) | Bounded, synchronized outcome journal (main source set → JVM-testable) |
| `packages/rn-android-runner/app/src/test/java/…/CommandJournalTest.kt` (new) | JVM unit tests |
| `packages/rn-android-runner/app/src/androidTest/java/…/CommandServer.kt` | Record every /command outcome into the journal |
| `packages/rn-android-runner/app/src/androidTest/java/…/CommandDispatcher.kt` | `status` when-branch + `SUPPORTED_COMMANDS` entry; journal constructor param |
| `packages/rn-android-runner/app/src/androidTest/java/…/RnAndroidRunnerInstrumentedTest.kt` | Construct the shared journal, pass to dispatcher + server |
| `packages/rn-fast-runner/…/RnFastRunnerUITests/CommandJournal.swift` (new) | Bounded outcome journal (serial-queue confined) |
| `packages/rn-fast-runner/…/RnFastRunnerUITests/CommandJournalTests.swift` (new) | Unit tests (run in the UITests bundle like `SnapshotPredicatesTests`) |
| `packages/rn-fast-runner/…/RnFastRunnerUITests/RnFastRunnerTests+Models.swift` | `status` CommandType case + `commandId` field on `Command` |
| `packages/rn-fast-runner/…/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift` | Record outcomes; answer `status` from the journal |
| `packages/rn-fast-runner/…/RnFastRunnerUITests/RnFastRunnerTests.swift` | `commandJournal` instance property |
| `packages/rn-dev-agent-core/src/runners/protocol.ts` | `'status'` in both REQUIRED lists |
| `packages/rn-dev-agent-core/src/runners/rn-fast-runner-client.ts` | commandId attach + probe-recover in `postCommand`; `'status'` in `RunIOSArgs['command']`; meta note consume |
| `packages/rn-dev-agent-core/src/runners/rn-android-runner-client.ts` | Same for Android (`RunAndroidArgs['command']`) |
| `packages/rn-dev-agent-core/test/unit/story-14-ios-recovery.test.js` (new) | iOS client recovery integration tests (fake fetch) |
| `packages/rn-dev-agent-core/test/unit/story-14-android-recovery.test.js` (new) | Android client recovery integration tests (fake fetch) |

Xcode note: the project uses `fileSystemSynchronizedGroups` (verified — `SnapshotPredicates.swift` has zero pbxproj references), so new Swift files need NO project.pbxproj edit.

---

### Task 1: Shared transport-recovery policy module (TS, pure)

**Files:**
- Create: `packages/rn-dev-agent-core/src/runners/transport-recovery.ts`
- Test: `packages/rn-dev-agent-core/test/unit/story-14-transport-recovery.test.js`

**Interfaces:**
- Produces (consumed by Tasks 5/6): `generateCommandId(): string`; `isMutatingCommand(command: unknown): boolean`; `isAmbiguousTransportFailure(message: string): boolean`; `type ProbeState = 'completed' | 'failed' | 'unknown'`; `interface StatusProbeReply { state: ProbeState; result?: unknown }`; `parseStatusProbeReply(resp: unknown, expectedCommandId: string): StatusProbeReply | null` (rejects a reply whose `data.commandId` doesn't echo the probe's id, and a retained `result` that isn't an object carrying a boolean `ok`); `type RecoveryDecision = { action: 'return-recovered'; response: unknown; outcome: 'recovered' | 'recovered-error' } | { action: 'resend-once' } | { action: 'rethrow' }`; `decideRecovery(probe: StatusProbeReply | null, command: unknown): RecoveryDecision`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCommandId,
  isMutatingCommand,
  isAmbiguousTransportFailure,
  parseStatusProbeReply,
  decideRecovery,
} from '../../dist/runners/transport-recovery.js';

test('generateCommandId returns unique non-empty ids', () => {
  const a = generateCommandId();
  const b = generateCommandId();
  assert.ok(a.length > 8);
  assert.notEqual(a, b);
});

test('mutating classification: every gesture/typing/lifecycle verb is mutating', () => {
  for (const c of ['tap', 'type', 'drag', 'swipe', 'scroll', 'longPress', 'pinch',
    'back', 'keyboardDismiss', 'dismissKeyboard', 'keyboard', 'press', 'fill',
    'tapSeries', 'dragSeries', 'mouseClick', 'remotePress', 'home', 'pressHome',
    'backInApp', 'backSystem', 'rotate', 'appSwitcher', 'alert', 'activate',
    'terminate', 'shutdown']) {
    assert.equal(isMutatingCommand(c), true, `${c} must be mutating`);
  }
  for (const c of ['snapshot', 'screenshot', 'findText', 'readText', 'isScreenStatic',
    'isWindowUpdating', 'appState', 'uptime', 'interactionFrame', 'status']) {
    assert.equal(isMutatingCommand(c), false, `${c} must be read-only`);
  }
});

test('ambiguity: pre-send and protocol failures are NOT ambiguous', () => {
  assert.equal(isAmbiguousTransportFailure('rn-android-runner not started'), false);
  assert.equal(isAmbiguousTransportFailure('rn-fast-runner not started — run device_snapshot'), false);
  assert.equal(isAmbiguousTransportFailure('RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v9'), false);
  assert.equal(isAmbiguousTransportFailure('RUNNER_TIMEOUT: rn-fast-runner did not respond to "tap" within 10000ms'), true);
  assert.equal(isAmbiguousTransportFailure('fetch failed'), true);
  assert.equal(isAmbiguousTransportFailure('socket hang up'), true);
  assert.equal(isAmbiguousTransportFailure('rn-android-runner returned a non-JSON response body'), true);
});

test('parseStatusProbeReply extracts state and result from a status reply', () => {
  assert.deepEqual(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-1', state: 'completed', result: { ok: true, data: { tapped: true } } } }, 'c-1'),
    { state: 'completed', result: { ok: true, data: { tapped: true } } },
  );
  assert.deepEqual(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-1', state: 'unknown' } }, 'c-1'),
    { state: 'unknown' },
  );
  assert.equal(parseStatusProbeReply({ ok: false, error: { code: 'UNSUPPORTED_COMMAND', message: 'x' } }, 'c-1'), null);
  assert.equal(parseStatusProbeReply({ ok: true, data: { state: 'sideways' } }, 'c-1'), null);
  assert.equal(parseStatusProbeReply(undefined, 'c-1'), null);
});

test('parseStatusProbeReply rejects mismatched commandId echo and malformed results', () => {
  assert.equal(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-OTHER', state: 'completed' } }, 'c-1'),
    null,
  );
  assert.deepEqual(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-1', state: 'completed', result: 'not-an-object' } }, 'c-1'),
    { state: 'completed' },
  );
  assert.deepEqual(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-1', state: 'completed', result: { data: {} } } }, 'c-1'),
    { state: 'completed' },
  );
});

test('decideRecovery: completed+retained returns recovered response, never resends', () => {
  const recorded = { ok: true, v: 1, data: { tapped: true } };
  assert.deepEqual(
    decideRecovery({ state: 'completed', result: recorded }, 'tap'),
    { action: 'return-recovered', response: recorded, outcome: 'recovered' },
  );
});

test('decideRecovery: failed+retained surfaces the recorded runner error', () => {
  const recorded = { ok: false, v: 1, error: { code: 'RUNNER_ERROR', message: 'boom' } };
  assert.deepEqual(
    decideRecovery({ state: 'failed', result: recorded }, 'tap'),
    { action: 'return-recovered', response: recorded, outcome: 'recovered-error' },
  );
});

test('decideRecovery: completed without retained body resends read-only, rethrows mutating', () => {
  assert.deepEqual(decideRecovery({ state: 'completed' }, 'snapshot'), { action: 'resend-once' });
  assert.deepEqual(decideRecovery({ state: 'completed' }, 'screenshot'), { action: 'resend-once' });
  assert.deepEqual(decideRecovery({ state: 'completed' }, 'tap'), { action: 'rethrow' });
});

test('decideRecovery: unknown/failed-unretained/null probes rethrow', () => {
  assert.deepEqual(decideRecovery({ state: 'unknown' }, 'snapshot'), { action: 'rethrow' });
  assert.deepEqual(decideRecovery({ state: 'failed' }, 'tap'), { action: 'rethrow' });
  assert.deepEqual(decideRecovery(null, 'tap'), { action: 'rethrow' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn build:core && node --test packages/rn-dev-agent-core/test/unit/story-14-transport-recovery.test.js`
Expected: FAIL — `Cannot find module '../../dist/runners/transport-recovery.js'`

- [ ] **Step 3: Write the implementation**

```typescript
import { randomUUID } from 'node:crypto';

// Story 14 (#407): shared post-send transport-recovery policy for both native
// runner clients. Pure decisions only — the clients own fetch mechanics.

// Every verb whose execution changes device/app state. A lost response to any
// of these must NEVER trigger a resend: the tap may have landed. Union of both
// runners' surfaces (iOS CommandType + Android SUPPORTED_COMMANDS + client verbs).
const MUTATING_COMMANDS = new Set([
  'tap', 'mouseClick', 'tapSeries', 'longPress', 'drag', 'dragSeries',
  'remotePress', 'type', 'fill', 'press', 'swipe', 'scroll', 'back',
  'backInApp', 'backSystem', 'home', 'pressHome', 'rotate', 'appSwitcher',
  'keyboardDismiss', 'dismissKeyboard', 'keyboard', 'alert', 'pinch',
  'activate', 'terminate', 'shutdown',
]);

export function isMutatingCommand(command: unknown): boolean {
  return MUTATING_COMMANDS.has(String(command));
}

export function generateCommandId(): string {
  return `c-${randomUUID()}`;
}

// A failure warrants a status probe only when the command MAY have reached the
// runner. "not started" never sent anything; a protocol mismatch is a reply we
// received and understood. Everything else (abort timeout, connection reset,
// unparseable reply) is ambiguous — probing a dead runner just fails fast to
// the existing invalidation path.
export function isAmbiguousTransportFailure(message: string): boolean {
  if (message.startsWith('RUNNER_PROTOCOL_MISMATCH')) return false;
  if (/not started/i.test(message)) return false;
  return true;
}

export type ProbeState = 'completed' | 'failed' | 'unknown';

export interface StatusProbeReply {
  state: ProbeState;
  result?: unknown;
}

const PROBE_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'unknown']);

export function parseStatusProbeReply(
  resp: unknown,
  expectedCommandId: string,
): StatusProbeReply | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as { ok?: unknown; data?: unknown };
  if (r.ok !== true || !r.data || typeof r.data !== 'object') return null;
  const data = r.data as { commandId?: unknown; state?: unknown; result?: unknown };
  if (data.commandId !== expectedCommandId) return null;
  if (typeof data.state !== 'string' || !PROBE_STATES.has(data.state)) return null;
  const reply: StatusProbeReply = { state: data.state as ProbeState };
  // A retained result must look like a runner response (object with boolean ok)
  // before we hand it back as one — anything else degrades to state-only.
  if (
    data.result !== undefined &&
    data.result !== null &&
    typeof data.result === 'object' &&
    typeof (data.result as { ok?: unknown }).ok === 'boolean'
  ) {
    reply.result = data.result;
  }
  return reply;
}

export type RecoveryDecision =
  | { action: 'return-recovered'; response: unknown; outcome: 'recovered' | 'recovered-error' }
  | { action: 'resend-once' }
  | { action: 'rethrow' };

export function decideRecovery(
  probe: StatusProbeReply | null,
  command: unknown,
): RecoveryDecision {
  if (!probe || probe.state === 'unknown') return { action: 'rethrow' };
  if (probe.result !== undefined) {
    return {
      action: 'return-recovered',
      response: probe.result,
      outcome: probe.state === 'failed' ? 'recovered-error' : 'recovered',
    };
  }
  if (probe.state === 'completed' && !isMutatingCommand(command)) {
    return { action: 'resend-once' };
  }
  return { action: 'rethrow' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn build:core && node --test packages/rn-dev-agent-core/test/unit/story-14-transport-recovery.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Lint, format, commit**

```bash
npx oxlint packages/rn-dev-agent-core/src/runners/transport-recovery.ts
npx oxfmt packages/rn-dev-agent-core/src/runners/transport-recovery.ts packages/rn-dev-agent-core/test/unit/story-14-transport-recovery.test.js
git add packages/rn-dev-agent-core/src/runners/transport-recovery.ts packages/rn-dev-agent-core/test/unit/story-14-transport-recovery.test.js
git commit -S -m "feat(core): Story 14 shared transport-recovery policy module (#407)"
```

---

### Task 2: Android runner — CommandJournal + status verb

**Files:**
- Create: `packages/rn-android-runner/app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/CommandJournal.kt`
- Create: `packages/rn-android-runner/app/src/test/java/dev/lykhoyda/rndevagent/androidrunner/CommandJournalTest.kt`
- Modify: `packages/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt` (SUPPORTED_COMMANDS + `status` branch + constructor param)
- Modify: `packages/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandServer.kt` (record outcomes)
- Modify: `packages/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/RnAndroidRunnerInstrumentedTest.kt` (shared journal construction)

**Interfaces:**
- Produces: `class CommandJournal(capacity: Int = 32, maxRetainedBytes: Int = 8192)` with `fun record(commandId: String?, command: String?, ok: Boolean, body: String)` and `fun lookup(commandId: String): Entry?` where `data class Entry(val state: String, val body: String?)`. States: `"completed"` / `"failed"`.
- Wire (consumed by Task 6): `POST /command {command:"status", commandId}` → `{ok:true, v:1, data:{commandId, state:"completed"|"failed"|"unknown", result?: <recorded full response object>}}`.

- [ ] **Step 1: Write the failing JVM test**

```kotlin
/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommandJournalTest {
    @Test
    fun recordsAndLooksUpOutcomes() {
        val j = CommandJournal()
        j.record("c-1", "tap", true, """{"ok":true,"data":{"tapped":true}}""")
        j.record("c-2", "tap", false, """{"ok":false,"error":{"message":"boom"}}""")
        assertEquals("completed", j.lookup("c-1")?.state)
        assertEquals("""{"ok":true,"data":{"tapped":true}}""", j.lookup("c-1")?.body)
        assertEquals("failed", j.lookup("c-2")?.state)
        assertNull(j.lookup("c-404"))
    }

    @Test
    fun skipsBlankIdsAndStatusCommands() {
        val j = CommandJournal()
        j.record(null, "tap", true, "{}")
        j.record("", "tap", true, "{}")
        j.record("c-s", "status", true, "{}")
        assertNull(j.lookup(""))
        assertNull(j.lookup("c-s"))
    }

    @Test
    fun retainsStateButNotBodyForSnapshotScreenshotAndOversized() {
        val j = CommandJournal(capacity = 32, maxRetainedBytes = 16)
        j.record("c-snap", "snapshot", true, """{"ok":true}""")
        j.record("c-shot", "screenshot", true, """{"ok":true}""")
        j.record("c-big", "tap", true, "x".repeat(64))
        assertEquals("completed", j.lookup("c-snap")?.state)
        assertNull(j.lookup("c-snap")?.body)
        assertNull(j.lookup("c-shot")?.body)
        assertEquals("completed", j.lookup("c-big")?.state)
        assertNull(j.lookup("c-big")?.body)
    }

    @Test
    fun capCountsUtf8BytesNotUtf16CodeUnits() {
        val j = CommandJournal(capacity = 32, maxRetainedBytes = 16)
        val multibyte = "€".repeat(6) // 6 UTF-16 code units, 18 UTF-8 bytes
        j.record("c-mb", "tap", true, multibyte)
        assertEquals("completed", j.lookup("c-mb")?.state)
        assertNull(j.lookup("c-mb")?.body)
    }

    @Test
    fun evictsOldestBeyondCapacity() {
        val j = CommandJournal(capacity = 3)
        for (i in 1..5) j.record("c-$i", "tap", true, "{}")
        assertNull(j.lookup("c-1"))
        assertNull(j.lookup("c-2"))
        assertEquals("completed", j.lookup("c-3")?.state)
        assertEquals("completed", j.lookup("c-5")?.state)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `corepack yarn test:native:android`
Expected: FAIL — unresolved reference `CommandJournal`

- [ ] **Step 3: Implement CommandJournal (main source set)**

```kotlin
/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

// Story 14 (#407): bounded journal of recent /command outcomes so the client
// can distinguish "never executed" from "executed, response lost" after an
// ambiguous transport failure. NanoHTTPD serves connections on worker threads,
// so all access is synchronized. Heavy payloads (snapshot nodes, screenshot
// base64) keep only their state — both verbs are read-only, so the client may
// safely re-send instead.
class CommandJournal(
    private val capacity: Int = 32,
    private val maxRetainedBytes: Int = 8192,
) {
    data class Entry(val state: String, val body: String?)

    private val lock = Any()
    private val entries = object : LinkedHashMap<String, Entry>(16, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>): Boolean =
            size > capacity
    }

    fun record(commandId: String?, command: String?, ok: Boolean, body: String) {
        if (commandId.isNullOrBlank() || command == "status") return
        // UTF-8 byte count, not String.length (UTF-16 code units) — keeps the
        // retention cap identical to the Swift journal's Data.count.
        val retain = command != "snapshot" && command != "screenshot" &&
            body.toByteArray(Charsets.UTF_8).size <= maxRetainedBytes
        synchronized(lock) {
            entries[commandId] = Entry(if (ok) "completed" else "failed", if (retain) body else null)
        }
    }

    fun lookup(commandId: String): Entry? = synchronized(lock) { entries[commandId] }
}
```

- [ ] **Step 4: Run JVM tests to verify they pass**

Run: `corepack yarn test:native:android`
Expected: PASS (existing + 4 new)

- [ ] **Step 5: Wire the journal through dispatcher and server**

`CommandDispatcher.kt` — constructor gains the journal; `status` joins the surface:

```kotlin
class CommandDispatcher(
    private val instrumentation: Instrumentation,
    private val journal: CommandJournal = CommandJournal(),
) {
```

Add `"status"` to `SUPPORTED_COMMANDS` (end of list). Add the when-branch (place after `"findText"`; it must NOT join the foregrounding whitelist — a probe must never steal foreground):

```kotlin
// Story 14 (#407): read-only outcome probe — answers from the journal,
// never touches the device.
"status" -> {
    val id = cmd.optString("commandId")
    if (id.isBlank()) return error("INVALID_ARGUMENT", "status requires a non-blank 'commandId'")
    val entry = journal.lookup(id)
    JSONObject()
        .put("commandId", id)
        .put("state", entry?.state ?: "unknown")
        .apply { entry?.body?.let { put("result", JSONObject(it)) } }
}
```

`CommandServer.kt` — record every POST /command outcome (success and error paths). Restructure `serve`'s POST branch so the parsed request stays in scope of all catches, then record before returning:

```kotlin
return try {
    val files = HashMap<String, String>()
    session.parseBody(files)
    val raw = files["postData"] ?: "{}"
    val command = JSONObject(raw)
    val body = RunnerRuntime.dispatcher.dispatch(command)
    record(command, body)
    json(Response.Status.OK, body)
} catch (e: NoFocusedInputException) {
    errorResponse(session, "NO_FOCUSED_INPUT", e.message ?: "no focused input", Response.Status.OK)
} catch (e: SnapshotParseException) {
    errorResponse(session, "SNAPSHOT_PARSE_FAILED", e.message ?: "snapshot parse failed", Response.Status.OK)
} catch (t: Throwable) {
    errorResponse(session, "RUNNER_ERROR", t.message ?: t.javaClass.name, Response.Status.INTERNAL_ERROR)
}
```

with the helpers (the catch paths re-parse the raw body defensively — parse failures just skip journaling):

```kotlin
private fun record(command: JSONObject?, body: JSONObject) {
    val cmd = command ?: return
    RunnerRuntime.journal.record(
        cmd.optString("commandId").ifBlank { null },
        cmd.optString("command").ifBlank { null },
        body.optBoolean("ok", false),
        body.toString(),
    )
}
```

Note: to keep the raw command visible to the catch blocks, hoist `var command: JSONObject? = null` above the `try` and assign inside; `errorResponse` builds the same error JSONObject shape as today, calls `record(command, body)`, then `json(status, body)`. Every error path MUST route through `errorResponse` — the "executed-and-failed, response lost" case only recovers if failures journal too (multi-LLM review finding #4; `errorResponse` takes `command` as a parameter so the structural guarantee is visible at each call site).

Also add one instrumented server-path test to `RnAndroidRunnerInstrumentedTest.kt` (device-run in CI's native workflow) proving an error outcome journals: POST a `type` command with a `commandId` and no focused input (raises `NoFocusedInputException`), then POST `status` for that id and assert `state == "failed"` with a retained `result.error.code == "NO_FOCUSED_INPUT"`. Follow the file's existing HTTP-request helper pattern.

`RunnerRuntime` gains the shared journal:

```kotlin
object RunnerRuntime {
    lateinit var dispatcher: CommandDispatcher
    val journal: CommandJournal = CommandJournal()
}
```

`RnAndroidRunnerInstrumentedTest.kt` line 43 becomes:

```kotlin
RunnerRuntime.dispatcher = CommandDispatcher(instrumentation, RunnerRuntime.journal)
```

- [ ] **Step 6: Compile-check androidTest sources + rerun JVM tests**

Run: `corepack yarn test:native:android` (JVM) — PASS.
Run if the Android SDK is available: `cd packages/rn-android-runner && ./gradlew :app:compileDebugAndroidTestKotlin` — BUILD SUCCESSFUL. If no SDK on this machine, note it in the report; CI's native-tests workflow compiles androidTest.

- [ ] **Step 7: Commit**

```bash
git add packages/rn-android-runner
git commit -S -m "feat(rn-android-runner): Story 14 command-outcome journal + status verb (#407)"
```

---

### Task 3: iOS runner — CommandJournal + status verb

**Files:**
- Create: `packages/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/CommandJournal.swift`
- Create: `packages/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/CommandJournalTests.swift`
- Modify: `packages/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift` (CommandType `status` case; `commandId` on Command)
- Modify: `packages/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift` (record + answer status)
- Modify: `packages/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests.swift` (journal property)

**Interfaces:**
- Produces the same wire shape as Task 2 (the TS client is platform-agnostic): `{ok:true, v:1, data:{commandId, state, result?}}`.
- `final class CommandJournal { init(capacity: Int = 32, maxRetainedBytes: Int = 8192); func record(commandId: String?, command: String?, ok: Bool, body: Data); func lookup(commandId: String) -> Entry? }` with `struct Entry { let state: String; let body: Data? }`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest

final class CommandJournalTests: XCTestCase {
  func testRecordsAndLooksUpOutcomes() {
    let j = CommandJournal()
    j.record(commandId: "c-1", command: "tap", ok: true, body: Data("{\"ok\":true}".utf8))
    j.record(commandId: "c-2", command: "tap", ok: false, body: Data("{\"ok\":false}".utf8))
    XCTAssertEqual(j.lookup(commandId: "c-1")?.state, "completed")
    XCTAssertEqual(j.lookup(commandId: "c-1")?.body, Data("{\"ok\":true}".utf8))
    XCTAssertEqual(j.lookup(commandId: "c-2")?.state, "failed")
    XCTAssertNil(j.lookup(commandId: "c-404"))
  }

  func testSkipsMissingIdsAndStatusCommands() {
    let j = CommandJournal()
    j.record(commandId: nil, command: "tap", ok: true, body: Data())
    j.record(commandId: "", command: "tap", ok: true, body: Data())
    j.record(commandId: "c-s", command: "status", ok: true, body: Data())
    XCTAssertNil(j.lookup(commandId: ""))
    XCTAssertNil(j.lookup(commandId: "c-s"))
  }

  func testRetainsStateButNotBodyForSnapshotScreenshotAndOversized() {
    let j = CommandJournal(capacity: 32, maxRetainedBytes: 16)
    j.record(commandId: "c-snap", command: "snapshot", ok: true, body: Data("{\"ok\":true}".utf8))
    j.record(commandId: "c-shot", command: "screenshot", ok: true, body: Data("{\"ok\":true}".utf8))
    j.record(commandId: "c-big", command: "tap", ok: true, body: Data(repeating: 120, count: 64))
    XCTAssertEqual(j.lookup(commandId: "c-snap")?.state, "completed")
    XCTAssertNil(j.lookup(commandId: "c-snap")?.body)
    XCTAssertNil(j.lookup(commandId: "c-shot")?.body)
    XCTAssertEqual(j.lookup(commandId: "c-big")?.state, "completed")
    XCTAssertNil(j.lookup(commandId: "c-big")?.body)
  }

  func testEvictsOldestBeyondCapacity() {
    let j = CommandJournal(capacity: 3)
    for i in 1...5 { j.record(commandId: "c-\(i)", command: "tap", ok: true, body: Data("{}".utf8)) }
    XCTAssertNil(j.lookup(commandId: "c-1"))
    XCTAssertNil(j.lookup(commandId: "c-2"))
    XCTAssertEqual(j.lookup(commandId: "c-3")?.state, "completed")
    XCTAssertEqual(j.lookup(commandId: "c-5")?.state, "completed")
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash scripts/test-native-ios.sh` (requires a booted simulator; if none, `xcodebuild build-for-testing` compile check and note it).
Expected: FAIL — cannot find `CommandJournal` in scope.

- [ ] **Step 3: Implement CommandJournal.swift**

```swift
import Foundation

// Story 14 (#407): bounded journal of recent /command outcomes so the client
// can distinguish "never executed" from "executed, response lost" after an
// ambiguous transport failure. All access happens on the runner's single
// serial dispatch queue ("rn-fast-runner.runner"), so no locking is needed.
// Heavy payloads (snapshot nodes, screenshot base64) keep only their state —
// both verbs are read-only, so the client may safely re-send instead.
final class CommandJournal {
  struct Entry {
    let state: String
    let body: Data?
  }

  private let capacity: Int
  private let maxRetainedBytes: Int
  private var order: [String] = []
  private var entries: [String: Entry] = [:]

  init(capacity: Int = 32, maxRetainedBytes: Int = 8192) {
    self.capacity = capacity
    self.maxRetainedBytes = maxRetainedBytes
  }

  func record(commandId: String?, command: String?, ok: Bool, body: Data) {
    guard let id = commandId, !id.isEmpty, command != "status" else { return }
    let retain = command != "snapshot" && command != "screenshot" && body.count <= maxRetainedBytes
    if entries[id] == nil { order.append(id) }
    entries[id] = Entry(state: ok ? "completed" : "failed", body: retain ? body : nil)
    while order.count > capacity {
      let oldest = order.removeFirst()
      entries.removeValue(forKey: oldest)
    }
  }

  func lookup(commandId: String) -> Entry? {
    entries[commandId]
  }
}
```

- [ ] **Step 4: Wire models + transport**

`RnFastRunnerTests+Models.swift`: add `case status` to `CommandType` (after `case uptime`); add `let commandId: String?` to `Command` (after `let command`).

`RnFastRunnerTests.swift`: add instance property near `var listener: NWListener?`:

```swift
let commandJournal = CommandJournal()
```

`RnFastRunnerTests+Transport.swift` — `handleRequestBody` gains (a) a status fast-path and (b) outcome recording. Replace the body of `handleRequestBody` from the `CommandTypeProbe` block onward with:

```swift
struct CommandProbe: Decodable {
  let command: String
  let commandId: String?
}
let probe = try? JSONDecoder().decode(CommandProbe.self, from: data)

if let probe, CommandType(rawValue: probe.command) == nil {
  // GH #418: a verb this artifact doesn't know is a typed refusal, not a
  // dataCorrupted decode error (B235). Mirrors the Android runner's shape.
  return (
    jsonResponse(status: 200, response: Response(
      ok: false,
      error: ErrorPayload(
        code: "UNSUPPORTED_COMMAND",
        message: "Unsupported iOS runner command: \(probe.command) — the runner artifact predates it; re-open the device session (device_snapshot action=open) to rebuild."
      )
    )),
    false
  )
}

// Story 14 (#407): outcome probe — answered from the journal, no execute().
if probe?.command == CommandType.status.rawValue {
  return (statusResponse(commandId: probe?.commandId), false)
}

do {
  let command = try JSONDecoder().decode(Command.self, from: data)
  let response = try execute(command: command)
  let body = encodeBody(response)
  commandJournal.record(commandId: probe?.commandId, command: probe?.command, ok: response.ok, body: body)
  return (httpResponse(status: 200, body: String(decoding: body, as: UTF8.self)), command.command == .shutdown)
} catch {
  let response = Response(ok: false, error: ErrorPayload(message: "\(error)"))
  let body = encodeBody(response)
  commandJournal.record(commandId: probe?.commandId, command: probe?.command, ok: false, body: body)
  return (httpResponse(status: 500, body: String(decoding: body, as: UTF8.self)), false)
}
```

with two new private helpers in the same extension:

```swift
private func encodeBody(_ response: Response) -> Data {
  (try? JSONEncoder().encode(response)) ?? Data("{}".utf8)
}

// The recorded body is spliced back verbatim as data.result — Codable models
// cannot express "arbitrary recorded JSON", so this one response is built via
// JSONSerialization.
private func statusResponse(commandId: String?) -> Data {
  guard let id = commandId, !id.isEmpty else {
    return jsonResponse(status: 200, response: Response(
      ok: false,
      error: ErrorPayload(code: "INVALID_ARGUMENT", message: "status requires a non-blank 'commandId'")
    ))
  }
  let entry = commandJournal.lookup(commandId: id)
  var data: [String: Any] = ["commandId": id, "state": entry?.state ?? "unknown"]
  if let body = entry?.body,
     let parsed = try? JSONSerialization.jsonObject(with: body) {
    data["result"] = parsed
  }
  let payload: [String: Any] = ["ok": true, "v": RunnerProtocol.version, "data": data]
  let encoded = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
  return httpResponse(status: 200, body: String(decoding: encoded, as: UTF8.self))
}
```

(`jsonResponse` stays for the other call sites; `httpResponse` is already `private func` in this file. The `execute(command:)` switch needs a `case .status` arm — make it unreachable-safe: `return Response(ok: false, error: ErrorPayload(code: "INVALID_ARGUMENT", message: "status is handled at the transport layer"))` — the fast-path above answers first.)

- [ ] **Step 5: Run iOS native tests**

Run: `bash scripts/test-native-ios.sh`
Expected: PASS (existing + 4 new CommandJournalTests). If no simulator runtime on this machine, run the compile check and state that CI covers execution.

- [ ] **Step 6: Commit**

```bash
git add packages/rn-fast-runner
git commit -S -m "feat(rn-fast-runner): Story 14 command-outcome journal + status verb (#407)"
```

---

### Task 4: Protocol surface — `status` in the REQUIRED lists

**Files:**
- Modify: `packages/rn-dev-agent-core/src/runners/protocol.ts`
- Modify: `packages/rn-dev-agent-core/src/runners/rn-fast-runner-client.ts` (`RunIOSArgs['command']` union)
- Modify: `packages/rn-dev-agent-core/src/runners/rn-android-runner-client.ts` (`RunAndroidArgs['command']` union)

**Interfaces:**
- Consumes: Tasks 2/3 must already be merged locally (the gh-418 sync test parses native sources; TS lists must stay subsets of the native surfaces).
- Produces: liveness gate now requires `status`, so pre-Story-14 artifacts self-heal-rebuild per #418.

- [ ] **Step 1: Add `'status'` to `RunIOSArgs['command']` and `RunAndroidArgs['command']` unions** (alphabetically near the end of each union; these are type-only edits).

- [ ] **Step 2: Add `'status'` to both REQUIRED lists in protocol.ts** (append after `'keyboardDismiss'` / `'dismissKeyboard'`):

```typescript
export const REQUIRED_IOS_COMMANDS = [
  'tap', 'type', 'drag', 'longPress', 'pinch', 'snapshot', 'screenshot',
  'back', 'keyboardDismiss', 'status',
] as const satisfies readonly RunIOSArgs['command'][];

export const REQUIRED_ANDROID_COMMANDS = [
  'tap', 'type', 'drag', 'longPress', 'pinch', 'snapshot', 'screenshot',
  'back', 'dismissKeyboard', 'status',
] as const satisfies readonly RunAndroidArgs['command'][];
```

- [ ] **Step 3: Run the sync + protocol test files**

Run: `corepack yarn build:core && node --test packages/rn-dev-agent-core/test/unit/gh-418-command-surface-sync.test.js packages/rn-dev-agent-core/test/unit/gh-383-protocol-sync.test.js`
Expected: PASS. If gh-418 asserts an exact expected list anywhere, update that expectation in the same commit.

- [ ] **Step 4: Run the full unit suite to catch REQUIRED-list consumers**

Run: `corepack yarn test`
Expected: PASS. Any test asserting the old 9-command lists (grep `keyboardDismiss` under `test/unit/`) gets `'status'` appended in the same commit.

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core
git commit -S -m "feat(core): Story 14 status verb joins the required runner command surface (#407)"
```

---

### Task 5: iOS client — probe-before-invalidate in postCommand

**Files:**
- Modify: `packages/rn-dev-agent-core/src/runners/rn-fast-runner-client.ts`
- Test: `packages/rn-dev-agent-core/test/unit/story-14-ios-recovery.test.js`

**Interfaces:**
- Consumes: Task 1 module.
- Produces: `interface TransportRecovery { commandId: string; outcome: 'recovered' | 'recovered-error' | 'resent' }`; internal `postCommandWithRecovery(body): Promise<{ resp: RunnerResponse; recovery?: TransportRecovery }>`. The existing `postCommand(body): Promise<RunnerResponse>` becomes a thin adapter returning `.resp`, so `fastSwipe` and every other caller keep their signature and naturally discard recovery info (multi-LLM review BLOCKER: no module-level note — it leaked across non-consuming callers and mis-attributed recoveries to later calls). `runIOS` calls `postCommandWithRecovery` and folds `recovery` into its metas. The `resent` outcome is constructed only after the resend resolves successfully.

- [ ] **Step 1: Write the failing tests**

```javascript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runIOS,
  _setFetchForTest,
  _setRunnerStateForTest,
  _setHttpTimeoutForTest,
} from '../../dist/runners/rn-fast-runner-client.js';

function state() {
  return { port: 22088, pid: 999, deviceId: 'UDID-TEST', startedAt: Date.now() };
}

function jsonReply(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  _setRunnerStateForTest(state());
  _setHttpTimeoutForTest(null);
});

test('lost tap response + probe completed → recovered result, exactly one tap sent', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'tap') throw Object.assign(new Error('socket hang up'), { name: 'FetchError' });
    assert.equal(body.command, 'status');
    assert.ok(body.commandId.length > 8);
    return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'completed', result: { ok: true, v: 1, data: { x: 10, y: 20 } } } });
  });
  const res = await runIOS({ command: 'tap', x: 10, y: 20 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['tap', 'status']);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.meta.transportRecovery.outcome, 'recovered');
});

test('lost tap + probe failed-with-result → recorded runner error surfaces', async () => {
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'failed', result: { ok: false, v: 1, error: { code: 'RUNNER_ERROR', message: 'element vanished' } } } });
  });
  const res = await runIOS({ command: 'tap', x: 1, y: 1 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /element vanished/);
});

test('lost tap + probe unknown → original transport error propagates, no resend', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'unknown' } });
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /socket hang up/);
  assert.deepEqual(sent, ['tap', 'status']);
});

test('lost snapshot + probe completed-unretained → resent once', async () => {
  const sent = [];
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.command);
    if (body.command === 'snapshot' && sent.filter((c) => c === 'snapshot').length === 1) {
      throw new Error('socket hang up');
    }
    if (body.command === 'status') {
      return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'completed' } });
    }
    return jsonReply({ ok: true, v: 1, data: { nodes: [] } });
  });
  const res = await runIOS({ command: 'snapshot' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['snapshot', 'status', 'snapshot']);
});

test('old runner: probe answered UNSUPPORTED_COMMAND → original error propagates', async () => {
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('socket hang up');
    return jsonReply({ ok: false, v: 1, error: { code: 'UNSUPPORTED_COMMAND', message: 'nope' } });
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /socket hang up/);
});

test('probe itself failing → original error propagates', async () => {
  _setFetchForTest(async (url, init) => {
    throw new Error('socket hang up');
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /socket hang up/);
});

test('pre-send failure (no runner state) → no probe attempted', async () => {
  _setRunnerStateForTest(null);
  let calls = 0;
  _setFetchForTest(async () => {
    calls += 1;
    throw new Error('unreachable');
  });
  await assert.rejects(() => runIOS({ command: 'tap', x: 1, y: 1 }), /not started/);
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `corepack yarn build:core && node --test packages/rn-dev-agent-core/test/unit/story-14-ios-recovery.test.js`
Expected: FAIL — recovery flows missing (first test throws `socket hang up` instead of recovering).

- [ ] **Step 3: Implement recovery in the iOS client**

In `rn-fast-runner-client.ts`, import from the new module (type-only imports separated per repo convention):

```typescript
import {
  decideRecovery,
  generateCommandId,
  isAmbiguousTransportFailure,
  parseStatusProbeReply,
} from './transport-recovery.js';
```

Rename the existing `postCommand` fetch mechanics to `sendCommandOnce(port, body, timeoutMs)` (identical logic; takes the timeout so the probe can pass its own 2000 ms budget). Then:

```typescript
export interface TransportRecovery {
  commandId: string;
  outcome: 'recovered' | 'recovered-error' | 'resent';
}

const STATUS_PROBE_TIMEOUT_MS = 2000;

async function probeCommandStatus(
  port: number,
  commandId: string,
): Promise<ReturnType<typeof parseStatusProbeReply>> {
  try {
    const resp = await sendCommandOnce(port, { command: 'status', commandId }, STATUS_PROBE_TIMEOUT_MS);
    return parseStatusProbeReply(resp, commandId);
  } catch {
    return null;
  }
}

// Story 14 (#407): a response lost after send is ambiguous — "never executed"
// vs "executed, response lost". One short status probe against the runner's
// outcome journal resolves it; mutating verbs are NEVER resent, and an
// unresolvable probe falls through to the existing invalidation path.
// Recovery info travels in the return value so callers that don't surface
// meta (fastSwipe, settle probes) discard it with the response.
async function postCommandWithRecovery(
  body: { command?: unknown },
): Promise<{ resp: RunnerResponse; recovery?: TransportRecovery }> {
  const state = runnerState;
  if (!state) {
    throw new Error(
      'rn-fast-runner not started — run `device_snapshot action=open appId=<your.app.id> platform=ios` first (auto-spawns the runner).',
    );
  }
  const commandId = generateCommandId();
  const timeoutMs = commandTimeoutMs(body.command);
  try {
    return { resp: await sendCommandOnce(state.port, { ...body, commandId }, timeoutMs) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isAmbiguousTransportFailure(message)) throw err;
    const decision = decideRecovery(await probeCommandStatus(state.port, commandId), body.command);
    if (decision.action === 'return-recovered') {
      return {
        resp: decision.response as RunnerResponse,
        recovery: { commandId, outcome: decision.outcome },
      };
    }
    if (decision.action === 'resend-once') {
      const resent = await sendCommandOnce(
        state.port,
        { ...body, commandId: generateCommandId() },
        timeoutMs,
      );
      return { resp: resent, recovery: { commandId, outcome: 'resent' } };
    }
    throw err;
  }
}

async function postCommand(body: { command?: unknown }): Promise<RunnerResponse> {
  return (await postCommandWithRecovery(body)).resp;
}
```

The "runner not started" guard sits OUTSIDE the try (pre-send failures are never probed); the `resent` recovery object is constructed only after the resend resolves, so a throwing resend surfaces the resend's own error with no recovery claim attached.

In `runIOS`, switch the dispatch to `const { resp, recovery } = await postCommandWithRecovery(...)` and spread `...(recovery ? { transportRecovery: recovery } : {})` into every `meta` object built in `runIOS` (the ok paths AND the `!resp.ok` failResult paths — `failResult`'s third argument accepts extra fields; add `transportRecovery: recovery` there when defined so a recovered-error is auditable).

- [ ] **Step 4: Run to verify green + no regressions**

Run: `corepack yarn build:core && node --test packages/rn-dev-agent-core/test/unit/story-14-ios-recovery.test.js` → PASS (7 tests)
Run: `corepack yarn test` → PASS (no existing iOS-client test regressions; the extra `commandId` field in wire bodies may need `deepEqual` expectations in existing tests relaxed — update them in this commit if any assert full body equality).

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core
git commit -S -m "feat(core): Story 14 iOS client status-probe recovery before invalidate (#407)"
```

---

### Task 6: Android client — probe-before-invalidate in postCommand

**Files:**
- Modify: `packages/rn-dev-agent-core/src/runners/rn-android-runner-client.ts`
- Test: `packages/rn-dev-agent-core/test/unit/story-14-android-recovery.test.js`

**Interfaces:**
- Consumes: Task 1 module. Mirrors Task 5's shape exactly (own `postCommandWithRecovery` returning `{ resp, recovery? }`, own `postCommand` adapter — module-local, not shared, matching how the two clients already duplicate `postCommand`; the settle probes `androidIsWindowUpdatingProbe`/`androidSnapshotNodesViaProbe` keep calling `postCommand` and thereby discard recovery info by construction).

- [ ] **Step 1: Write the failing tests** — same seven scenarios as Task 5 transposed to `runAndroid` + `_setAndroidRunnerStateForTest({ hostPort: 22111, pid: 999, deviceId: 'emulator-5554', startedAt: Date.now() })`, with two Android-specific additions:

```javascript
test('recovery happens before RN_ANDROID_RUNNER_DOWN mapping', async () => {
  _setFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.command === 'tap') throw new Error('fetch failed');
    return jsonReply({ ok: true, v: 1, data: { commandId: body.commandId, state: 'completed', result: { ok: true, v: 1, data: { tapped: true } } } });
  });
  const res = await runAndroid({ command: 'tap', x: 5, y: 5 });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.meta.transportRecovery.outcome, 'recovered');
});

test('unrecovered connection failure still maps to RN_ANDROID_RUNNER_DOWN', async () => {
  _setFetchForTest(async (url, init) => {
    throw new Error('fetch failed');
  });
  const res = await runAndroid({ command: 'tap', x: 5, y: 5 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RN_ANDROID_RUNNER_DOWN/);
});
```

Note: `runAndroid` calls `startAndroidRunner` on every dispatch — the tests must stub the ensure path the way existing tests do (see `android-runner-short-circuit.test.js` / `gh-243-android-runner-health.test.js` for the established seam: persisted state + `_setAndroidRunnerStateForTest` makes `shouldReuseAndroidRunner` return true so no process spawns). Follow that pattern exactly.

- [ ] **Step 2: Run to verify failures** — same command shape as Task 5.

- [ ] **Step 3: Implement** — mirror Task 5: extract `sendCommandOnce(body, timeoutMs)` from the Android `postCommand` (keeping the not-started guard outside the try, the AbortError→RUNNER_TIMEOUT mapping, the non-JSON-body error, and the v-stamp check inside `sendCommandOnce`), add the identical recovery wrapper using the Task 1 module, thread `consumeTransportRecoveryNote()` into `runAndroid`'s meta objects (ok paths and failResult extras). The slow-verb timeout stays `35_000/10_000`; the probe uses `2000`.

- [ ] **Step 4: Run to verify green + full suite**

Run: `corepack yarn build:core && node --test packages/rn-dev-agent-core/test/unit/story-14-android-recovery.test.js` → PASS
Run: `corepack yarn test` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core
git commit -S -m "feat(core): Story 14 Android client status-probe recovery before invalidate (#407)"
```

---

### Task 7: Host runtimes, changesets, full verification

**Files:**
- Regenerate: `packages/claude-plugin/scripts/rn-{fast,android}-runner/**`, `packages/codex-plugin/scripts/rn-{fast,android}-runner/**`, `packages/{claude,codex}-plugin/rn-dev-agent-core/dist/**`, `packages/rn-dev-agent-core/dist/**`
- Create: `.changeset/story-14-transport-recovery-core.md`, `.changeset/story-14-transport-recovery-ios-runner.md`, `.changeset/story-14-transport-recovery-android-runner.md`

- [ ] **Step 1: Rebuild dist + host runtimes**

```bash
corepack yarn build:host-runtimes
bash scripts/check-agent-package-sync.sh
bash scripts/check-dist-fresh.sh
```

Expected: both checks pass; git status shows regenerated mirrors.

- [ ] **Step 2: Changesets** (patch-level names must satisfy `scripts/validate-changeset-names.sh` — inspect an existing changeset for the exact frontmatter package names before writing):

```markdown
---
"rn-dev-agent-core": minor
---

Story 14 (#407): runner transport recovery — every /command carries a commandId; on an ambiguous post-send failure the client issues one short status probe against the runner's outcome journal before invalidating. Recovered results return with meta.transportRecovery; mutating verbs are never auto-resent, eliminating double-fired taps; read-only verbs may be resent once. Unresolvable probes fall through to the existing invalidation path unchanged.
```

(equivalent minor changesets for the two runner packages describing the journal + status verb.)

- [ ] **Step 3: Full verification**

```bash
corepack yarn test
corepack yarn test:native:android
bash scripts/test-native-ios.sh   # if a simulator runtime is available
npx oxlint . && npx oxfmt --check .
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -S -m "chore(story-14): host-runtime regen + changesets (#407)"
```

---

## Verification gates (from the issue's measurement gate)

1. Injected lost-response tests recover without session teardown — Tasks 5/6 test 1 (recovered result, no invalidation, no runner respawn).
2. Zero duplicated mutations across the suite — Tasks 5/6 assert exactly one `tap` wire send in every mutating-recovery scenario (`sent` arrays).
3. Diagnostics per command — `meta.transportRecovery` assertions in Tasks 5/6.

## Amendments applied from the multi-LLM plan review (2026-07-11, antigravity + codex + Claude research)

1. **BLOCKER fixed — recovery-note channel.** All three participants: a module-level `transportRecoveryNote` leaks across `postCommand` callers that never consume it (verified: iOS `fastSwipe` via device_swipe/scroll; Android settle probes in `settle.ts`), mis-attributing a probe's recovery to the next unrelated call, and the `resent` note was set before the resend could fail. Reworked to `postCommandWithRecovery` returning `{ resp, recovery? }`; `postCommand` stays as an adapter for non-consuming callers; `resent` is attached only after a successful resend.
2. Android journal cap now counts UTF-8 bytes (`toByteArray(Charsets.UTF_8).size`), matching Swift's `Data.count`; multibyte test added (codex).
3. Every Android server error path routes through a recording `errorResponse` helper + an instrumented server-path test (`NoFocusedInputException` → `status` reports `failed` with retained error body) (codex).
4. `parseStatusProbeReply` hardened: requires the reply to echo the probe's `commandId` and a retained `result` to be an object with boolean `ok` (defensive, cheap).
5. Recorded as explicitly REJECTED by the review: resending mutating commands on probe-`unknown` (would reintroduce double-fire — journal eviction/restart makes `unknown` ≠ "never executed"); reusing the same commandId on resend; a runner-side `running` state (legitimate follow-on, not in scope); concerns about keyboard-guard renaming `command` and about HTTP 200-vs-500 semantics (both disproven against source).

## Out of scope (recorded for the follow-on)

- Issue point 4: readiness-preflight skip on ≤5 s recency — explicitly a follow-on in the issue text.
- Device-level fault injection (killing the runner mid-command on a live simulator): the fake-fetch seams cover the client policy; the journal is covered by native unit tests on both platforms. A live smoke (`yarn smoke:ios` / `smoke:android`) validates the unchanged happy path if devices are available at finish time.
