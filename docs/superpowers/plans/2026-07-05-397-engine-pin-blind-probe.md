# Story 13 (#397) PR 1 — Engine Pin + Proactive Blind-Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the tested maestro-runner version (manifest + installer + drift warnings + doctor/`cdp_status` surfacing) and add a proactive blind-probe so at-risk iOS replays skip the doomed ~40s WDA attempt and route straight to the CDP/JS fallback.

**Architecture:** A pure domain module (`engine-pin.ts`) classifies installed-vs-pinned engine state, consumed by `cdp_status`, `maestro_run` (warn-once caveat), and the installer (shell constant kept honest by a grep-sync test — D1292 pattern). A second pure domain module (`blind-probe-gate.ts`) evaluates the iOS-only at-risk gate from run history + runtime major; `cdp_run_action` consults it BEFORE the first maestro attempt and reuses the existing `probeTreeWithRetry` + `runCdpReplay` fallback machinery. Everything fails open to today's behavior.

**Tech Stack:** TypeScript (Node >= 22), node:test + assert/strict (tests import from `../../dist/`), bash (installer), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-05-397-maestro-engine-pin-blind-probe-design.md`

## Global Constraints

- Pin values (copy verbatim): version `1.0.9`; sha256 `darwin-arm64` = `7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923`.
- Fail-open on RUNTIME/SESSION paths: detection error ⇒ `unknown-version`; missing platform hash ⇒ skip checksum; simctl failure ⇒ the `ios26` clause resolves null (the history latch still applies under explicit `platform: 'ios'` + a strict device-matched recent record — deliberate: that is independent evidence); CDP down ⇒ maestro path. No new blocking failure modes in a running session. Two DELIBERATE exceptions, both non-session: the installer fails closed on a fresh-download checksum mismatch (Task 3), and `RN_ENGINE_PIN_STRICT=1` is an opt-in runtime refusal (Task 5).
- Test snippets in this plan are illustrative TS: when materializing them, satisfy the repo's TS checks — explicit parameter types, no implicit `any` (e.g. `let project: ReturnType<typeof createTmpProject>`).
- Warnings once per process via existing `shouldWarnFallback()` (`tools/maestro-dispatch.ts`).
- `RunRecord` changes are additive-optional only (run-history JSON stays readable by old code).
- Blind-probe gate is iOS-only; `args.platform === 'android'` short-circuits before any lookup.
- Use explicit type imports (`import type { ... }`). No unnecessary comments. Signed commits (`git commit -S`).
- Tests: run from `scripts/cdp-bridge/` with `npm test` (builds first, then node --test). New test files: `test/unit/gh-397-*.test.ts`, importing from `../../dist/*.js`.
- Installer must stay stock-bash-3.2-safe (macOS default bash — no `declare -A`, no `${var,,}`).
- `dist/` is tracked: after the final code task, rebuild and stage dist.

## File Map

| File | Role |
|---|---|
| Create `scripts/cdp-bridge/src/domain/engine-pin.ts` | Pin manifest + pure classification + cached impure `getEngineStatus` |
| Create `scripts/cdp-bridge/src/domain/blind-probe-gate.ts` | Pure at-risk gate + simctl runtime-major parser + cached lookup |
| Modify `scripts/ensure-maestro-runner.sh` | Pinned install, drift note, checksum warn |
| Modify `scripts/cdp-bridge/src/domain/reusable-action.ts:248-264` | `RunRecord` += `deviceId?`, `blindProbe?` |
| Modify `scripts/cdp-bridge/src/tools/run-action.ts` | Proactive probe before first attempt; deviceId threading |
| Modify `scripts/cdp-bridge/src/tools/maestro-run.ts:276-304` | Engine-pin caveat rides the existing warn mechanism |
| Modify `scripts/cdp-bridge/src/tools/status.ts` + `src/types.ts:81` | `replayEngine` block on `cdp_status` |
| Modify `scripts/cdp-bridge/src/index.ts:2351,2439` | Wire `blindProbeContext` into both `createRunActionHandler` sites |
| Modify `skills/rn-setup/SKILL.md:90-100` | Doctor row: version-vs-pin + quirks |
| Modify `docs-site/src/content/docs/actions/index.mdx` | Upgrade-ritual section |
| Tests | `test/unit/gh-397-engine-pin.test.ts`, `gh-397-pin-sync.test.ts`, `gh-397-blind-probe-gate.test.ts`, `gh-397-run-action-proactive-probe.test.ts` |

---

### Task 1: Engine-pin manifest + pure classification

**Files:**
- Create: `scripts/cdp-bridge/src/domain/engine-pin.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-397-engine-pin.test.ts`

**Interfaces:**
- Produces: `MAESTRO_RUNNER_PIN`, `type EnginePinClassification`, `interface EngineDetection { installed: boolean; version: string | null; sha256: string | null }`, `compareVersions(a: string, b: string): -1 | 0 | 1`, `classifyEnginePin(detected: EngineDetection, platformKey: string): EnginePinClassification`, `interface ReplayEngineStatus { engine: 'maestro-runner' | 'maestro-cli' | 'none'; version: string | null; pin: { pinned: string; status: EnginePinClassification }; quirks: string[] }`, `buildReplayEngineStatus(cls: EnginePinClassification, version: string | null, cliPresent: boolean): ReplayEngineStatus`, `enginePinCaveat(status: ReplayEngineStatus): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/gh-397-engine-pin.test.ts
// GH #397 Phase 1 — engine pin manifest + pure classification truth table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAESTRO_RUNNER_PIN,
  classifyEnginePin,
  compareVersions,
  buildReplayEngineStatus,
  enginePinCaveat,
} from '../../dist/domain/engine-pin.js';

const KEY = 'darwin-arm64';
const PIN_HASH = MAESTRO_RUNNER_PIN.sha256[KEY];

test('gh-397: pin constant matches the tested engine', () => {
  assert.equal(MAESTRO_RUNNER_PIN.version, '1.0.9');
  assert.match(PIN_HASH, /^[0-9a-f]{64}$/);
  const ids = MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id);
  assert.ok(ids.includes('android-hidekeyboard-noop'));
  assert.ok(ids.includes('requires-adb-on-ios'));
});

test('gh-397: compareVersions is numeric per segment', () => {
  assert.equal(compareVersions('1.0.9', '1.0.9'), 0);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.8', '1.0.9'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('gh-397: classification truth table', () => {
  const d = (v: string | null, h: string | null, inst = true) => ({
    installed: inst,
    version: v,
    sha256: h,
  });
  assert.equal(classifyEnginePin(d(null, null, false), KEY), 'not-installed');
  assert.equal(classifyEnginePin(d(null, PIN_HASH), KEY), 'unknown-version');
  assert.equal(classifyEnginePin(d('1.1.0', 'f'.repeat(64)), KEY), 'drift-newer');
  assert.equal(classifyEnginePin(d('1.0.8', 'f'.repeat(64)), KEY), 'drift-older');
  assert.equal(classifyEnginePin(d('1.0.9', 'f'.repeat(64)), KEY), 'checksum-mismatch');
  assert.equal(classifyEnginePin(d('1.0.9', PIN_HASH), KEY), 'pinned-ok');
  // missing platform key ⇒ checksum check skipped (fail-open)
  assert.equal(classifyEnginePin(d('1.0.9', 'f'.repeat(64)), 'linux-x64'), 'pinned-ok');
  // null hash (hashing failed) ⇒ skipped, version match wins
  assert.equal(classifyEnginePin(d('1.0.9', null), KEY), 'pinned-ok');
});

test('gh-397: buildReplayEngineStatus picks engine + carries quirk ids', () => {
  const ok = buildReplayEngineStatus('pinned-ok', '1.0.9', true);
  assert.equal(ok.engine, 'maestro-runner');
  assert.deepEqual(ok.pin, { pinned: '1.0.9', status: 'pinned-ok' });
  assert.ok(ok.quirks.includes('android-hidekeyboard-noop'));
  assert.equal(buildReplayEngineStatus('not-installed', null, true).engine, 'maestro-cli');
  assert.equal(buildReplayEngineStatus('not-installed', null, false).engine, 'none');
});

test('gh-397: enginePinCaveat only fires on drift/checksum states', () => {
  assert.equal(enginePinCaveat(buildReplayEngineStatus('pinned-ok', '1.0.9', true)), null);
  assert.equal(enginePinCaveat(buildReplayEngineStatus('not-installed', null, true)), null);
  assert.equal(enginePinCaveat(buildReplayEngineStatus('unknown-version', null, true)), null);
  const drift = enginePinCaveat(buildReplayEngineStatus('drift-newer', '1.1.0', true));
  assert.match(drift, /1\.1\.0/);
  assert.match(drift, /1\.0\.9/);
  assert.match(drift, /untested/i);
  const bad = enginePinCaveat(buildReplayEngineStatus('checksum-mismatch', '1.0.9', true));
  assert.match(bad, /checksum/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-engine-pin.test.ts`
Expected: FAIL — `Cannot find module '../../dist/domain/engine-pin.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/engine-pin.ts
// GH #397 (Story 13 Phase 1): the tested maestro-runner pin. Single source of
// truth — scripts/ensure-maestro-runner.sh mirrors version+hash and a grep-sync
// test (gh-397-pin-sync.test.ts) keeps them honest (D1292 pattern).
//
// UPGRADE RITUAL (until the Story 06 golden-set harness automates it):
//   1. Install the candidate: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version <V>
//   2. Run the committed action corpus (cdp_run_e2e_suite) on iOS AND Android.
//   3. Reconcile knownQuirks (retest each listed quirk; add/remove entries).
//   4. Update version + sha256 here AND in ensure-maestro-runner.sh; add a changeset.

export const MAESTRO_RUNNER_PIN = {
  version: '1.0.9',
  sha256: {
    'darwin-arm64': '7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923',
  } as Partial<Record<string, string>>,
  knownQuirks: [
    {
      id: 'android-hidekeyboard-noop',
      ref: 'B223 / #369',
      note: 'hideKeyboard reports pass in ~5ms on Android; keyboard stays up',
    },
    {
      id: 'requires-adb-on-ios',
      ref: 'B59',
      note: 'requires adb in PATH even with --platform ios',
    },
  ],
} as const;

export type EnginePinClassification =
  | 'pinned-ok'
  | 'drift-newer'
  | 'drift-older'
  | 'checksum-mismatch'
  | 'unknown-version'
  | 'not-installed';

export interface EngineDetection {
  installed: boolean;
  version: string | null;
  sha256: string | null;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function classifyEnginePin(
  detected: EngineDetection,
  platformKey: string,
): EnginePinClassification {
  if (!detected.installed) return 'not-installed';
  if (!detected.version) return 'unknown-version';
  const cmp = compareVersions(detected.version, MAESTRO_RUNNER_PIN.version);
  if (cmp > 0) return 'drift-newer';
  if (cmp < 0) return 'drift-older';
  const expected = MAESTRO_RUNNER_PIN.sha256[platformKey];
  if (expected && detected.sha256 && detected.sha256 !== expected) return 'checksum-mismatch';
  return 'pinned-ok';
}

export interface ReplayEngineStatus {
  engine: 'maestro-runner' | 'maestro-cli' | 'none';
  version: string | null;
  pin: { pinned: string; status: EnginePinClassification };
  quirks: string[];
}

export function buildReplayEngineStatus(
  cls: EnginePinClassification,
  version: string | null,
  cliPresent: boolean,
): ReplayEngineStatus {
  const engine = cls === 'not-installed' ? (cliPresent ? 'maestro-cli' : 'none') : 'maestro-runner';
  return {
    engine,
    version,
    pin: { pinned: MAESTRO_RUNNER_PIN.version, status: cls },
    quirks: MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id),
  };
}

export function enginePinCaveat(status: ReplayEngineStatus): string | null {
  const { status: cls } = status.pin;
  if (cls === 'drift-newer' || cls === 'drift-older') {
    return `maestro-runner ${status.version} differs from the tested pin ${status.pin.pinned} (untested drift — B223-class behavior changes arrive silently; see the upgrade ritual in engine-pin.ts)`;
  }
  if (cls === 'checksum-mismatch') {
    return `maestro-runner reports the pinned version ${status.pin.pinned} but its binary checksum does not match the manifest — possible corruption or tampering; reinstall via ensure-maestro-runner.sh`;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-engine-pin.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/engine-pin.ts scripts/cdp-bridge/test/unit/gh-397-engine-pin.test.ts
git commit -S -m "feat(engine-pin): maestro-runner pin manifest + pure classification (#397 P1)"
```

---

### Task 2: `getEngineStatus` — cached detection with injected resolvers

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/engine-pin.ts` (append)
- Test: `scripts/cdp-bridge/test/unit/gh-397-engine-pin.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `classifyEnginePin`, `buildReplayEngineStatus`.
- Produces: `interface EngineStatusResolvers { binPath?: () => string | null; execVersion?: (bin: string) => Promise<string>; hashFile?: (bin: string) => string | null; cliPresent?: () => boolean; platformKey?: string }`, `getEngineStatus(resolvers?: EngineStatusResolvers): Promise<ReplayEngineStatus>` (process-cached), `_resetEngineStatusForTest(): void`, `_setEngineStatusForTest(s: ReplayEngineStatus): void`.

- [ ] **Step 1: Write the failing test (append to gh-397-engine-pin.test.ts)**

```ts
import {
  getEngineStatus,
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
} from '../../dist/domain/engine-pin.js';

test('gh-397: getEngineStatus detects via injected resolvers and caches', async () => {
  _resetEngineStatusForTest();
  let execCalls = 0;
  const resolvers = {
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      execCalls++;
      return 'maestro-runner 1.0.9\n  Commit:  c25dc55';
    },
    hashFile: () => PIN_HASH,
    cliPresent: () => false,
    platformKey: KEY,
  };
  const s1 = await getEngineStatus(resolvers);
  assert.equal(s1.pin.status, 'pinned-ok');
  assert.equal(s1.version, '1.0.9');
  const s2 = await getEngineStatus(resolvers);
  assert.equal(execCalls, 1, 'second call must hit the cache');
  assert.equal(s2, s1);
});

test('gh-397: getEngineStatus fails open on resolver errors', async () => {
  _resetEngineStatusForTest();
  const s = await getEngineStatus({
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      throw new Error('spawn failure');
    },
    hashFile: () => {
      throw new Error('EACCES');
    },
    cliPresent: () => true,
    platformKey: KEY,
  });
  assert.equal(s.pin.status, 'unknown-version');
  assert.equal(s.engine, 'maestro-runner');
  _resetEngineStatusForTest();
});

test('gh-397: _setEngineStatusForTest seeds the cache (for maestro-run tests)', async () => {
  _resetEngineStatusForTest();
  const seeded = buildReplayEngineStatus('drift-newer', '1.1.0', false);
  _setEngineStatusForTest(seeded);
  assert.equal(await getEngineStatus(), seeded);
  _resetEngineStatusForTest();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-engine-pin.test.ts`
Expected: FAIL — `getEngineStatus` not exported

- [ ] **Step 3: Write minimal implementation (append to engine-pin.ts)**

```ts
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getMaestroRunnerPath } from '../maestro-invoke.js';

const execFile = promisify(execFileCb);

export interface EngineStatusResolvers {
  binPath?: () => string | null;
  execVersion?: (bin: string) => Promise<string>;
  hashFile?: (bin: string) => string | null;
  cliPresent?: () => boolean;
  platformKey?: string;
}

let cachedStatus: Promise<ReplayEngineStatus> | null = null;

export function _resetEngineStatusForTest(): void {
  cachedStatus = null;
}

export function _setEngineStatusForTest(s: ReplayEngineStatus): void {
  cachedStatus = Promise.resolve(s);
}

function defaultCliPresent(): boolean {
  const r = spawnSync('which', ['maestro'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

async function detect(resolvers: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  const binPath = (resolvers.binPath ?? getMaestroRunnerPath)();
  const cliPresent = safeBool(resolvers.cliPresent ?? defaultCliPresent);
  const platformKey = resolvers.platformKey ?? `${process.platform}-${process.arch}`;
  if (!binPath) {
    return buildReplayEngineStatus('not-installed', null, cliPresent);
  }
  let version: string | null = null;
  try {
    const out = await (resolvers.execVersion ??
      (async (bin: string) => {
        const { stdout, stderr } = await execFile(bin, ['--version'], {
          timeout: 5000,
          encoding: 'utf8',
        });
        return stdout + '\n' + stderr;
      }))(binPath);
    version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    version = null;
  }
  let sha256: string | null = null;
  try {
    sha256 = (resolvers.hashFile ??
      ((bin: string) => createHash('sha256').update(readFileSync(bin)).digest('hex')))(binPath);
  } catch {
    sha256 = null;
  }
  const cls = classifyEnginePin({ installed: true, version, sha256 }, platformKey);
  return buildReplayEngineStatus(cls, version, cliPresent);
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

export function getEngineStatus(resolvers?: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  if (!cachedStatus) {
    cachedStatus = detect(resolvers ?? {}).catch(() =>
      buildReplayEngineStatus('unknown-version', null, false),
    );
  }
  return cachedStatus;
}
```

NOTE: consolidate the `node:child_process` imports into one line at the top of the file when appending (`import { execFile as execFileCb, spawnSync } from 'node:child_process';`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-engine-pin.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/engine-pin.ts scripts/cdp-bridge/test/unit/gh-397-engine-pin.test.ts
git commit -S -m "feat(engine-pin): cached getEngineStatus with fail-open detection (#397 P1)"
```

---

### Task 3: Installer pinning + shell↔TS grep-sync test

**Files:**
- Modify: `scripts/ensure-maestro-runner.sh`
- Test: `scripts/cdp-bridge/test/unit/gh-397-pin-sync.test.ts`

**Interfaces:**
- Consumes: Task 1's manifest literals (via grep, not import).
- Produces: shell constants `MAESTRO_RUNNER_PIN_VERSION`, `MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/gh-397-pin-sync.test.ts
// GH #397: the maestro-runner pin exists in TWO files — the TS manifest and
// the shell installer. Grep-sync keeps them honest (same style as
// gh-383-protocol-sync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(BRIDGE_ROOT, '..', '..');

function extract(path: string, regex: RegExp): string {
  const src = readFileSync(path, 'utf8');
  const m = src.match(regex);
  assert.ok(m, `${path} must declare the pin (${regex})`);
  return m[1];
}

test('gh-397: pin version agrees between engine-pin.ts and ensure-maestro-runner.sh', () => {
  const ts = extract(
    join(BRIDGE_ROOT, 'src', 'domain', 'engine-pin.ts'),
    /version:\s*'(\d+\.\d+\.\d+)'/,
  );
  const sh = extract(
    join(REPO_ROOT, 'scripts', 'ensure-maestro-runner.sh'),
    /MAESTRO_RUNNER_PIN_VERSION="(\d+\.\d+\.\d+)"/,
  );
  assert.equal(sh, ts);
});

test('gh-397: darwin-arm64 sha256 agrees between engine-pin.ts and installer', () => {
  const ts = extract(
    join(BRIDGE_ROOT, 'src', 'domain', 'engine-pin.ts'),
    /'darwin-arm64':\s*'([0-9a-f]{64})'/,
  );
  const sh = extract(
    join(REPO_ROOT, 'scripts', 'ensure-maestro-runner.sh'),
    /MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64="([0-9a-f]{64})"/,
  );
  assert.equal(sh, ts);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-397-pin-sync.test.ts`
Expected: FAIL — installer has no `MAESTRO_RUNNER_PIN_VERSION`

- [ ] **Step 3: Modify the installer**

Replace the body of `scripts/ensure-maestro-runner.sh` from line 11 (`set -euo pipefail`) onward with:

```bash
set -euo pipefail

# GH #397: install exactly the TESTED engine version. Kept in sync with
# scripts/cdp-bridge/src/domain/engine-pin.ts by gh-397-pin-sync.test.ts.
MAESTRO_RUNNER_PIN_VERSION="1.0.9"
MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64="7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923"

BIN="$HOME/.maestro-runner/bin/maestro-runner"

installed_version() {
  # perl alarm bounds the probe (macOS has no `timeout`; alarm survives exec) —
  # a hung binary must not stall SessionStart
  perl -e 'alarm 5; exec @ARGV' -- "$1" --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ""
}

drift_note() {
  local found="$1"
  echo "NOTE: maestro-runner $found is installed but the plugin was tested against $MAESTRO_RUNNER_PIN_VERSION."
  echo "Untested drift can change replay behavior silently (B223-class)."
  echo "To install the pinned version: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version $MAESTRO_RUNNER_PIN_VERSION"
}

# Check if maestro-runner is already in PATH
if command -v maestro-runner &>/dev/null; then
  V=$(installed_version "$(command -v maestro-runner)")
  if [ -n "$V" ] && [ "$V" != "$MAESTRO_RUNNER_PIN_VERSION" ]; then
    drift_note "$V"
  fi
  exit 0
fi

# Check common install location
if [ -x "$BIN" ]; then
  echo "maestro-runner found at ~/.maestro-runner/bin/ but not in PATH."
  echo "Add to PATH: export PATH=\"\$HOME/.maestro-runner/bin:\$PATH\""
  V=$(installed_version "$BIN")
  if [ -n "$V" ] && [ "$V" != "$MAESTRO_RUNNER_PIN_VERSION" ]; then
    drift_note "$V"
  fi
  exit 0
fi

# Not installed — install the pinned version
echo ""
echo "maestro-runner is not installed. It enables full E2E testing:"
echo "  - Tap buttons, type in inputs, swipe, scroll via testIDs"
echo "  - Assert UI visibility before CDP state checks"
echo "  - Generate CI-ready Maestro YAML test files"
echo ""
echo "Installing maestro-runner $MAESTRO_RUNNER_PIN_VERSION (pinned, ~24MB)..."

if curl -fsSL --connect-timeout 10 --max-time 90 https://open.devicelab.dev/install/maestro-runner | bash -s -- --version "$MAESTRO_RUNNER_PIN_VERSION" 2>&1; then
  echo ""
  echo "maestro-runner installed successfully."
  if [ -x "$BIN" ]; then
    VERSION=$(installed_version "$BIN")
    echo "Version: ${VERSION:-unknown}"
    echo "Location: $BIN"
    # Checksum verification (darwin-arm64 only; other platforms verified TS-side).
    # FAIL CLOSED on a fresh download: a just-installed binary that doesn't match
    # the pin is exactly what the hash exists to catch, and failing an install is
    # actionable. (Runtime detection of a pre-existing binary stays warn-only.)
    if [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] && command -v shasum &>/dev/null; then
      GOT=$(shasum -a 256 "$BIN" | cut -d' ' -f1)
      if [ "$GOT" != "$MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64" ]; then
        echo "ERROR: just-installed binary checksum does not match the pin manifest."
        echo "  expected: $MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64"
        echo "  got:      $GOT"
        echo "Removing the binary. Possible upstream re-release under the pinned version;"
        echo "verify upstream, then update the pin (engine-pin.ts + this script) if legitimate."
        rm -f "$BIN"
        exit 1
      fi
    fi
    if ! command -v maestro-runner &>/dev/null; then
      echo ""
      echo "NOTE: Add to your shell profile: export PATH=\"\$HOME/.maestro-runner/bin:\$PATH\""
    fi
  fi
  exit 0
else
  echo "maestro-runner installation failed. You can install manually:"
  echo "  curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version $MAESTRO_RUNNER_PIN_VERSION"
  echo ""
  echo "Or use Maestro CLI as fallback: brew install maestro"
  exit 1
fi
```

Keep the header comment block (lines 1–10) unchanged.

- [ ] **Step 4: Run test + shellcheck-by-hand**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-397-pin-sync.test.ts && bash -n ../ensure-maestro-runner.sh && echo SYNTAX-OK`
Expected: PASS (2 tests) + `SYNTAX-OK`

- [ ] **Step 5: Run the installer against the live install (smoke)**

Run: `bash scripts/ensure-maestro-runner.sh; echo "exit=$?"`
Expected: `exit=0`, silent or PATH note (1.0.9 already installed — no drift note)

- [ ] **Step 6: Commit**

```bash
git add scripts/ensure-maestro-runner.sh scripts/cdp-bridge/test/unit/gh-397-pin-sync.test.ts
git commit -S -m "feat(installer): pin maestro-runner install to tested version + checksum warn (#397 P1)"
```

---

### Task 4: `cdp_status.replayEngine`

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (StatusResult, ~line 81)
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (buildStatus return, ~line 165)

**Interfaces:**
- Consumes: `getEngineStatus()`, `type ReplayEngineStatus` from Task 2.
- Produces: `StatusResult.replayEngine?: ReplayEngineStatus`.

- [ ] **Step 1: Add the type**

In `src/types.ts`, inside `StatusResult` (after the `actionStore` field if present, otherwise before the closing brace):

```ts
import type { ReplayEngineStatus } from './domain/engine-pin.js';
// ... inside StatusResult:
  /** GH #397: which replay engine will run + version-vs-pin + known quirks. */
  replayEngine?: ReplayEngineStatus;
