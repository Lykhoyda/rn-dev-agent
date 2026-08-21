// GH #397 (Story 13 Phase 1): the tested maestro-runner pin.
//
// UPGRADE RITUAL (until the Story 06 golden-set harness automates it):
//   1. Install the candidate: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version <V>
//   2. Run the committed action corpus (cdp_run_e2e_suite) on iOS AND Android.
//   3. Reconcile knownQuirks (retest each listed quirk; add/remove entries).
//   4. Update version + sha256 here AND in ensure-maestro-runner.sh; add a changeset.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pinManifest from './maestro-runner-pin.json' with { type: 'json' };
const execFile = promisify(execFileCb);
export const MAESTRO_RUNNER_PIN = pinManifest;
export const ACTION_ENGINE_PIN = `maestro-runner@${MAESTRO_RUNNER_PIN.version}`;
const HOST_PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}';
export const PINNED_RUNNER_INSTALL_HINT = `bash ${HOST_PLUGIN_ROOT}/scripts/ensure-maestro-runner.sh`;
export const PINNED_RUNNER_DIAGNOSE_HINT = `node ${HOST_PLUGIN_ROOT}/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose`;
// GH #741: the pinned engine's bundled appium-uiautomator2-server APK declares
// minSdk 26, so pre-O devices reject it with INSTALL_FAILED_OLDER_SDK.
export const MAESTRO_RUNNER_MIN_ANDROID_API = 26;
const PRE_O_REMEDY = 'Action replay / E2E via the maestro engine is unsupported on this device; the direct device_* ' +
    'interaction tier still works (rn-android-runner supports API 23+), except for the few device_* ' +
    'paths that fall back to maestro (dev-client picker, system dialogs, device_fill correction), ' +
    'which hit this same limit.';
