import { execFileSync, spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidForPort } from '../cdp/metro-cwd.js';
import { captureMetroBinding } from './metro-binding.js';
import { readProcessBirth } from './process-birth.js';
function parentPid(pid) {
    try {
        const output = process.platform === 'win32'
            ? execFileSync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 })
            : execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2_000,
            });
        const parsed = Number(output.trim());
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
function listenerOwnedByLauncher(listenerPid, launcherPid) {
    let current = listenerPid;
    const visited = new Set();
    while (current && !visited.has(current)) {
        if (current === launcherPid)
            return true;
        visited.add(current);
        current = parentPid(current);
    }
    return false;
}
export function resolveManagedMetroCommand(appRoot, dependencies = {}) {
    const exists = dependencies.exists ?? existsSync;
    const readText = dependencies.readText ?? ((path) => readFileSync(path, 'utf8'));
    const packageJson = JSON.parse(readText(join(appRoot, 'package.json')));
    const all = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (all.expo) {
        const executable = join(appRoot, 'node_modules', '.bin', 'expo');
        if (!exists(executable)) {
            throw new Error('METRO_START_UNAVAILABLE: package-local Expo CLI is unavailable');
        }
        return { executable, args: ['start', '--dev-client'] };
    }
    if (all['react-native']) {
        const executable = join(appRoot, 'node_modules', '.bin', 'react-native');
        if (!exists(executable)) {
            throw new Error('METRO_START_UNAVAILABLE: package-local React Native CLI is unavailable');
        }
        return { executable, args: ['start'] };
    }
    throw new Error('METRO_START_UNAVAILABLE: project is neither Expo nor bare React Native');
}
function managementProof(sessionId, launcherPid, launcherBirth, instanceId, signerCapability) {
    return createHmac('sha256', signerCapability)
        .update(`${sessionId}\0${launcherPid}\0${launcherBirth}\0${instanceId}`)
        .digest('hex');
}
export async function startManagedMetro(input, dependencies = {}) {
    const command = resolveManagedMetroCommand(input.appRoot, dependencies);
    const log = openSync(join(input.runtimeRoot, 'metro.log'), 'a', 0o600);
    const instanceId = input.instanceId;
    const child = (dependencies.spawnProcess ?? spawn)(command.executable, [...command.args, '--port', String(input.port)], {
        cwd: input.appRoot,
        env: {
            ...process.env,
            RCT_METRO_PORT: String(input.port),
            RN_DEV_AGENT_SESSION_ID: input.sessionId,
            RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
        },
        detached: true,
        stdio: ['ignore', log, log],
    });
    closeSync(log);
    if (!child.pid) {
        throw new Error('METRO_START_UNAVAILABLE: package-local Metro process did not start');
    }
    const readBirth = dependencies.readBirth ?? readProcessBirth;
    const launcherBirth = readBirth(child.pid);
    if (!launcherBirth) {
        child.kill('SIGTERM');
        throw new Error('PROCESS_BIRTH_UNAVAILABLE: Metro launcher birth could not be proven');
    }
    child.unref();
    const listenerPid = dependencies.listenerPid ?? pidForPort;
    const ownsListener = dependencies.listenerOwnedByLauncher ?? listenerOwnedByLauncher;
    const capture = dependencies.capture ?? captureMetroBinding;
    const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + 20_000;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null)
            break;
        const pid = listenerPid(input.port);
        if (pid && ownsListener(pid, child.pid)) {
            try {
                const binding = await capture({
                    port: input.port,
                    pid,
                    instanceId,
                    sourceRoot: input.sourceRoot,
                    buildGeneration: input.buildGeneration,
                }, { servingRoot: () => input.sourceRoot });
                return {
                    ...binding,
                    mode: 'managed',
                    launcherPid: child.pid,
                    launcherBirth: launcherBirth.token,
                    managementProof: managementProof(input.sessionId, child.pid, launcherBirth.token, instanceId, input.signerCapability),
                };
            }
            catch (error) {
                lastError = error;
            }
        }
        await wait(100);
    }
    if (readBirth(child.pid)?.token === launcherBirth.token) {
        child.kill('SIGTERM');
    }
    throw new Error(`METRO_START_UNAVAILABLE: allocated Metro did not become authoritative${lastError instanceof Error ? ` (${lastError.message})` : ''}`);
}
export function stopManagedMetro(binding, input) {
    if (binding?.mode !== 'managed' ||
        typeof binding.launcherPid !== 'number' ||
        typeof binding.launcherBirth !== 'string' ||
        typeof binding.instanceId !== 'string' ||
        typeof binding.managementProof !== 'string') {
        return false;
    }
    const expected = managementProof(input.sessionId, binding.launcherPid, binding.launcherBirth, binding.instanceId, input.signerCapability);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const observedBuffer = Buffer.from(binding.managementProof, 'hex');
    if (expectedBuffer.length !== observedBuffer.length ||
        !timingSafeEqual(expectedBuffer, observedBuffer)) {
        return false;
    }
    const birth = readProcessBirth(binding.launcherPid);
    if (!birth || birth.token !== binding.launcherBirth)
        return false;
    try {
        process.kill(binding.launcherPid, 'SIGTERM');
        return true;
    }
    catch {
        return false;
    }
}