```

- [ ] **Step 2: Wire into buildStatus**

In `src/tools/status.ts`: add import `import { getEngineStatus } from '../domain/engine-pin.js';`. Near the `deviceSession` fetch (line ~96), add:

```ts
  let replayEngine: Awaited<ReturnType<typeof getEngineStatus>> | undefined;
  try {
    replayEngine = await getEngineStatus();
  } catch {
    /* fail-open: omit */
  }
```

And add `replayEngine,` to the returned object (next to `deviceSession`).

- [ ] **Step 3: Build + full typecheck**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: clean build, no TS errors

- [ ] **Step 4: Existing status tests stay green**

Run: `node --test test/unit/tool-handlers.test.js test/unit/tool-handlers-cdp2.test.js 2>&1 | tail -5`
Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/src/tools/status.ts
git commit -S -m "feat(status): replayEngine block — engine, version-vs-pin, quirks (#397 P1)"
```

---

### Task 5: Drift caveat in `maestro_run` (warn-once)

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/maestro-run.ts` (~lines 276–304)

**Interfaces:**
- Consumes: `getEngineStatus`, `enginePinCaveat` (Tasks 1–2); existing `shouldWarnFallback`, `warnResult` mechanism.

- [ ] **Step 1: Locate the caveat merge**

`maestro-run.ts:282` currently reads `const caveat = dispatch.fallbackReason ?? dispatch.degradedReason;` and line ~276 attaches `fallbackReason` to meta.

- [ ] **Step 2: Implement**

Add import `import { getEngineStatus, enginePinCaveat } from '../domain/engine-pin.js';`. Just before the caveat line:

```ts
      const engineStatus = await getEngineStatus().catch(() => null);
      const pinCaveat =
        dispatch.runner === 'maestro-runner' && engineStatus ? enginePinCaveat(engineStatus) : null;