function engineLabel(_runner) {
    return `the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version}`;
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
export function pinCacheRoot(home = homedir()) {
    const override = process.env.RN_DEV_AGENT_RUNNER_CACHE;
    const base = override && override.length > 0 ? override : join(home, '.cache', 'rn-dev-agent');
    return join(base, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
}
export function pinnedRunnerBinPath(home) {
    return join(pinCacheRoot(home), 'bin', 'maestro-runner');
}
export function getMaestroRunnerPath() {
    const path = pinnedRunnerBinPath();
    return existsSync(path) ? path : null;
}
export function nodePlatformKey(platform = process.platform, arch = process.arch) {
    return `${platform}-${arch}`;
}
export function pinArchiveCoords(platformKey) {
    switch (platformKey) {
        case 'darwin-arm64':
            return { os: 'darwin', arch: 'arm64' };
        case 'darwin-x64':
            return { os: 'darwin', arch: 'amd64' };
        case 'linux-x64':
            return { os: 'linux', arch: 'amd64' };
        case 'linux-arm64':
            return { os: 'linux', arch: 'arm64' };
        default:
            return null;
    }
}
export function buildReplayEngineStatus(cls, version, _cliPresent, extras = {}) {
    // Ambient Maestro CLI is never a session engine. Missing pin-cache → none.
    const engine = cls === 'not-installed' ? 'none' : 'maestro-runner';
    return {
        engine,
        version,
        pin: { pinned: MAESTRO_RUNNER_PIN.version, status: cls },
        quirks: MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id),
        selectedPath: extras.selectedPath ?? null,
        provenance: extras.provenance ?? (cls === 'not-installed' ? 'none' : 'pin-cache'),
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
// GH #750 (B223-class): maestro-runner text selectors are regex. Any unescaped
// metacharacter — including the wildcard `.` in forms like `Log.n` — is
// unsupported here and must be rewritten as id or literal text before replay.
const REGEX_METACHARACTERS = new Set([
    '.',
    '^',
    '$',
    '*',
    '+',
    '?',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '|',
]);
export function isRegexShapedSelector(value) {
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === '\\')
            return true;
        if (REGEX_METACHARACTERS.has(ch))
            return true;
    }
    return false;
}
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
            if (underSelectorKey && isRegexShapedSelector(value))
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
    const cls = status.pin.status;
    if (cls !== 'drift-newer' && cls !== 'drift-older' && cls !== 'checksum-mismatch')
        return null;
    return `maestro_run refused: RN_ENGINE_PIN_STRICT is set and the engine pin status is ${cls} (installed ${status.version ?? 'unknown'}, pinned ${status.pin.pinned}). Reinstall the pin via ensure-maestro-runner.sh, or unset RN_ENGINE_PIN_STRICT.`;
}
export function pinCorrection(status, platformKey = nodePlatformKey()) {
    const cls = status.pin.status;
    const pinned = status.pin.pinned;
    const installed = status.version ?? 'unknown';
    const install = `Reinstall exactly ${pinned} via ${PINNED_RUNNER_INSTALL_HINT} (session pin-cache; do not use PATH or brew maestro).`;
    if (pinArchiveCoords(platformKey) === null) {
        return (`maestro-runner is unsupported on ${platformKey}. Supported platforms: darwin-arm64, darwin-x64, ` +
            `linux-x64, linux-arm64. ${install}`);
    }
    switch (cls) {
        case 'not-installed':
            return `Session maestro-runner ${pinned} is not installed. ${install}`;
        case 'drift-older':
            return `Session maestro-runner ${installed} is older than the required pin ${pinned}. ${install}`;
        case 'drift-newer':
            return `Session maestro-runner ${installed} is newer than the required pin ${pinned}. ${install}`;
        case 'checksum-mismatch':
            return `Session maestro-runner reports ${pinned} but the binary checksum does not match the pin manifest. ${install}`;
        case 'unknown-version':
            return `Session maestro-runner version could not be read. ${install}`;
        case 'unverified':
            return `Session maestro-runner ${installed} could not be checksum-verified on ${platformKey}. ${install}`;
        case 'pinned-ok':
            return `Session maestro-runner ${pinned} is selected from the pin-cache.`;
    }
}
export function exactPinRefusal(status, platformKey = nodePlatformKey()) {
    if (!status) {
        return `maestro_run refused: session runner ${MAESTRO_RUNNER_PIN.version} could not be detected. ${pinCorrection(buildReplayEngineStatus('not-installed', null, false), platformKey)}`;
    }
    if (status.pin.status === 'pinned-ok')
        return null;
    return `maestro_run refused: ${pinCorrection(status, platformKey)}`;
}
export function doctorPinnedRunner(status, platformKey = nodePlatformKey()) {
    const ok = status.pin.status === 'pinned-ok';
    return {
        ok,
        status: status.pin.status,
        pinned: status.pin.pinned,
        installedVersion: status.version,
        selectedPath: status.selectedPath ?? null,
        provenance: status.provenance ?? (status.pin.status === 'not-installed' ? 'none' : 'pin-cache'),
        correction: ok ? null : pinCorrection(status, platformKey),
    };
}
let testStatus;
export function _resetEngineStatusForTest() {
    testStatus = undefined;
}
export function _setEngineStatusForTest(s) {
    testStatus = s;
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
async function detect(resolvers) {
    const binPath = (resolvers.binPath ?? getMaestroRunnerPath)();
    const platformKey = resolvers.platformKey ?? nodePlatformKey();
    if (!binPath) {
        return buildReplayEngineStatus('not-installed', null, false, {
            selectedPath: null,
            provenance: 'none',
        });
    }
    let sha256 = null;
    try {
        sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
    }
    catch {
        sha256 = null;
    }
    let version = null;
    try {
        const out = await (resolvers.execVersion ?? defaultExecVersion)(binPath);
        version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    }
    catch {
        version = null;
    }
    const cls = classifyEnginePin({ installed: true, version, sha256 }, platformKey);
    return buildReplayEngineStatus(cls, version, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
    });
}
export function getEngineStatus(resolvers) {
    if (testStatus)
        return Promise.resolve(testStatus);
    return detect(resolvers ?? {}).catch(() => buildReplayEngineStatus('unknown-version', null, false));
}
