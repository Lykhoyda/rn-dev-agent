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
import { accessSync, constants, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import pinManifest from './maestro-runner-pin.json' with { type: 'json' };

const execFile = promisify(execFileCb);

interface MaestroRunnerPinManifest {
  readonly version: string;
  readonly sha256: Readonly<Partial<Record<string, string>>>;
  readonly knownQuirks: ReadonlyArray<Readonly<{ id: string; ref: string; note: string }>>;
}

export const MAESTRO_RUNNER_PIN: MaestroRunnerPinManifest = Object.freeze({
  version: pinManifest.version,
  sha256: Object.freeze({ ...pinManifest.sha256 }),
  knownQuirks: Object.freeze(pinManifest.knownQuirks.map((quirk) => Object.freeze({ ...quirk }))),
});

const TRUSTED_DRIFT_SHA256 = Object.freeze({
  '1.0.9': Object.freeze({
    'darwin-arm64': '7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923',
    'darwin-x64': '36f8a973c3231b6b8125db4a3e131b8c3193aec6774145584b18070be979fd5f',
    'linux-arm64': 'a8e8197c63502fba874ce69b908174d46a47c6539025184e3003e70576d9451e',
    'linux-x64': 'bf7e9ef297c35712e9fad0ad56a65b7fd94e1f30168733cf09459b4ea80c4c3e',
  }),
});

export const ACTION_ENGINE_PIN = `maestro-runner@${MAESTRO_RUNNER_PIN.version}` as const;

const HOST_PLUGIN_ROOT =
  '${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}';

export const PINNED_RUNNER_INSTALL_HINT =
  `bash ${HOST_PLUGIN_ROOT}/scripts/ensure-maestro-runner.sh` as const;

export const PINNED_RUNNER_DIAGNOSE_HINT =
  `node ${HOST_PLUGIN_ROOT}/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose` as const;

// GH #741: the pinned engine's bundled appium-uiautomator2-server APK declares
// minSdk 26, so pre-O devices reject it with INSTALL_FAILED_OLDER_SDK.
export const MAESTRO_RUNNER_MIN_ANDROID_API = 26;

const PRE_O_REMEDY =
  'Action replay / E2E via the maestro engine is unsupported on this device; the direct device_* ' +
  'interaction tier still works (rn-android-runner supports API 23+), except for the few device_* ' +
  'paths that fall back to maestro (dev-client picker, system dialogs, device_fill correction), ' +
  'which hit this same limit.';

export type ReplayEngineTier = 'maestro-runner' | 'maestro' | 'maestro-cli';

function engineLabel(_runner: ReplayEngineTier): string {
  return `the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version}`;
}

export function preOAndroidApiRefusal(apiLevel: number): string | null {
  if (apiLevel >= MAESTRO_RUNNER_MIN_ANDROID_API) return null;
  return (
    `maestro_run refused: Android API ${apiLevel} is below API ${MAESTRO_RUNNER_MIN_ANDROID_API}, ` +
    `the minimum the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version} can drive — its bundled ` +
    `UiAutomator2 server APK declares minSdk ${MAESTRO_RUNNER_MIN_ANDROID_API}, so the install ` +
    `fails with INSTALL_FAILED_OLDER_SDK. ${PRE_O_REMEDY}`
  );
}

const OLDER_SDK_TOKEN = /INSTALL_FAILED_OLDER_SDK/g;
// The token alone is not proof: `combined` also carries the app's own console
// and logcat output, and GH #249 already burned us with a bare `FAILED` scan.
// Require the SAME LINE to read like a package-install reject once the token
// itself (which contains INSTALL/FAILED) is stripped out.
const INSTALL_REJECT_CONTEXT = /\b(?:adb|install|installing|failure|uiautomator2)\b|\.apk\b/i;

export function isOlderSdkInstallFailure(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some(
      (line) =>
        line.includes('INSTALL_FAILED_OLDER_SDK') &&
        INSTALL_REJECT_CONTEXT.test(line.replace(OLDER_SDK_TOKEN, ' ')),
    );
}

export function olderSdkInstallDiagnosis(runner: ReplayEngineTier = 'maestro-runner'): string {
  return (
    `The device rejected the bundled UiAutomator2 server APK with INSTALL_FAILED_OLDER_SDK: ` +
    `${engineLabel(runner)} requires Android API ` +
    `${MAESTRO_RUNNER_MIN_ANDROID_API}+ and this device is below it. ${PRE_O_REMEDY}`
  );
}

export type EnginePinClassification =
  | 'pinned-ok'
  | 'unverified'
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
  if (!detected.version || !/^\d+(\.\d+)*$/.test(detected.version)) return 'unknown-version';
  const cmp = compareVersions(detected.version, MAESTRO_RUNNER_PIN.version);
  if (cmp > 0) return 'drift-newer';
  if (cmp < 0) return 'drift-older';
  const expected = MAESTRO_RUNNER_PIN.sha256[platformKey];
  if (!expected || !detected.sha256) return 'unverified';
  if (detected.sha256 !== expected) return 'checksum-mismatch';
  return 'pinned-ok';
}