```

Change the caveat merge to:

```ts
      const caveat = dispatch.fallbackReason ?? dispatch.degradedReason ?? pinCaveat ?? undefined;
```

And extend the meta spread (line ~276 area) with:

```ts
        ...(engineStatus && engineStatus.pin.status !== 'pinned-ok'
          ? { enginePin: engineStatus.pin }
          : {}),
```

The existing `if (caveat && shouldWarnFallback(caveat)) return warnResult(meta, caveat);` then handles warn-once with zero further changes. `pinCaveat` is `null` when the CLI fallback runs (`dispatch.runner !== 'maestro-runner'`) — the pin only describes maestro-runner.

Also implement the spec's opt-in strict mode — after `pinCaveat` is computed and BEFORE the flow executes:

```ts
      const pinStrict =
        process.env.RN_ENGINE_PIN_STRICT === '1' || process.env.RN_ENGINE_PIN_STRICT === 'true';
      if (
        pinStrict &&
        engineStatus &&
        dispatch.runner === 'maestro-runner' &&
        ['drift-newer', 'drift-older', 'checksum-mismatch'].includes(engineStatus.pin.status)
      ) {
        return failResult(
          `maestro_run refused: RN_ENGINE_PIN_STRICT is set and the engine pin status is ${engineStatus.pin.status} (installed ${engineStatus.version ?? 'unknown'}, pinned ${engineStatus.pin.pinned}). Reinstall the pin via ensure-maestro-runner.sh, or unset RN_ENGINE_PIN_STRICT.`,
          'ENGINE_PIN_MISMATCH' as ToolErrorCode,
        );
      }
