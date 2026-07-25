import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { OWNED_PACKAGES } from '../runners/release-android-slot.js';
import { probeManagedMetroListener, type ManagedMetroListenerProbe } from './managed-metro.js';
import { probeProcessBirth, type ProcessBirthProbe } from './process-birth.js';
import { SessionAuthorityError } from './registry.js';

const execFile = promisify(execFileCb);

async function waitForExactStopped(
  probe: () => 'running' | 'stopped' | 'unknown',
  deadlineMs: number,
  code: string,
  message: string,
): Promise<void> {
  while (true) {
    const status = probe();
    if (status === 'stopped') return;
    if (status === 'unknown') {
      throw new SessionAuthorityError(code, `${message}; shutdown identity is unknown`);
    }
    if (Date.now() >= deadlineMs) {
      throw new SessionAuthorityError(code, message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function stopBoundObserve(
  binding: Record<string, unknown>,
  listenerProbe: (port: number) => ManagedMetroListenerProbe = probeManagedMetroListener,
  processProbe: (pid: number) => ProcessBirthProbe = probeProcessBirth,
  timeoutMs = 2_000,
  request: typeof fetch = fetch,
): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  const port = Number(binding.port);
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? '');
  const instanceId = String(binding.instanceId ?? '');
  const capability = String(binding.cleanupCapability ?? '');
  if (
    !Number.isSafeInteger(port) ||
    !Number.isSafeInteger(pid) ||
    !expectedBirth ||
    !instanceId ||
    !capability
  ) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe cleanup authority is incomplete',
    );
  }
  const currentListener = listenerProbe(port);
  if (currentListener.status === 'unknown') {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe listener lookup is inconclusive',
    );
  }
  if (currentListener.status === 'absent' || currentListener.pid !== pid) return;
  const currentBirth = processProbe(pid);
  if (currentBirth.status === 'unknown') {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe process identity is unavailable',
    );
  }
  if (currentBirth.status === 'absent') {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe listener identity is internally inconsistent',
    );
  }
  if (currentBirth.birth.token !== expectedBirth) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe listener PID was reused before cleanup completed',
    );
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe cleanup timed out before the stop request',
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  let response: Response;
  try {
    response = await request(`http://127.0.0.1:${port}/api/stop`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'x-rn-observe-instance': instanceId,
      },
      signal: controller.signal,
    });
  } catch {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe cleanup request failed or timed out',
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new SessionAuthorityError(
      'OBSERVE_AUTHORITY_MISMATCH',
      'Observe server refused fenced cleanup',
    );
  }
  await waitForExactStopped(
    () => {
      const observed = listenerProbe(port);
      if (observed.status === 'unknown') return 'unknown';
      return observed.status === 'listening' && observed.pid === pid ? 'running' : 'stopped';
    },
    deadlineMs,
    'OBSERVE_AUTHORITY_MISMATCH',
    'Observe listener did not stop before the cleanup deadline',
  );
}

