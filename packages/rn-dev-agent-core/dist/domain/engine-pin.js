// GH #397 (Story 13 Phase 1): the tested maestro-runner pin. Single source of
// truth — scripts/ensure-maestro-runner.sh mirrors version+hash and a grep-sync
// test (gh-397-pin-sync.test.ts) keeps them honest.
//
// UPGRADE RITUAL (until the Story 06 golden-set harness automates it):
//   1. Install the candidate: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version <V>
//   2. Run the committed action corpus (cdp_run_e2e_suite) on iOS AND Android.
//   3. Reconcile knownQuirks (retest each listed quirk; add/remove entries).
//   4. Update version + sha256 here AND in ensure-maestro-runner.sh; add a changeset.
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getMaestroRunnerPath } from '../maestro-invoke.js';
const execFile = promisify(execFileCb);
export const MAESTRO_RUNNER_PIN = {
    version: '1.0.9',
    sha256: {
        'darwin-arm64': '7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923',
    },
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
        {
            id: 'android-pre-o-unsupported',
            ref: 'GH #741',
            note: 'bundled UiAutomator2 server APK declares minSdk 26; API 23-25 installs fail with INSTALL_FAILED_OLDER_SDK',
        },
    ],
};
// GH #741: the pinned engine's bundled appium-uiautomator2-server APK declares
// minSdk 26, so pre-O devices reject it with INSTALL_FAILED_OLDER_SDK.
export const MAESTRO_RUNNER_MIN_ANDROID_API = 26;
const PRE_O_REMEDY = 'Action replay / E2E via the maestro engine is unsupported on this device; the direct device_* ' +
    'interaction tier still works (rn-android-runner supports API 23+), except for the few device_* ' +
    'paths that fall back to maestro (dev-client picker, system dialogs, device_fill correction), ' +
    'which hit this same limit.';