```

(If `ToolErrorCode` is a closed union, add `'ENGINE_PIN_MISMATCH'`.) Unit-test the refusal by seeding `_setEngineStatusForTest(buildReplayEngineStatus('drift-newer', '1.1.0', false))` + setting the env var in-test (restore both in `afterEach`), asserting the handler returns the refusal before any flow execution; `unknown-version`/`not-installed` do NOT refuse (strict mode gates proven drift, not detection gaps).

Then immunize the existing maestro-run tests against the machine's real installed engine (the un-injected `getEngineStatus()` would otherwise run live detection inside them, flipping `okResult → warnResult` on any dev/CI box with a drifted local runner): find the suites that exercise the maestro-runner dispatch path (`grep -ln "maestro-run\|maestro_run" test/unit/*.test.*`) and add to each:

```js
import {
  _setEngineStatusForTest,
  _resetEngineStatusForTest,
  buildReplayEngineStatus,
} from '../../dist/domain/engine-pin.js';

beforeEach(() => _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', '1.0.9', false)));
afterEach(() => _resetEngineStatusForTest());
```

- [ ] **Step 3: Build + existing maestro-run tests green**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/*.test.js 2>&1 | tail -5`
Expected: build clean; suite PASS (the caveat path is covered by existing dispatch-fallback tests; the pure `enginePinCaveat` truth table was Task 1)

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp-bridge/src/tools/maestro-run.ts
git commit -S -m "feat(maestro-run): engine-pin drift caveat rides the warn-once mechanism (#397 P1)"
```

---

### Task 6: `RunRecord` additive fields + pure blind-probe gate

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/reusable-action.ts:248-264`
- Create: `scripts/cdp-bridge/src/domain/blind-probe-gate.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-397-blind-probe-gate.test.ts`

**Interfaces:**
- Produces: `RunRecord.deviceId?: string`, `RunRecord.blindProbe?: { atRisk: 'ios26' | 'prior-transport-blind'; skippedMaestro: boolean }`; `type BlindProbeAtRisk = 'ios26' | 'prior-transport-blind'`; `evaluateBlindProbeGate(input: { platform: 'ios' | 'android' | undefined; iosRuntimeMajor: number | null; deviceId: string | null; runHistory: readonly RunRecord[] }): { atRisk: BlindProbeAtRisk | null }`; `parseIosRuntimeMajorForUdid(simctlJson: unknown, udid: string): number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/gh-397-blind-probe-gate.test.ts
// GH #397 Phase 2 — iOS-only at-risk gate truth table + simctl runtime parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBlindProbeGate,
  parseIosRuntimeMajorForUdid,
} from '../../dist/domain/blind-probe-gate.js';

const REC = (over = {}) => ({
  timestamp: '2026-07-01T00:00:00Z',
  durationMs: 1000,
  status: 'fail',
  failureCode: 'TRANSPORT_BLIND',
  trigger: 'agent',
  ...over,
});

test('gh-397: android never at-risk', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'android',
      iosRuntimeMajor: 26,
      deviceId: 'X',
      runHistory: [REC()],
    }).atRisk,
    null,
  );
});

test('gh-397: iOS >= 26 runtime is at-risk regardless of history', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 26,
      deviceId: 'X',
      runHistory: [],
    }).atRisk,
    'ios26',
  );
  assert.equal(
    evaluateBlindProbeGate({
      platform: undefined,
      iosRuntimeMajor: 27,
      deviceId: 'X',
      runHistory: [],
    }).atRisk,
    'ios26',
  );
});

test('gh-397: iOS 18 with no history is NOT at-risk (healthy path untouched)', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId: 'X',
      runHistory: [REC({ failureCode: 'SELECTOR_NOT_FOUND' })],
    }).atRisk,
    null,
  );
});

test('gh-397: history latch requires a STRICT deviceId match', () => {
  const gate = (recOver, deviceId) =>
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId,
      runHistory: [REC(recOver)],
    }).atRisk;
  assert.equal(gate({ deviceId: 'X' }, 'X'), 'prior-transport-blind');
  assert.equal(gate({ deviceId: 'Y' }, 'X'), null, 'other device never latches');
  assert.equal(gate({}, 'X'), null, 'pre-upgrade record without deviceId never latches');
  assert.equal(gate({ deviceId: 'X' }, null), null, 'unknown live device never latches');
});

test('gh-397: latch recency + reset semantics (bounded window, clean-pass reset)', () => {
  const hist = (...recs) =>
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId: 'X',
      runHistory: recs,
    }).atRisk;
  const TB = REC({ deviceId: 'X' });
  const MAESTRO_PASS = REC({ status: 'pass', failureCode: undefined, deviceId: 'X' });
  const CDPJS_PASS = REC({
    status: 'pass',
    failureCode: undefined,
    transport: 'cdp-js',
    deviceId: 'X',
  });
  const NEUTRAL = REC({ failureCode: 'SELECTOR_NOT_FOUND', deviceId: 'X' });
  assert.equal(hist(TB, MAESTRO_PASS), null, 'clean maestro pass clears the latch');
  assert.equal(hist(MAESTRO_PASS, TB), 'prior-transport-blind', 'TB after the pass latches');
  assert.equal(hist(TB, CDPJS_PASS), 'prior-transport-blind', 'cdp-js pass does not clear');
  assert.equal(
    hist(TB, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL),
    null,
    'TB ages out of the 5-record window',
  );
  assert.equal(
    hist(TB, NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL),
    'prior-transport-blind',
    'TB still inside the window latches',
  );
});

test('gh-397: platform undefined with no runtime evidence never latches (fail-open)', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: undefined,
      iosRuntimeMajor: null,
      deviceId: 'X',
      runHistory: [REC({ deviceId: 'X' })],
    }).atRisk,
    null,
  );
});

test('gh-397: null runtime major (lookup failed) is fail-open not-at-risk', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: null,
      deviceId: null,
      runHistory: [],
    }).atRisk,
    null,
  );
});

test('gh-397: parseIosRuntimeMajorForUdid finds the runtime key holding the udid', () => {
  const json = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ udid: 'AAA', state: 'Booted' }],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'BBB', state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'CCC' }],
    },
  };
  assert.equal(parseIosRuntimeMajorForUdid(json, 'AAA'), 18);
  assert.equal(parseIosRuntimeMajorForUdid(json, 'BBB'), 26);
  assert.equal(parseIosRuntimeMajorForUdid(json, 'CCC'), null, 'watchOS is not iOS');
  assert.equal(parseIosRuntimeMajorForUdid(json, 'ZZZ'), null);
  assert.equal(parseIosRuntimeMajorForUdid(null, 'AAA'), null);
  assert.equal(parseIosRuntimeMajorForUdid({ devices: 'garbage' }, 'AAA'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-blind-probe-gate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

In `reusable-action.ts`, three changes:

(a) Extend `RunRecord` (after `transport?: 'cdp-js';`):

```ts
  /** GH #397: simulator UDID / device serial the run targeted (additive, optional). */
  deviceId?: string;
  /** GH #397 Phase 2: set when the proactive blind-probe routed this run. */
  blindProbe?: { atRisk: 'ios26' | 'prior-transport-blind'; skippedMaestro: boolean };