export async function stopBoundRunner(
  binding: Record<string, unknown>,
  processProbe: (pid: number) => ProcessBirthProbe = probeProcessBirth,
  signalProcess: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  timeoutMs = 2_000,
  runAdb: (args: string[]) => Promise<{ stdout: string; stderr: string }> = async (args) =>
    execFile('adb', args, { timeout: 5_000, encoding: 'utf8' }),
): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? '');
  const instanceId = String(binding.instanceId ?? '');
  const capability = String(binding.capability ?? '');
  if (!Number.isSafeInteger(pid) || !expectedBirth || !instanceId || !capability) {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      'runner cleanup identity is incomplete',
    );
  }
  const platform = String(binding.platform ?? '');
  const deviceId = String(binding.deviceId ?? '');
  const port = Number(binding.port);
  const current = processProbe(pid);
  if (current.status === 'unknown') {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      'runner process identity is unavailable',
    );
  }
  if (current.status === 'present' && current.birth.token === expectedBirth) {
    signalProcess(pid, 'SIGTERM');
    await waitForExactStopped(
      () => {
        const observed = processProbe(pid);
        if (observed.status === 'unknown') return 'unknown';
        return observed.status === 'present' && observed.birth.token === expectedBirth
          ? 'running'
          : 'stopped';
      },
      deadlineMs,
      'RUNNER_ADOPTION_REQUIRED',
      'runner process did not stop before the cleanup deadline',
    );
  }
  if (platform !== 'android') return;
  if (!deviceId || !Number.isSafeInteger(port)) {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      'Android runner cleanup identity is incomplete',
    );
  }
  const serial = ['-s', deviceId];
  try {
    await runAdb([...serial, 'forward', '--remove', `tcp:${port}`]);
    for (const pkg of OWNED_PACKAGES) {
      await runAdb([...serial, 'shell', 'am', 'force-stop', pkg]);
      const process = await runAdb([...serial, 'shell', 'sh', '-c', `pidof ${pkg} || true`]);
      if (process.stdout.trim()) {
        throw new Error(`${pkg} remains alive after force-stop`);
      }
    }
    const instrumentation = await runAdb([
      ...serial,
      'shell',
      'dumpsys',
      'activity',
      'instrumentation',
    ]);
    const output = `${instrumentation.stdout}\n${instrumentation.stderr}`;
    if (OWNED_PACKAGES.some((pkg) => output.includes(pkg))) {
      throw new Error('owned instrumentation remains registered');
    }
  } catch (error) {
    throw new SessionAuthorityError(
      'RUNNER_ADOPTION_REQUIRED',
      `Android device-side runner termination is unproven: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function stopBoundRecorder(
  binding: Record<string, unknown>,
  processProbe: (pid: number) => ProcessBirthProbe = probeProcessBirth,
  runRecorder: (
    script: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }> = async (script, args) =>
    execFile(script, args, { timeout: 60_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
): Promise<string> {
  const script = String(binding.script ?? '');
  const scope = String(binding.scope ?? '');
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? '');
  if (!script || !/^[a-f0-9]{64}$/.test(scope)) {
    throw new SessionAuthorityError(
      'RECORDING_AUTHORITY_MISMATCH',
      'recorder cleanup identity is incomplete',
    );
  }
  if (binding.phase === 'starting') {
    try {
      const initialStatus = await runRecorder(script, ['status', scope]);
      const active = initialStatus.stdout.match(
        /^(?:ios|android): pid=(\d+) birth=(\S+) status=\w+ output=.*$/m,
      );
      let output = '';
      if (active) {
        const provisionalPid = Number(active[1]);
        const reportedBirth = active[2];
        const current = processProbe(provisionalPid);
        if (current.status === 'unknown') {
          throw new Error('provisional recorder process identity is unavailable');
        }
        if (current.status === 'present') {
          if (reportedBirth !== 'unbound' && reportedBirth !== current.birth.token) {
            throw new Error('provisional recorder PID was reused before cleanup');
          }
          await runRecorder(script, [
            'bind-identity',
            scope,
            String(provisionalPid),
            current.birth.token,
          ]);
          output = (
            await runRecorder(script, [
              'stop',
              scope,
              String(provisionalPid),
              current.birth.token,
            ])
          ).stdout;
        } else {
          await runRecorder(script, ['abort', scope]);
        }
      } else if (/^No active recordings/m.test(initialStatus.stdout)) {
        await runRecorder(script, ['abort', scope]);
      } else {
        throw new Error('provisional recorder status is not parseable');
      }
      const finalStatus = await runRecorder(script, ['status', scope]);
      if (!/^No active recordings/m.test(finalStatus.stdout)) {
        throw new Error('provisional recorder state remains active after cleanup');
      }
      return output;
    } catch (error) {
      throw new SessionAuthorityError(
        'RECORDING_AUTHORITY_MISMATCH',
        `provisional recorder termination is unproven: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (!Number.isSafeInteger(pid) || !expectedBirth) {
    throw new SessionAuthorityError(
      'RECORDING_AUTHORITY_MISMATCH',
      'recorder cleanup identity is incomplete',
    );
  }
  const current = processProbe(pid);
  if (current.status === 'unknown') {
    throw new SessionAuthorityError(
      'RECORDING_AUTHORITY_MISMATCH',
      'recorder process identity is unavailable',
    );
  }
  if (current.status === 'present' && current.birth.token !== expectedBirth) {
    throw new SessionAuthorityError(
      'RECORDING_AUTHORITY_MISMATCH',
      'recorder PID was reused before cleanup completed',
    );
  }
  try {
    const stopped = await runRecorder(script, ['stop', scope, String(pid), expectedBirth]);
    const status = await runRecorder(script, ['status', scope]);
    if (!/^No active recordings/m.test(status.stdout)) {
      throw new Error('recorder state remains active after cleanup');
    }
    return stopped.stdout;
  } catch (error) {
    throw new SessionAuthorityError(
      'RECORDING_AUTHORITY_MISMATCH',
      `recorder termination is unproven: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