export type RunnerProvenance = 'pin-cache' | 'none';

export interface ReplayEngineStatus {
  engine: 'maestro-runner' | 'maestro-cli' | 'none';
  version: string | null;
  pin: { pinned: string; status: EnginePinClassification };
  quirks: string[];
  selectedPath?: string | null;
  provenance?: RunnerProvenance;
}

export function pinCacheRoot(home = homedir()): string {
  const override = process.env.RN_DEV_AGENT_RUNNER_CACHE;
  const base = override && override.length > 0 ? override : join(home, '.cache', 'rn-dev-agent');
  return join(base, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
}

export function pinnedRunnerBinPath(home?: string): string {
  return join(pinCacheRoot(home), 'bin', 'maestro-runner');
}

function isRegularPinCacheBinary(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const ancestors = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))];
    const contained = ancestors.every((ancestor) => {
      const ancestorStat = lstatSync(ancestor);
      return ancestorStat.isDirectory() && !ancestorStat.isSymbolicLink();
    });
    accessSync(path, constants.X_OK);
    return contained && stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function getMaestroRunnerPath(): string | null {
  const path = pinnedRunnerBinPath();
  return isRegularPinCacheBinary(path) ? path : null;
}

function runnerCacheVersionsRoot(): string {
  return dirname(pinCacheRoot());
}

function pinCacheVersionForPath(path: string): string | null {
  if (!isRegularPinCacheBinary(path) || basename(path) !== 'maestro-runner') return null;
  const versionDir = dirname(dirname(resolve(path)));
  if (dirname(versionDir) !== resolve(runnerCacheVersionsRoot())) return null;
  const version = basename(versionDir);
  return /^\d+(?:\.\d+)*$/.test(version) ? version : null;
}

function getMaestroRunnerDetectionPath(): string | null {
  const exact = getMaestroRunnerPath();
  if (exact) return exact;
  const root = runnerCacheVersionsRoot();
  try {
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name))
      .map((entry) => ({
        version: entry.name,
        path: join(root, entry.name, 'bin', 'maestro-runner'),
      }))
      .filter((candidate) => isRegularPinCacheBinary(candidate.path))
      .sort((left, right) => compareVersions(right.version, left.version));
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function nodePlatformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function pinArchiveCoords(
  platformKey: string,
): { os: 'darwin' | 'linux'; arch: 'arm64' | 'amd64' } | null {
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

export function buildReplayEngineStatus(
  cls: EnginePinClassification,
  version: string | null,
  _cliPresent: boolean,
  extras: { selectedPath?: string | null; provenance?: RunnerProvenance } = {},
): ReplayEngineStatus {
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

export function enginePinCaveat(status: ReplayEngineStatus): string | null {
  const cls = status.pin.status;
  if (cls === 'drift-newer' || cls === 'drift-older') {
    return `maestro-runner ${status.version} differs from the tested pin ${status.pin.pinned} (untested drift — B223-class behavior changes arrive silently; see the upgrade ritual in engine-pin.ts)`;
  }
  if (cls === 'checksum-mismatch') {
    return `maestro-runner pin-cache binary checksum does not match the ${status.pin.pinned} manifest — possible corruption or tampering; reinstall via ensure-maestro-runner.sh`;
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

export function isRegexShapedSelector(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === '\\') return true;
    if (REGEX_METACHARACTERS.has(ch)) return true;
  }
  return false;
}

const TEXT_SELECTOR_KEYS = new Set([
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'assertVisible',
  'assertNotVisible',
  'copyTextFrom',
]);

const RELATIVE_SELECTOR_KEYS = new Set([
  'above',
  'below',
  'leftOf',
  'rightOf',
  'childOf',
  'containsChild',
  'containsDescendants',
]);

function selectorTextValues(value: unknown, found: string[]): void {
  if (typeof value === 'string') {
    if (isRegexShapedSelector(value)) found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) selectorTextValues(entry, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'text' || RELATIVE_SELECTOR_KEYS.has(key)) {
      selectorTextValues(nested, found);
    }
  }
}

function conditionTextValues(value: unknown, found: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'visible' || key === 'notVisible') selectorTextValues(nested, found);
  }
}