```

(b) Add `'FALLBACK_REPLAY_FAILED'` to the `ActionFailureCode` union (line ~39). A probe-routed replay that fails never observed maestro/WDA, so recording it as `TRANSPORT_BLIND` would be false evidence — and would re-latch the gate forever. The latch treats this code as non-decisive.

(c) `shouldAutoPromoteToActive` (line ~454) gains a guard as its first line, so a cdp-js-only probe-routed pass can never promote `experimental → active` (promotion must mean "validated on the full engine"; the reactive path is unchanged):

```ts
  if (record.blindProbe?.skippedMaestro) return false;
```

Add both behaviors to the test file:

```ts
import { shouldAutoPromoteToActive } from '../../dist/domain/reusable-action.js';

test('gh-397: probe-routed cdp-js passes never auto-promote', () => {
  const meta = { status: 'experimental' };
  const pass = REC({ status: 'pass', failureCode: undefined });
  assert.equal(shouldAutoPromoteToActive(meta, pass), true, 'baseline promotion intact');
  assert.equal(
    shouldAutoPromoteToActive(meta, {
      ...pass,
      transport: 'cdp-js',
      blindProbe: { atRisk: 'ios26', skippedMaestro: true },
    }),
    false,
  );
});

test('gh-397: FALLBACK_REPLAY_FAILED is non-decisive for the latch', () => {
  assert.equal(
    evaluateBlindProbeGate({
      platform: 'ios',
      iosRuntimeMajor: 18,
      deviceId: 'X',
      runHistory: [
        REC({ deviceId: 'X' }),
        REC({ deviceId: 'X', failureCode: 'FALLBACK_REPLAY_FAILED', transport: 'cdp-js' }),
      ],
    }).atRisk,
    'prior-transport-blind',
    'probe-routed failures neither clear nor re-set the latch',
  );
});
```

NOTE: check `shouldAutoPromoteToActive`'s real signature at reusable-action.ts:454 before writing the test — if it takes `(metadata: M7Metadata, record: RunRecord)` with more required metadata fields, build a minimal valid metadata fixture instead of `{ status: 'experimental' }`.

Create `src/domain/blind-probe-gate.ts`:

```ts
// GH #397 (Story 13 Phase 2): iOS-only at-risk gate for the proactive
// blind-probe. Pure — resolvers/exec live at the edges. Fail-open: any
// missing input resolves toward "not at risk" (today's maestro-first path).
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunRecord } from './reusable-action.js';

const execFile = promisify(execFileCb);

export type BlindProbeAtRisk = 'ios26' | 'prior-transport-blind';

export interface BlindProbeGateInput {
  platform: 'ios' | 'android' | undefined;
  iosRuntimeMajor: number | null;
  deviceId: string | null;
  runHistory: readonly RunRecord[];
}

const WDA_BLIND_MIN_IOS_MAJOR = 26;
const RECENT_WINDOW = 5;

export function evaluateBlindProbeGate(input: BlindProbeGateInput): {
  atRisk: BlindProbeAtRisk | null;
} {
  if (input.platform === 'android') return { atRisk: null };
  // iOS-only by positive evidence: explicit platform, or a successful iOS
  // runtime resolution (parseIosRuntimeMajorForUdid returns null for non-iOS
  // runtimes, so a number proves the UDID is an iOS sim). No evidence ⇒ no latch.
  if (input.platform !== 'ios' && input.iosRuntimeMajor === null) return { atRisk: null };
  if (input.iosRuntimeMajor !== null && input.iosRuntimeMajor >= WDA_BLIND_MIN_IOS_MAJOR) {
    return { atRisk: 'ios26' };
  }
  // Bounded latch over the last RECENT_WINDOW device-matching records,
  // newest-first: a clean maestro pass (transport unset) clears, TRANSPORT_BLIND
  // sets, a cdp-js pass proves nothing about WDA and is skipped — one transient
  // TRANSPORT_BLIND cannot permanently route the action through the narrower
  // cdp-js grammar. Matching is strict (both device ids present and equal), so
  // device-less pre-upgrade records never latch other devices.
  const matches = (r: RunRecord) =>
    r.deviceId !== undefined && input.deviceId !== null && r.deviceId === input.deviceId;
  const recent = input.runHistory.filter(matches).slice(-RECENT_WINDOW).reverse();
  for (const r of recent) {
    if (r.status === 'pass' && !r.transport) return { atRisk: null };
    if (r.failureCode === 'TRANSPORT_BLIND') return { atRisk: 'prior-transport-blind' };
  }
  return { atRisk: null };
}

