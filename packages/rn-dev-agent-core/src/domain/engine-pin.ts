// GH #397 (Story 13 Phase 1): the tested maestro-runner pin. Single source of
// truth — scripts/ensure-maestro-runner.sh mirrors version+hash and a grep-sync
// test (gh-397-pin-sync.test.ts) keeps them honest.
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

const execFile = promisify(execFileCb);

export const MAESTRO_RUNNER_PIN = {
  version: '1.1.24',
  sha256: {
    'darwin-arm64': '170f12521de83322823dd5fc0ce16e48abeba9952cdbb242670592566c2fd1f3',
    'darwin-x64': 'af7f5ea044afc72ea780c835f05b32203e443d2e26d310a864bfb2bc84959bf6',
    'linux-x64': 'e9bdef6f08f855ca1a884f99b54a519a1eae0a342917181a53eb414a5b00d6d8',
    'linux-arm64': '8d8a6483ad04da2109636b7192398750657801b8a8d512688d1be3b033a105b8',
  } as Partial<Record<string, string>>,
  knownQuirks: [
    {
      id: 'android-pre-o-unsupported',
      ref: 'GH #741',
      note: 'bundled UiAutomator2 server APK declares minSdk 26; API 23-25 installs fail with INSTALL_FAILED_OLDER_SDK',
    },
  ],
} as const;

export const ACTION_ENGINE_PIN = `maestro-runner@${MAESTRO_RUNNER_PIN.version}` as const;

export const PINNED_RUNNER_INSTALL_HINT =
  `bash \${CLAUDE_PLUGIN_ROOT:-<plugin-root>}/scripts/ensure-maestro-runner.sh` as const;

// GH #741: the pinned engine's bundled appium-uiautomator2-server APK declares
// minSdk 26, so pre-O devices reject it with INSTALL_FAILED_OLDER_SDK.
export const MAESTRO_RUNNER_MIN_ANDROID_API = 26;

const PRE_O_REMEDY =
  'Action replay / E2E via the maestro engine is unsupported on this device; the direct device_* ' +
  'interaction tier still works (rn-android-runner supports API 23+), except for the few device_* ' +
  'paths that fall back to maestro (dev-client picker, system dialogs, device_fill correction), ' +
  'which hit this same limit.';

export type ReplayEngineTier = 'maestro-runner' | 'maestro' | 'maestro-cli';

function engineLabel(runner: ReplayEngineTier): string {
  return runner === 'maestro-runner'
    ? `the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version}`
    : 'the Maestro CLI';
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
  engine: 'maestro-runner' | 'none';
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

export function getMaestroRunnerPath(): string | null {
  const path = pinnedRunnerBinPath();
  return existsSync(path) ? path : null;
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

export function findRegexTextSelectors(commands: readonly unknown[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown, underSelectorKey: boolean): void => {
    if (typeof value === 'string') {
      if (underSelectorKey && REGEX_SHAPED_SELECTOR.test(value)) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, underSelectorKey);
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
      return `Session maestro-runner reports ${pinned} but the binary checksum does not match the pin manifest. ${install}`;
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
  const binPath = (resolvers.binPath ?? getMaestroRunnerPath)();
  const platformKey = resolvers.platformKey ?? nodePlatformKey();
  if (!binPath) {
    return buildReplayEngineStatus('not-installed', null, false, {
      selectedPath: null,
      provenance: 'none',
    });
  }
  let version: string | null = null;
  try {
    const out = await (resolvers.execVersion ?? defaultExecVersion)(binPath);
    version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    version = null;
  }
  let sha256: string | null = null;
  try {
    sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
  } catch {
    sha256 = null;
  }
  const cls = classifyEnginePin({ installed: true, version, sha256 }, platformKey);
  return buildReplayEngineStatus(cls, version, false, {
    selectedPath: binPath,
    provenance: 'pin-cache',
  });
}

// Single-flight, process-wide: concurrent callers (cdp_status, maestro_run)
// share one detection promise. `resolvers` exists ONLY for tests, which must
// pair it with _resetEngineStatusForTest — a resolver call after the cache is
// warm returns the cached status by design (no per-resolver keying).
export function getEngineStatus(resolvers?: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  if (!cachedStatus) {
    cachedStatus = detect(resolvers ?? {}).catch(() =>
      buildReplayEngineStatus('unknown-version', null, false),
    );
  }
  return cachedStatus;
}