export function findRegexTextSelectors(commands: readonly unknown[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (TEXT_SELECTOR_KEYS.has(key)) selectorTextValues(nested, found);
        if (key === 'scrollUntilVisible' && nested && typeof nested === 'object') {
          selectorTextValues((nested as Record<string, unknown>).element, found);
        }
        if (key === 'extendedWaitUntil') conditionTextValues(nested, found);
        if (key === 'when') conditionTextValues(nested, found);
        visit(nested);
      }
    }
  };
  visit(commands);
  return found;
}

export function driftedRegexSelectorRefusal(
  status: ReplayEngineStatus | null,
  commands: readonly unknown[],
): string | null {
  const cls = status?.pin.status;
  if (cls !== 'drift-newer' && cls !== 'drift-older') return null;
  const selectors = findRegexTextSelectors(commands);
  if (selectors.length === 0) return null;
  return (
    `maestro_run refused: maestro-runner ${status!.version ?? 'unknown'} drifted from the tested pin ` +
    `${status!.pin.pinned} and the flow uses regex text selectors (${selectors[0]}). Drifted runners ` +
    `translate Maestro regex into a literal WDA CONTAINS predicate that can never match (B223-class, ` +
    `GH #750). Reinstall the pin via ensure-maestro-runner.sh, or rewrite the selectors as literal ` +
    `text or id selectors.`
  );
}

export function strictPinRefusal(
  status: ReplayEngineStatus | null,
  envValue: string | undefined,
): string | null {
  const strict = envValue === '1' || envValue === 'true';
  if (!strict || !status) return null;
  const cls = status.pin.status;
  if (cls !== 'drift-newer' && cls !== 'drift-older' && cls !== 'checksum-mismatch') return null;
  return `maestro_run refused: RN_ENGINE_PIN_STRICT is set and the engine pin status is ${cls} (installed ${status.version ?? 'unknown'}, pinned ${status.pin.pinned}). Reinstall the pin via ensure-maestro-runner.sh, or unset RN_ENGINE_PIN_STRICT.`;
}

export function pinCorrection(status: ReplayEngineStatus, platformKey = nodePlatformKey()): string {
  const cls = status.pin.status;
  const pinned = status.pin.pinned;
  const installed = status.version ?? 'unknown';
  const install = `Reinstall exactly ${pinned} via ${PINNED_RUNNER_INSTALL_HINT} (session pin-cache; do not use PATH or brew maestro).`;
  if (pinArchiveCoords(platformKey) === null) {
    return (
      `maestro-runner is unsupported on ${platformKey}. Supported platforms: darwin-arm64, darwin-x64, ` +
      `linux-x64, linux-arm64. ${install}`
    );
  }
  switch (cls) {
    case 'not-installed':
      return `Session maestro-runner ${pinned} is not installed. ${install}`;
    case 'drift-older':
      return `Session maestro-runner ${installed} is older than the required pin ${pinned}. ${install}`;
    case 'drift-newer':
      return `Session maestro-runner ${installed} is newer than the required pin ${pinned}. ${install}`;
    case 'checksum-mismatch':
      return `Session maestro-runner binary checksum does not match the ${pinned} pin manifest. ${install}`;
    case 'unknown-version':
      return `Session maestro-runner version could not be read. ${install}`;
    case 'unverified':
      return `Session maestro-runner ${installed} could not be checksum-verified on ${platformKey}. ${install}`;
    case 'pinned-ok':
      return `Session maestro-runner ${pinned} is selected from the pin-cache.`;
  }
}

export function exactPinRefusal(
  status: ReplayEngineStatus | null,
  platformKey = nodePlatformKey(),
): string | null {
  if (!status) {
    return `maestro_run refused: session runner ${MAESTRO_RUNNER_PIN.version} could not be detected. ${pinCorrection(buildReplayEngineStatus('not-installed', null, false), platformKey)}`;
  }
  if (status.pin.status === 'pinned-ok') return null;
  return `maestro_run refused: ${pinCorrection(status, platformKey)}`;
}

