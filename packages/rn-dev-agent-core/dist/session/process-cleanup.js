import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { OWNED_PACKAGES } from '../runners/release-android-slot.js';
import { probeManagedMetroListener } from './managed-metro.js';
import { probeProcessBirth, withVerifiedDarwinProcessBirthHelper, } from './process-birth.js';
import { SessionAuthorityError } from './registry.js';
const execFile = promisify(execFileCb);
const RECORDER_POST_KILL_CONFIRM_MS = 2_000;
function executeRecorderScript(script, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(script, args, {
            detached: process.platform !== 'win32',
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        let timer;
        let killTimer;
        let groupPollTimer;
        let groupExitDeadline;
        let terminationError;
        const finish = (error, result) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            if (groupPollTimer)
                clearTimeout(groupPollTimer);
            if (error)
                reject(error);
            else
                resolve(result);
        };
        const signal = (value) => {
            if (child.pid === undefined)
                return;
            try {
                if (process.platform === 'win32')
                    child.kill(value);
                else
                    process.kill(-child.pid, value);
            }
            catch { }
        };
        const processGroupExists = () => {
            if (child.pid === undefined || process.platform === 'win32')
                return false;
            try {
                process.kill(-child.pid, 0);
                return true;
            }
            catch (error) {
                return error.code !== 'ESRCH';
            }
        };
        const waitForProcessGroupExit = () => {
            if (!terminationError || settled)
                return;
            if (!processGroupExists()) {
                finish(terminationError);
                return;
            }
            if (groupExitDeadline !== undefined && Date.now() >= groupExitDeadline) {
                finish(new Error(`${terminationError.message}; recorder process-group termination is unconfirmed`, { cause: terminationError }));
                return;
            }
            groupPollTimer = setTimeout(waitForProcessGroupExit, 25);
        };
        const terminate = (error) => {
            if (terminationError)
                return;
            terminationError = error;
            signal('SIGTERM');
            if (process.platform === 'win32')
                return;
            killTimer = setTimeout(() => {
                groupExitDeadline = Date.now() + RECORDER_POST_KILL_CONFIRM_MS;
                signal('SIGKILL');
                waitForProcessGroupExit();
            }, 250);
            waitForProcessGroupExit();
        };
        const collect = (target) => (chunk) => {
            if (terminationError)
                return;
            outputBytes += chunk.length;
            if (outputBytes > 8 * 1024 * 1024) {
                terminate(new Error('record_proof.sh output exceeded 8 MiB'));
                return;
            }
            target.push(chunk);
        };
        child.stdout?.on('data', collect(stdout));
        child.stderr?.on('data', collect(stderr));
        child.on('error', (error) => {
            if (child.pid === undefined)
                finish(error);
            else
                terminate(error);
        });
        child.on('close', (code, signal) => {
            if (terminationError) {
                if (process.platform === 'win32')
                    finish(terminationError);
                else
                    waitForProcessGroupExit();
                return;
            }
            const result = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            };
            if (code === 0) {
                finish(undefined, result);
                return;
            }
            finish(new Error(`record_proof.sh exited with ${code ?? signal ?? 'unknown'}: ${result.stderr.trim()}`));
        });
        timer = setTimeout(() => {
            terminate(new Error(`record_proof.sh timed out after ${options.timeout}ms`));
        }, options.timeout);
    });
}
export async function runRecordProofScript(script, args, timeout = 60_000, dependencies = {}) {
    const execute = dependencies.execute ?? executeRecorderScript;
    if ((dependencies.platform ?? process.platform) !== 'darwin') {
        return execute(script, args, { timeout, env: { ...process.env } });
    }
    const withHelper = dependencies.withHelper ?? withVerifiedDarwinProcessBirthHelper;
    return withHelper((helper) => execute(script, args, {
        timeout,
        env: {
            ...process.env,
            RN_DEV_AGENT_PROCESS_BIRTH_HELPER: helper.path,
            RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: helper.requirement,
        },
    }));
}
async function awaitExactStopped(probe, deadlineMs, code, message) {
    while (true) {
        const status = probe();
        if (status === 'stopped')
            return true;
        if (status === 'unknown') {
            throw new SessionAuthorityError(code, `${message}; shutdown identity is unknown`);
        }
        if (Date.now() >= deadlineMs)
            return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
async function waitForExactStopped(probe, deadlineMs, code, message) {
    if (!(await awaitExactStopped(probe, deadlineMs, code, message))) {
        throw new SessionAuthorityError(code, message);
    }
}
export async function stopBoundObserve(binding, listenerProbe = probeManagedMetroListener, processProbe = probeProcessBirth, timeoutMs = 2_000, request = fetch) {
    const deadlineMs = Date.now() + timeoutMs;
    const port = Number(binding.port);
    const pid = Number(binding.pid);
    const expectedBirth = String(binding.processBirth ?? '');
    const instanceId = String(binding.instanceId ?? '');
    const capability = String(binding.cleanupCapability ?? '');
    if (!Number.isSafeInteger(port) ||
        !Number.isSafeInteger(pid) ||
        !expectedBirth ||
        !instanceId ||
        !capability) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup authority is incomplete');
    }
    const currentListener = listenerProbe(port);
    if (currentListener.status === 'unknown') {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe listener lookup is inconclusive');
    }
    if (currentListener.status === 'absent' || currentListener.pid !== pid)
        return;
    const currentBirth = processProbe(pid);
    if (currentBirth.status === 'unknown') {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe process identity is unavailable');
    }
    if (currentBirth.status === 'absent') {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe listener identity is internally inconsistent');
    }
    if (currentBirth.birth.token !== expectedBirth) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe listener PID was reused before cleanup completed');
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup timed out before the stop request');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response;
    try {
        response = await request(`http://127.0.0.1:${port}/api/stop`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${capability}`,
                'x-rn-observe-instance': instanceId,
            },
            signal: controller.signal,
        });
    }
    catch {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup request failed or timed out');
    }
    finally {
        clearTimeout(timeout);
    }
    if (!response.ok) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe server refused fenced cleanup');
    }
    await waitForExactStopped(() => {
        const observed = listenerProbe(port);
        if (observed.status === 'unknown')
            return 'unknown';
        return observed.status === 'listening' && observed.pid === pid ? 'running' : 'stopped';
    }, deadlineMs, 'OBSERVE_AUTHORITY_MISMATCH', 'Observe listener did not stop before the cleanup deadline');
}
export async function stopBoundRunner(binding, processProbe = probeProcessBirth, signalProcess = process.kill, timeoutMs = 2_000, runAdb = async (args) => execFile('adb', args, { timeout: 5_000, encoding: 'utf8' }), termGraceMs = 500) {
    const deadlineMs = Date.now() + timeoutMs;
    const pid = Number(binding.pid);
    const expectedBirth = String(binding.processBirth ?? '');
    const instanceId = String(binding.instanceId ?? '');
    const capability = String(binding.capability ?? '');
    if (!Number.isSafeInteger(pid) || !expectedBirth || !instanceId || !capability) {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'runner cleanup identity is incomplete');
    }
    const platform = String(binding.platform ?? '');
    const deviceId = String(binding.deviceId ?? '');
    const port = Number(binding.port);
    const current = processProbe(pid);
    if (current.status === 'unknown') {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'runner process identity is unavailable');
    }
    if (current.status === 'present' && current.birth.token === expectedBirth) {
        const observeStop = () => {
            const observed = processProbe(pid);
            if (observed.status === 'unknown')
                return 'unknown';
            return observed.status === 'present' && observed.birth.token === expectedBirth
                ? 'running'
                : 'stopped';
        };
        const message = 'runner process did not stop before the cleanup deadline';
        signalProcess(pid, 'SIGTERM');
        const graceDeadlineMs = Math.min(deadlineMs, Date.now() + termGraceMs);
        if (!(await awaitExactStopped(observeStop, graceDeadlineMs, 'RUNNER_ADOPTION_REQUIRED', message))) {
            // The iOS runner is an xcodebuild test host that does not unwind on a
            // single SIGTERM. Escalate — but only after re-proving the pid still
            // carries this binding's exact birth token, so a reused pid or another
            // session's runner is never killed (GH #707).
            const escalation = processProbe(pid);
            if (escalation.status === 'unknown') {
                throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', `${message}; shutdown identity is unknown`);
            }
            if (escalation.status === 'present' && escalation.birth.token === expectedBirth) {
                signalProcess(pid, 'SIGKILL');
            }
            await waitForExactStopped(observeStop, deadlineMs, 'RUNNER_ADOPTION_REQUIRED', message);
        }
    }
    if (platform !== 'android')
        return;
    if (!deviceId || !Number.isSafeInteger(port)) {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'Android runner cleanup identity is incomplete');
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
    }
    catch (error) {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', `Android device-side runner termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function stopBoundRecorder(binding, _processProbe = probeProcessBirth, runRecorder = async (script, args) => runRecordProofScript(script, args)) {
    const script = String(binding.script ?? '');
    const scope = String(binding.scope ?? '');
    const pid = Number(binding.pid);
    const expectedBirth = String(binding.processBirth ?? '');
    if (!script || !/^[a-f0-9]{64}$/.test(scope)) {
        throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'recorder cleanup identity is incomplete');
    }
    if (binding.phase === 'starting') {
        try {
            const initialStatus = await runRecorder(script, ['status', scope]);
            const active = initialStatus.stdout.match(/^(?:ios|android): pid=(\d+) birth=(\S+) status=\w+ output=.*$/m);
            if (active) {
                await runRecorder(script, ['abort', scope]);
            }
            else if (/^No active recordings/m.test(initialStatus.stdout)) {
                await runRecorder(script, ['abort', scope]);
            }
            else {
                throw new Error('provisional recorder status is not parseable');
            }
            const finalStatus = await runRecorder(script, ['status', scope]);
            if (!/^No active recordings/m.test(finalStatus.stdout)) {
                throw new Error('provisional recorder state remains active after cleanup');
            }
            return '';
        }
        catch (error) {
            throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', `provisional recorder termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!Number.isSafeInteger(pid) || !expectedBirth) {
        throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'recorder cleanup identity is incomplete');
    }
    try {
        const stopped = await runRecorder(script, ['stop', scope, String(pid), expectedBirth]);
        const status = await runRecorder(script, ['status', scope]);
        if (!/^No active recordings/m.test(status.stdout)) {
            throw new Error('recorder state remains active after cleanup');
        }
        return stopped.stdout;
    }
    catch (error) {
        throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', `recorder termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
    }
}