export function parseIosRuntimeMajorForUdid(simctlJson: unknown, udid: string): number | null {
  if (!simctlJson || typeof simctlJson !== 'object') return null;
  const devices = (simctlJson as { devices?: unknown }).devices;
  if (!devices || typeof devices !== 'object') return null;
  for (const [runtimeKey, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    if (!list.some((d) => d && typeof d === 'object' && (d as { udid?: string }).udid === udid)) {
      continue;
    }
    const m = runtimeKey.match(/SimRuntime\.iOS-(\d+)/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const runtimeCache = new Map<string, number | null>();

export function _resetIosRuntimeCacheForTest(): void {
  runtimeCache.clear();
}

export async function getIosRuntimeMajorForUdid(
  udid: string,
  execFn: ExecFn = (cmd, args) => execFile(cmd, args, { timeout: 5000, encoding: 'utf8' }),
): Promise<number | null> {
  if (runtimeCache.has(udid)) return runtimeCache.get(udid) ?? null;
  let major: number | null = null;
  try {
    const { stdout } = await execFn('xcrun', ['simctl', 'list', 'devices', '--json']);
    major = parseIosRuntimeMajorForUdid(JSON.parse(stdout), udid);
  } catch {
    major = null;
  }
  runtimeCache.set(udid, major);
  return major;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-blind-probe-gate.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/reusable-action.ts scripts/cdp-bridge/src/domain/blind-probe-gate.ts scripts/cdp-bridge/test/unit/gh-397-blind-probe-gate.test.ts
git commit -S -m "feat(blind-probe): RunRecord deviceId/blindProbe fields + pure iOS at-risk gate (#397 P2)"
```

---

### Task 7: Cached runtime lookup test

**Files:**
- Test: `scripts/cdp-bridge/test/unit/gh-397-blind-probe-gate.test.ts` (append)

(Implementation shipped in Task 6 — `getIosRuntimeMajorForUdid` — this task locks its caching + fail-open behavior.)

- [ ] **Step 1: Write the failing-if-broken test (append)**

```ts
import {
  getIosRuntimeMajorForUdid,
  _resetIosRuntimeCacheForTest,
} from '../../dist/domain/blind-probe-gate.js';

test('gh-397: getIosRuntimeMajorForUdid caches per udid and fails open', async () => {
  _resetIosRuntimeCacheForTest();
  let calls = 0;
  const exec = async () => {
    calls++;
    return {
      stdout: JSON.stringify({
        devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ udid: 'U1' }] },
      }),
    };
  };
  assert.equal(await getIosRuntimeMajorForUdid('U1', exec), 26);
  assert.equal(await getIosRuntimeMajorForUdid('U1', exec), 26);
  assert.equal(calls, 1, 'second call served from cache');

  _resetIosRuntimeCacheForTest();
  const boom = async () => {
    throw new Error('no xcrun');
  };
  assert.equal(await getIosRuntimeMajorForUdid('U2', boom), null);
  _resetIosRuntimeCacheForTest();
});
```

- [ ] **Step 2: Run**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-blind-probe-gate.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/test/unit/gh-397-blind-probe-gate.test.ts
git commit -S -m "test(blind-probe): runtime lookup caching + fail-open (#397 P2)"
```

---

### Task 8: Proactive probe in `cdp_run_action`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/run-action.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-397-run-action-proactive-probe.test.ts`

**Interfaces:**
- Consumes: `evaluateBlindProbeGate` (Task 6); existing `firstReplayTestId`, `probeTreeWithRetry`, `runCdpReplay`, `persistRun`, `UnsupportedStepError`, `CdpReplayDeps`; test helpers `createTmpProject` + fixture/envelope patterns from `run-action-transport-blind.test.js`.
- Produces: `RunActionDeps.blindProbeContext?: () => Promise<{ deviceId: string | null; iosRuntimeMajor: number | null } | null>` (default `async () => null` — inert until index.ts wires it).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/gh-397-run-action-proactive-probe.test.ts
// GH #397 Phase 2 — proactive blind-probe: at-risk runs skip maestro entirely
// when the CDP anchor oracle succeeds; every other combination falls through
// to today's maestro-first behavior (fail-open).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRunActionHandler } from '../../dist/tools/run-action.js';
import { createTmpProject } from '../helpers/tmp-project.js';

let project: ReturnType<typeof createTmpProject>;
beforeEach(() => {
  project = createTmpProject();
});
afterEach(() => {
  project.cleanup();
});

function replayFixtureYaml(
  { id = 'demo', selector = 'fab-create-task' }: { id?: string; selector?: string } = {},
): string {
  return [
    'appId: com.test.app',
    '---',
    `# id: ${id}`,
    '# intent: test fixture',
    '# tags: [fixture]',
    '# mutates: false',
    '# status: experimental',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    `    id: "${selector}"`,
    '',
  ].join('\n');
}

const PASS_ENV = {
  ok: true,
  data: { passed: true, output: 'Flow PASSED', flowFile: 'x', platform: 'ios' },
};

function fakeMaestroRun(env: { ok: boolean }, counter: { calls: number }) {
  return async () => {
    counter.calls++;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(env) }],
      ...(env.ok === false ? { isError: true } : {}),
    };
  };
}

function treeWith(id: string): unknown {
  return { tree: [{ testID: id, type: 'View' }] };
}

function makeReplayDeps({ present }: { present: boolean }) {
  const pressCalls: string[] = [];
  return {
    deps: {
      pressByTestId: async (id: string): Promise<void> => {
        pressCalls.push(id);
      },
      typeByTestId: async (): Promise<void> => {},
      treeFor: async (id: string): Promise<unknown> => (present ? treeWith(id) : { tree: [] }),
      launchApp: async (): Promise<void> => {},
      settle: async (): Promise<void> => {},
    },
    pressCalls,
  };
}

function readEnvelope(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

const IOS26_CTX = async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 26 });

test('gh-397: at-risk (ios26) + anchor present → zero maestro calls, transport cdp-js, blindProbe recorded', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay, pressCalls } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, 'cdp-js');
  assert.deepEqual(env.data.blindProbe, { atRisk: 'ios26', skippedMaestro: true });
  assert.equal(counter.calls, 0, 'maestro must NOT be invoked');
  assert.deepEqual(pressCalls, ['fab-create-task']);
  const history = project.loadState('demo').runHistory;
  assert.equal(history.at(-1).transport, 'cdp-js');
  assert.equal(history.at(-1).deviceId, 'UDID-1');
  assert.deepEqual(history.at(-1).blindProbe, { atRisk: 'ios26', skippedMaestro: true });
});

test('gh-397: not at-risk (iOS 18, clean history) → maestro path exactly as today', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 18 }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, undefined);
  assert.equal(counter.calls, 1, 'maestro runs normally');
  assert.equal(project.loadState('demo').runHistory.at(-1).deviceId, 'UDID-1');
});

test('gh-397: at-risk + anchor ABSENT → falls through to maestro (fail-open)', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: false });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.equal(readEnvelope(result).data.passed, true);
  assert.equal(counter.calls, 1);
});

// Mechanism note: firstReplayTestId() normalizes the WHOLE flow and returns
// null when ANY step is unsupported, so this exercises the anchor-null
// fall-through; the UnsupportedStepError catch in the implementation is
// defensive-only and unreachable via this gate.
test('gh-397: at-risk + unsupported step grammar → falls through to maestro (fail-open, unlike reactive path)', async () => {
  const yamlWithScroll = [
    'appId: com.test.app',
    '---',
    '# id: demo',
    '# intent: test fixture',
    '# tags: [fixture]',
    '# mutates: false',
    '# status: experimental',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    '    id: "fab-create-task"',
    '- scroll',
    '',
  ].join('\n');
  project.seedAction('demo', yamlWithScroll);
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.equal(readEnvelope(result).data.passed, true);
  assert.equal(counter.calls, 1, 'unsupported grammar must not block the maestro path');
});

test('gh-397: android → context never consulted, maestro path', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  let ctxCalls = 0;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    blindProbeContext: async () => {
      ctxCalls++;
      return { deviceId: 'emulator-5554', iosRuntimeMajor: null };
    },
  });
  await handler({ actionId: 'demo', projectRoot: project.root, platform: 'android' });
  assert.equal(ctxCalls, 0);
  assert.equal(counter.calls, 1);
});

test('gh-397: prior TRANSPORT_BLIND history + anchor present → probe routes even on iOS 18', async () => {
  project.seedAction('demo', replayFixtureYaml());
  project.appendRunRecord('demo', {
    timestamp: '2026-07-01T00:00:00Z',
    durationMs: 500,
    status: 'fail',
    failureCode: 'TRANSPORT_BLIND',
    trigger: 'agent',
    deviceId: 'UDID-1',
  });
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 18 }),
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.data.transport, 'cdp-js');
  assert.deepEqual(env.data.blindProbe, { atRisk: 'prior-transport-blind', skippedMaestro: true });
  assert.equal(counter.calls, 0);
});

test('gh-397: orchestration exception still persists a RunRecord with deviceId', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const handler = createRunActionHandler({
    maestroRun: async () => {
      throw new Error('boom');
    },
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 18 }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.equal(readEnvelope(result).ok, false);
  assert.equal(project.loadState('demo').runHistory.at(-1).deviceId, 'UDID-1');
});