export interface PinDoctorReport {
  ok: boolean;
  status: EnginePinClassification;
  platformStatus: 'supported' | 'unsupported';
  platformKey: string;
  pinned: string;
  installedVersion: string | null;
  selectedPath: string | null;
  provenance: RunnerProvenance;
  correction: string | null;
}

export function doctorPinnedRunner(
  status: ReplayEngineStatus,
  platformKey = nodePlatformKey(),
): PinDoctorReport {
  const platformStatus = pinArchiveCoords(platformKey) === null ? 'unsupported' : 'supported';
  const ok = status.pin.status === 'pinned-ok' && platformStatus === 'supported';
  return {
    ok,
    status: status.pin.status,
    platformStatus,
    platformKey,
    pinned: status.pin.pinned,
    installedVersion: status.version,
    selectedPath: status.selectedPath ?? null,
    provenance: status.provenance ?? (status.pin.status === 'not-installed' ? 'none' : 'pin-cache'),
    correction: ok ? null : pinCorrection(status, platformKey),
  };
}

export interface EngineStatusResolvers {
  binPath?: () => string | null;
  execVersion?: (bin: string) => Promise<string>;
  hashFile?: (bin: string) => string | null;
  cliPresent?: () => boolean;
  platformKey?: string;
}

let testStatus: ReplayEngineStatus | undefined;

export function _resetEngineStatusForTest(): void {
  testStatus = undefined;
}

export function _setEngineStatusForTest(s: ReplayEngineStatus): void {
  testStatus = s;
}

async function defaultExecVersion(bin: string): Promise<string> {
  const { stdout, stderr } = await execFile(bin, ['--version'], {
    timeout: 5000,
    encoding: 'utf8',
  });
  return stdout + '\n' + stderr;
}

function defaultHashFile(bin: string): string | null {
  return createHash('sha256').update(readFileSync(bin)).digest('hex');
}

async function detect(resolvers: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  const binPath = (resolvers.binPath ?? getMaestroRunnerDetectionPath)();
  const platformKey = resolvers.platformKey ?? nodePlatformKey();
  if (!binPath) {
    return buildReplayEngineStatus('not-installed', null, false, {
      selectedPath: null,
      provenance: 'none',
    });
  }
  const cacheVersion = pinCacheVersionForPath(binPath);
  if (cacheVersion && cacheVersion !== MAESTRO_RUNNER_PIN.version) {
    let sha256: string | null = null;
    try {
      sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
    } catch {
      sha256 = null;
    }
    const expectedSha256 = (
      TRUSTED_DRIFT_SHA256 as Readonly<
        Record<string, Readonly<Partial<Record<string, string>>>>
      >
    )[cacheVersion]?.[platformKey];
    if (!sha256) {
      return buildReplayEngineStatus('unverified', null, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    const comparison = compareVersions(cacheVersion, MAESTRO_RUNNER_PIN.version);
    if (!expectedSha256 && comparison > 0) {
      return buildReplayEngineStatus('drift-newer', cacheVersion, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    if (!expectedSha256) {
      return buildReplayEngineStatus('unverified', null, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    if (sha256 !== expectedSha256) {
      return buildReplayEngineStatus('checksum-mismatch', null, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    const cls =
      comparison < 0 ? 'drift-older' : comparison > 0 ? 'drift-newer' : 'unknown-version';
    return buildReplayEngineStatus(cls, cacheVersion, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  let sha256: string | null = null;
  try {
    sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
  } catch {
    sha256 = null;
  }
  const expectedSha256 = MAESTRO_RUNNER_PIN.sha256[platformKey];
  if (!expectedSha256 || !sha256) {
    return buildReplayEngineStatus('unverified', null, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  if (sha256 !== expectedSha256) {
    return buildReplayEngineStatus('checksum-mismatch', null, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  let version: string | null = null;
  try {
    const out = await (resolvers.execVersion ?? defaultExecVersion)(binPath);
    version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    version = null;
  }
  const cls = classifyEnginePin({ installed: true, version, sha256 }, platformKey);
  return buildReplayEngineStatus(cls, version, false, {
    selectedPath: binPath,
    provenance: 'pin-cache',
  });
}

export function getEngineStatus(resolvers?: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  if (testStatus) return Promise.resolve(testStatus);
  return detect(resolvers ?? {}).catch(() =>
    buildReplayEngineStatus('unknown-version', null, false),
  );
}
