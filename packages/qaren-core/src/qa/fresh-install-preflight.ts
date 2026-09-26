import { realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  isIosSimulatorUdid,
  probeIosExternalRunnerStrict,
  type IosStrictRunnerStatus,
} from '../runners/external-runner-detect.js';

export interface FreshInstallPreflightResult {
  v: 1;
  platform: 'ios';
  deviceId: string;
  status: IosStrictRunnerStatus;
}

async function observeProcess(executable: string, pid: number, timeout: number): Promise<unknown> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      executable,
      ['--internal-process-observation', String(pid)],
      { timeout, maxBuffer: 32_768, encoding: 'utf8' },
    );
    return stderr === '' ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}

export async function freshInstallPreflight(args: string[]): Promise<FreshInstallPreflightResult> {
  const invalid: FreshInstallPreflightResult = {
    v: 1,
    platform: 'ios',
    deviceId: '',
    status: 'unknown',
  };
  if (args.length !== 4 && args.length !== 6) return invalid;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--platform', '--device', '--process-observer'].includes(key) || options.has(key))
      return invalid;
    options.set(key, args[i + 1]);
  }
  const deviceId = options.get('--device');
  if (options.get('--platform') !== 'ios' || !deviceId || !isIosSimulatorUdid(deviceId)) {
    return invalid;
  }
  const observer = options.get('--process-observer');
  if (observer !== undefined && !isAbsolute(observer)) return invalid;
  return {
    v: 1,
    platform: 'ios',
    deviceId,
    status: await probeIosExternalRunnerStrict(
      undefined,
      deviceId,
      observer ? (pid, timeout) => observeProcess(observer, pid, timeout) : undefined,
    ),
  };
}

function invokedDirectly(): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const result = await freshInstallPreflight(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'clear' ? 0 : 4;
}