test('gh-397: probe-routed replay failure records FALLBACK_REPLAY_FAILED, maestro still skipped, no promotion', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  replay.pressByTestId = async () => {
    throw new Error('element unmounted');
  };
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'FALLBACK_REPLAY_FAILED');
  assert.equal(counter.calls, 0, 'the verdict came from the fallback, not maestro');
  const last = project.loadState('demo').runHistory.at(-1);
  assert.equal(last.failureCode, 'FALLBACK_REPLAY_FAILED');
  assert.equal(last.transport, 'cdp-js');
});
```

NOTE for the implementer: the `loadState` / `appendRunRecord` helpers used above do NOT exist yet. Create them in a NEW TypeScript helper `test/helpers/action-state.ts` (not in the grandfathered `tmp-project.js` — new code is TS): `loadState(projectRoot: string, id: string)` reads the action's sidecar state JSON (confirm the sidecar filename by reading `learned-actions.ts`'s save path) and `appendRunRecord(projectRoot: string, id: string, record: RunRecord)` seeds the sidecar's `runHistory`. Import them alongside `createTmpProject` and call as `loadState(project.root, 'demo')` / `appendRunRecord(project.root, 'demo', {...})` — adjust the snippet's `project.loadState(...)`/`project.appendRunRecord(...)` call sites accordingly. Mirror how `run-action-transport-blind.test.js` and `loadAction` interact with the sidecar rather than inventing a new layout.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-run-action-proactive-probe.test.ts`
Expected: FAIL — `blindProbeContext` unknown / probe never routes (transport undefined, maestro called)

- [ ] **Step 3: Implement in run-action.ts**

3a. Extend `RunActionDeps` (after `probeRetry`):

```ts
  /**
   * GH #397 Phase 2: device context for the proactive blind-probe.
   * null ⇒ gate inert (today's behavior). Production wiring in index.ts.
   */
  blindProbeContext?: () => Promise<{
    deviceId: string | null;
    iosRuntimeMajor: number | null;
  } | null>;
```

3b. In `createRunActionHandler`, next to the other defaults:

```ts
  const blindProbeContext = deps.blindProbeContext ?? (async () => null);
```

3c. Import `evaluateBlindProbeGate` and the `BlindProbeAtRisk` type:

```ts
import { evaluateBlindProbeGate } from '../domain/blind-probe-gate.js';
import type { BlindProbeAtRisk } from '../domain/blind-probe-gate.js';
```

3d-1. At HANDLER scope, immediately after `const t0 = Date.now();` and BEFORE the `try` (the outer `catch` also persists a RunRecord and must see these):

```ts
    let probeDeviceId: string | null = null;
    const withDeviceId = (r: RunRecord): RunRecord =>
      probeDeviceId ? { ...r, deviceId: probeDeviceId } : r;
```

3d-2. Inside the handler `try`, BEFORE the `First attempt` block (before `const tBeforeFirst = Date.now();`), insert:

```ts
      // GH #397 Phase 2: proactive blind-probe. On at-risk iOS runtimes
      // (>= 26, or a recent TRANSPORT_BLIND on this device) with a CDP-visible
      // anchor, skip the doomed ~40s WDA attempt and replay via CDP/JS
      // directly. Every branch fails open to the maestro-first path below.
      // Opt out globally with RN_BLIND_PROBE=0.
      let atRisk: BlindProbeAtRisk | null = null;
      const blindProbeDisabled =
        process.env.RN_BLIND_PROBE === '0' || process.env.RN_BLIND_PROBE === 'false';
      if (args.platform !== 'android' && !blindProbeDisabled) {
        const ctx = await blindProbeContext().catch(() => null);
        if (ctx) {
          probeDeviceId = ctx.deviceId;
          atRisk = evaluateBlindProbeGate({
            platform: args.platform,
            iosRuntimeMajor: ctx.iosRuntimeMajor,
            deviceId: ctx.deviceId,
            runHistory: action.state.runHistory,
          }).atRisk;
        }
      }

      if (atRisk) {
        const replayDeps = getReplayDeps(args);
        const probe = replayDeps ? firstReplayTestId(action.body, args.params ?? {}) : null;
        if (replayDeps && probe) {
          const tProbe = Date.now();
          const probeOutcome = await probeTreeWithRetry(replayDeps, probe, probeRetry);
          if (probeOutcome.found) {
            const tReplay = Date.now();
            try {
              const replay = await runCdpReplay(action.body, args.params ?? {}, replayDeps);
              const timings_ms = { probe: tReplay - tProbe, replay: Date.now() - tReplay };
              const blindProbe = { atRisk, skippedMaestro: true };
              const autoRepair: AutoRepairOutcome = {
                attempted: false,
                outcome: 'skipped',
                phases: {},
              };
              await persistRun(
                args.actionId,
                projectRoot,
                withDeviceId({
                  timestamp: new Date().toISOString(),
                  durationMs: Date.now() - t0,
                  status: replay.passed ? 'pass' : 'fail',
                  failureCode: replay.passed ? undefined : 'FALLBACK_REPLAY_FAILED',
                  failureDetail: replay.reason,
                  trigger,
                  autoRepair,
                  transport: 'cdp-js',
                  blindProbe,
                }),
              );
              if (replay.passed) {
                return okResult({
                  passed: true,
                  actionId: args.actionId,
                  transport: 'cdp-js',
                  blindProbe,
                  timings_ms,
                  autoRepair,
                  durationMs: Date.now() - t0,
                  flowFile: action.filePath,
                });
              }
              // NOT 'TRANSPORT_BLIND': maestro was never attempted, so no
              // blindness was observed — this may be app drift or a stale
              // anchor. FALLBACK_REPLAY_FAILED is non-decisive for the latch,
              // so the genuine latch record ages out and maestro gets retried.
              return failResult(
                `cdp_run_action: ${args.actionId} probe-routed to CDP/JS (at-risk: ${atRisk}) and failed at step ${replay.failedStepIndex}: ${replay.reason}. Maestro was not attempted; rerun with RN_BLIND_PROBE=0 to force the engine path.`,
                'FALLBACK_REPLAY_FAILED' as ToolErrorCode,
                {
                  actionId: args.actionId,
                  transport: 'cdp-js',
                  blindProbe,
                  timings_ms,
                  failedStepIndex: replay.failedStepIndex,
                },
              );
            } catch (e) {
              if (!(e instanceof UnsupportedStepError)) throw e;
              // Defensive only: firstReplayTestId() already returns null when
              // the flow contains ANY unsupported step (it normalizes the whole
              // flow), so this catch is normally unreachable — kept so a
              // grammar divergence can never block the maestro path below.
            }
          }
        }
      }
```

NOTE: if `ToolErrorCode` is a closed union in utils/types, add `'FALLBACK_REPLAY_FAILED'` to it instead of casting.

3e. deviceId threading: wrap the record argument of EVERY `persistRun(...)` call in the file with `withDeviceId({ ... })`. Enumerate with `grep -n "persistRun(" src/tools/run-action.ts` — the sites include: happy path, ROUTE_DRIFT, reactive cdp-js branch, repair-disabled/refused, post-repair pass/fail, the "action disappeared" defensive site (~line 591), and the OUTER `catch` site (~line 717) — the last two are outside the main flow, which is why `withDeviceId` must live at handler scope (3d-1).

3f. `RunRecord` must be imported as a type if not already: check the imports at the top of run-action.ts and extend `import type { ... } from '../domain/reusable-action.js'`.

3g. DB mirror (`src/domain/action-db.ts`): the run-record table must not silently drop the new fields (they are the routing audit trail). Read the module first and mirror its conventions, then:
- Add `device_id TEXT` and `blind_probe_json TEXT` columns to the run-record table's CREATE statement, and for pre-existing DBs run idempotent `ALTER TABLE ... ADD COLUMN` statements at open, each wrapped in a try/catch that swallows only the "duplicate column name" error.
- Extend `insertRunRecord` to write `record.deviceId ?? null` and `record.blindProbe ? JSON.stringify(record.blindProbe) : null`.
- Extend the row→RunRecord reconstruction to restore both (parse `blind_probe_json` in a try/catch; on parse failure omit the field).
- Add a round-trip test in a NEW file `test/unit/gh-397-action-db-mirror.test.ts` (new tests are TS; use `test/unit/domain/action-db.test.js` only as a pattern reference): mirror a record with `deviceId` + `blindProbe`, read back, assert both fields intact; and a record without them stays clean (no `null`-pollution of the reconstructed object).

