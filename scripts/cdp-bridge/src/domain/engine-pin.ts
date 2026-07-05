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
  const cls = status.pin.status;
  if (cls === 'drift-newer' || cls === 'drift-older') {
    return `maestro-runner ${status.version} differs from the tested pin ${status.pin.pinned} (untested drift — B223-class behavior changes arrive silently; see the upgrade ritual in engine-pin.ts)`;
  }
  if (cls === 'checksum-mismatch') {
    return `maestro-runner reports the pinned version ${status.pin.pinned} but its binary checksum does not match the manifest — possible corruption or tampering; reinstall via ensure-maestro-runner.sh`;
  }
  return null;
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

function defaultCliPresent(): boolean {
  const r = spawnSync('which', ['maestro'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
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

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
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
  return buildReplayEngineStatus(cls, version, cliPresent);
}

export function getEngineStatus(resolvers?: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  if (!cachedStatus) {
    cachedStatus = detect(resolvers ?? {}).catch(() =>
      buildReplayEngineStatus('unknown-version', null, false),
    );
  }
  return cachedStatus;
}