function engineLabel(runner) {
    return runner === 'maestro-runner'
        ? `the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version}`
        : 'the Maestro CLI';
}
export function preOAndroidApiRefusal(apiLevel) {
    if (apiLevel >= MAESTRO_RUNNER_MIN_ANDROID_API)
        return null;
    return (`maestro_run refused: Android API ${apiLevel} is below API ${MAESTRO_RUNNER_MIN_ANDROID_API}, ` +
        `the minimum the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version} can drive — its bundled ` +
        `UiAutomator2 server APK declares minSdk ${MAESTRO_RUNNER_MIN_ANDROID_API}, so the install ` +
        `fails with INSTALL_FAILED_OLDER_SDK. ${PRE_O_REMEDY}`);
}
const OLDER_SDK_TOKEN = /INSTALL_FAILED_OLDER_SDK/g;
// The token alone is not proof: `combined` also carries the app's own console
// and logcat output, and GH #249 already burned us with a bare `FAILED` scan.
// Require the SAME LINE to read like a package-install reject once the token
// itself (which contains INSTALL/FAILED) is stripped out.
const INSTALL_REJECT_CONTEXT = /\b(?:adb|install|installing|failure|uiautomator2)\b|\.apk\b/i;
export function isOlderSdkInstallFailure(output) {
    return output
        .split(/\r?\n/)
        .some((line) => line.includes('INSTALL_FAILED_OLDER_SDK') &&
        INSTALL_REJECT_CONTEXT.test(line.replace(OLDER_SDK_TOKEN, ' ')));
}
export function olderSdkInstallDiagnosis(runner = 'maestro-runner') {
    return (`The device rejected the bundled UiAutomator2 server APK with INSTALL_FAILED_OLDER_SDK: ` +
        `${engineLabel(runner)} requires Android API ` +
        `${MAESTRO_RUNNER_MIN_ANDROID_API}+ and this device is below it. ${PRE_O_REMEDY}`);
}
export function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x > y)
            return 1;
        if (x < y)
            return -1;
    }
    return 0;
}
export function classifyEnginePin(detected, platformKey) {
    if (!detected.installed)
        return 'not-installed';
    if (!detected.version || !/^\d+(\.\d+)*$/.test(detected.version))
        return 'unknown-version';
    const cmp = compareVersions(detected.version, MAESTRO_RUNNER_PIN.version);
    if (cmp > 0)
        return 'drift-newer';
    if (cmp < 0)
        return 'drift-older';
    const expected = MAESTRO_RUNNER_PIN.sha256[platformKey];
    if (!expected || !detected.sha256)
        return 'unverified';
    if (detected.sha256 !== expected)
        return 'checksum-mismatch';
    return 'pinned-ok';
}
export function buildReplayEngineStatus(cls, version, cliPresent) {
    const engine = cls === 'not-installed' ? (cliPresent ? 'maestro-cli' : 'none') : 'maestro-runner';
    return {
        engine,
        version,
        pin: { pinned: MAESTRO_RUNNER_PIN.version, status: cls },
        quirks: MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id),
    };
}
export function enginePinCaveat(status) {
    const cls = status.pin.status;
    if (cls === 'drift-newer' || cls === 'drift-older') {
        return `maestro-runner ${status.version} differs from the tested pin ${status.pin.pinned} (untested drift — B223-class behavior changes arrive silently; see the upgrade ritual in engine-pin.ts)`;
    }
    if (cls === 'checksum-mismatch') {
        return `maestro-runner reports the pinned version ${status.pin.pinned} but its binary checksum does not match the manifest — possible corruption or tampering; reinstall via ensure-maestro-runner.sh`;
    }
    return null;
}
// GH #750 (B223-class): drifted runners translate Maestro regex text selectors
// into literal WDA `CONTAINS[c]` predicates that can never match. Only
// regex-shaped selectors change semantics; plain literals behave identically.
const REGEX_SHAPED_SELECTOR = /\.\*|\.\+|\\[dDwWsSbB]|\[[^\]]*\]|\|/;
const TEXT_SELECTOR_KEYS = new Set([
    'tapOn',
    'doubleTapOn',
    'longPressOn',
    'assertVisible',
    'assertNotVisible',
    'visible',
    'notVisible',
    'text',
]);
export function findRegexTextSelectors(commands) {
    const found = [];
    const visit = (value, underSelectorKey) => {
        if (typeof value === 'string') {
            if (underSelectorKey && REGEX_SHAPED_SELECTOR.test(value))
                found.push(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const entry of value)
                visit(entry, underSelectorKey);
            return;
        }
        if (value && typeof value === 'object') {
            for (const [key, nested] of Object.entries(value)) {
                visit(nested, TEXT_SELECTOR_KEYS.has(key));
            }
        }
    };
    visit([...commands], false);
    return found;
}
export function driftedRegexSelectorRefusal(status, commands) {
    const cls = status?.pin.status;
    if (cls !== 'drift-newer' && cls !== 'drift-older')
        return null;
    const selectors = findRegexTextSelectors(commands);
    if (selectors.length === 0)
        return null;
    return (`maestro_run refused: maestro-runner ${status.version ?? 'unknown'} drifted from the tested pin ` +
        `${status.pin.pinned} and the flow uses regex text selectors (${selectors[0]}). Drifted runners ` +
        `translate Maestro regex into a literal WDA CONTAINS predicate that can never match (B223-class, ` +
        `GH #750). Reinstall the pin via ensure-maestro-runner.sh, or rewrite the selectors as literal ` +
        `text or id selectors.`);
}
export function strictPinRefusal(status, envValue) {
    const strict = envValue === '1' || envValue === 'true';
    if (!strict || !status)
        return null;
    // Strict mode refuses PROVEN divergence only — 'unverified' (no hash shipped
    // for this platform / hashing failed) and 'unknown-version' (detection gap)
    // never refuse, or strict-mode users without a manifest hash could never run.
    const cls = status.pin.status;
    if (cls !== 'drift-newer' && cls !== 'drift-older' && cls !== 'checksum-mismatch')
        return null;
    return `maestro_run refused: RN_ENGINE_PIN_STRICT is set and the engine pin status is ${cls} (installed ${status.version ?? 'unknown'}, pinned ${status.pin.pinned}). Reinstall the pin via ensure-maestro-runner.sh, or unset RN_ENGINE_PIN_STRICT.`;
}
let cachedStatus = null;
export function _resetEngineStatusForTest() {
    cachedStatus = null;
}
export function _setEngineStatusForTest(s) {
    cachedStatus = Promise.resolve(s);
}
function defaultCliPresent() {
    const r = spawnSync('which', ['maestro'], { encoding: 'utf8', timeout: 2000 });
    return r.status === 0 && r.stdout.trim().length > 0;
}
async function defaultExecVersion(bin) {
    const { stdout, stderr } = await execFile(bin, ['--version'], {
        timeout: 5000,
        encoding: 'utf8',
    });
    return stdout + '\n' + stderr;
}
function defaultHashFile(bin) {
    return createHash('sha256').update(readFileSync(bin)).digest('hex');
}
function safeBool(fn) {
    try {
        return fn();
    }
    catch {
        return false;
    }
}
async function detect(resolvers) {
    const binPath = (resolvers.binPath ?? getMaestroRunnerPath)();
    const cliPresent = safeBool(resolvers.cliPresent ?? defaultCliPresent);
    const platformKey = resolvers.platformKey ?? `${process.platform}-${process.arch}`;
    if (!binPath) {
        return buildReplayEngineStatus('not-installed', null, cliPresent);
    }
    let version = null;
    try {
        const out = await (resolvers.execVersion ?? defaultExecVersion)(binPath);
        version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    }
    catch {
        version = null;
    }
    let sha256 = null;
    try {
        sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
    }
    catch {
        sha256 = null;
    }
    const cls = classifyEnginePin({ installed: true, version, sha256 }, platformKey);
    return buildReplayEngineStatus(cls, version, cliPresent);
}
// Single-flight, process-wide: concurrent callers (cdp_status, maestro_run)
// share one detection promise. `resolvers` exists ONLY for tests, which must
// pair it with _resetEngineStatusForTest — a resolver call after the cache is
// warm returns the cached status by design (no per-resolver keying).
export function getEngineStatus(resolvers) {
    if (!cachedStatus) {
        cachedStatus = detect(resolvers ?? {}).catch(() => buildReplayEngineStatus('unknown-version', null, false));
    }
    return cachedStatus;
}