- [ ] **Step 4: Run the new test + the two adjacent suites**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-397-run-action-proactive-probe.test.ts test/unit/run-action-transport-blind.test.js test/unit/gh-423-fallback-probe-resilience.test.js test/unit/gh-397-action-db-mirror.test.ts`
Expected: all PASS — proactive tests green, reactive fallback + probe-resilience unregressed, mirror round-trip green (no `tail` pipe — it masks the exit code)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/run-action.ts scripts/cdp-bridge/src/domain/action-db.ts scripts/cdp-bridge/test/unit/gh-397-run-action-proactive-probe.test.ts scripts/cdp-bridge/test/unit/gh-397-action-db-mirror.test.ts scripts/cdp-bridge/test/helpers/action-state.ts
git commit -S -m "feat(run-action): proactive blind-probe skips doomed WDA attempt on at-risk iOS (#397 P2)"
```

---

### Task 9: index.ts wiring + full suite + dist

**Files:**
- Modify: `scripts/cdp-bridge/src/index.ts` (both `createRunActionHandler` sites — lines ~2351 and ~2439)

**Interfaces:**
- Consumes: `foreignGateUdid` (`lifecycle/foreign-flow-gate.js`), `getIosRuntimeMajorForUdid` (Task 6), `RunActionDeps.blindProbeContext` (Task 8).

- [ ] **Step 1: Verify the UDID provider is registered**

Run: `grep -n "setForeignGateUdidProvider" scripts/cdp-bridge/src/*.ts scripts/cdp-bridge/src/**/*.ts | grep -v test`
Expected: a registration site in production code (device-session open). If the provider can return null before a device session opens, that is fine — context null ⇒ gate inert.

- [ ] **Step 2: Wire both call sites**

Add imports:

```ts
import { foreignGateUdid } from './lifecycle/foreign-flow-gate.js';
import { getIosRuntimeMajorForUdid } from './domain/blind-probe-gate.js';
```

Define once near the handlers:

```ts
const blindProbeContext = async () => {
  const udid = foreignGateUdid();
  if (!udid) return null;
  return { deviceId: udid, iosRuntimeMajor: await getIosRuntimeMajorForUdid(udid) };
};
```

Add `blindProbeContext,` to BOTH `createRunActionHandler({ ... })` calls (lines ~2351 and ~2439).

NOTE: `foreignGateUdid()` is non-null only while an iOS device session is open; with no session the context is null and the gate is inert by design (documented in the spec's Invariants). Do NOT add a `resolveIosUdid()` fallback in this PR — the oracle's `replayDeps` availability has the same session dependency, so a UDID-only fallback buys nothing; it is a PR 2 consideration.

- [ ] **Step 3: Full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: full build + all tests PASS (baseline was 2897; expect ~2915+). Do not pipe through `tail` — it masks the exit code.

- [ ] **Step 4: Stage rebuilt dist + commit**

```bash
git add scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/dist
git commit -S -m "feat(bridge): wire blind-probe context into cdp_run_action sites + dist (#397)"
```

---

### Task 10: Docs + changeset

**Files:**
- Modify: `skills/rn-setup/SKILL.md:90-100` (§4 maestro-runner)
- Modify: `docs-site/src/content/docs/actions/index.mdx` (new "Engine version pinning" section)
- Create: `.changeset/story-13-engine-pin-blind-probe.md`

- [ ] **Step 1: rn-setup §4 — add pin awareness**

After the existing version-check command block in §4, add:

````markdown
The plugin pins the tested engine version (see `scripts/cdp-bridge/src/domain/engine-pin.ts` — currently `1.0.9`). `cdp_status` → `replayEngine` reports `engine`, `version`, `pin.status` (`pinned-ok` / `drift-newer` / `drift-older` / `checksum-mismatch`), and known quirks. A drifted local install still works but is untested — reinstall the pin with:

```bash
curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version 1.0.9
```
````

- [ ] **Step 2: docs-site — upgrade ritual**

In `docs-site/src/content/docs/actions/index.mdx`, add a short section (match the page's existing heading level and prose style — read the file first):

```markdown
## Engine version pinning

Action replay runs on a pinned maestro-runner version (`1.0.9`). The pin lives in
`scripts/cdp-bridge/src/domain/engine-pin.ts` together with the engine's known quirks;
`cdp_status.replayEngine` and `/doctor` report drift. Bumping the pin follows the
upgrade ritual documented in that module: install the candidate with
`--version`, replay the committed action corpus on both platforms, reconcile the
quirks list, then update the manifest + installer (a sync test keeps them equal).
```

- [ ] **Step 3: Changeset**

```markdown
---
"rn-dev-agent": minor
---

Story 13 (#397) Phases 1–2: maestro-runner engine pinning (manifest + installer `--version` install + fail-closed fresh-install checksum + drift warn-once + opt-in `RN_ENGINE_PIN_STRICT=1` refusal + `cdp_status.replayEngine`/doctor surfacing) and a proactive blind-probe in `cdp_run_action` — at-risk iOS runtimes (>= 26, or a recent device-matched TRANSPORT_BLIND with clean-pass reset) with a CDP-visible anchor skip the doomed ~40s WDA attempt and replay via CDP/JS directly (`RunRecord.blindProbe` + additive `deviceId`, probe-routed failures classified `FALLBACK_REPLAY_FAILED`, probe-routed passes never auto-promote, opt out with `RN_BLIND_PROBE=0`).
```

NOTE: copy the exact package name from `.changeset/story-05-self-healing-taps.md` — if it differs from `rn-dev-agent`, use that.

- [ ] **Step 4: Commit**

```bash
git add skills/rn-setup/SKILL.md docs-site/src/content/docs/actions/index.mdx .changeset/story-13-engine-pin-blind-probe.md
git commit -S -m "docs: engine-pin doctor row, upgrade ritual, changeset (#397)"
```

---

### Task 11: Live device verification (workflow step 5 — after review)

Not TDD steps — the on-device gate before finishing the branch:

- [ ] iOS 18 sim + Metro up: `cdp_run_action` on a committed action → passes via maestro (no probe routing); `cdp_status` shows `replayEngine: { engine: 'maestro-runner', version: '1.0.9', pin: { status: 'pinned-ok' } }`.
- [ ] Seed a `TRANSPORT_BLIND` RunRecord (edit the action's sidecar state, set `deviceId` to the booted UDID) → re-run `cdp_run_action` → verdict in seconds via `transport: 'cdp-js'`, `blindProbe.atRisk: 'prior-transport-blind'`, zero "Building WDA" in output. Remove the seeded record after.
- [ ] Temporarily move `~/.maestro-runner/bin/maestro-runner` aside → `cdp_status.replayEngine.engine` reports `maestro-cli` or `none`; restore.
- [ ] Android emulator smoke: one `cdp_run_action` → unchanged behavior, `deviceId` absent from the new RunRecord (context is iOS-gated), no drift warnings.

---

## Self-review notes

- Spec coverage: manifest (T1), detection+cache (T2), installer+sync+fail-closed checksum (T3), status (T4), warn-once + strict mode + test immunization (T5), ritual documented (T1 header + T10), RunRecord fields + gate + promotion guard + FALLBACK_REPLAY_FAILED (T6), runtime lookup (T6/T7), probe orchestration + fail-open + env opt-out + deviceId threading + DB mirror (T8), wiring (T9), doctor/docs (T10), live acceptance (T11). The "seeded quirk fails golden set" criterion is explicitly deferred to Story 06 per the spec.
- Types consistent: `ReplayEngineStatus` (T1) consumed by T4/T5; `BlindProbeAtRisk` (T6) consumed by T8; `blindProbeContext` signature identical in T8 (definition) and T9 (wiring).
- Deliberate deviations an implementer might question: the proactive branch's `UnsupportedStepError` catch is DEFENSIVE-ONLY (unreachable via the gate, because `firstReplayTestId` returns null over any unsupported grammar — test 4 of T8 locks the anchor-null fall-through, not the catch); probe-routed failures record `FALLBACK_REPLAY_FAILED`, never `TRANSPORT_BLIND` (no blindness was observed, and the latch must not self-sustain).
- Multi-LLM plan review (2026-07-05, Codex + coordinator-verified; Antigravity unavailable) amendments applied: bounded latch with clean-pass reset + strict deviceId matching; no-promotion guard for probe-routed passes; `FALLBACK_REPLAY_FAILED`; handler-scope deviceId threading incl. outer-catch site; DB mirror columns; engine-status test seam + test immunization; installer fail-closed checksum + bounded version probe; `RN_BLIND_PROBE=0` and `RN_ENGINE_PIN_STRICT=1` env toggles; simctl timeout; TS-only test files + typed snippets; no pipe-masked build commands.
