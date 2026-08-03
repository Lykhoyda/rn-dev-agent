import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { deleteStateFile, readJsonStateFile, runnerStatePath, writeJsonStateFileAtomic, } from '../util/secure-state-file.js';
import { probeProcessBirth, readProcessBirth } from './process-birth.js';
import { getWorkerAuthorityRuntime } from './runtime.js';
const OUTPUT_LIMIT = 10 * 1024 * 1024;
const TERM_GRACE_MS = 500;
const ABSENCE_CONFIRM_MS = 2_000;
const POLL_MS = 25;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
const activeAutomationDuties = new Map();
function automationDutyKey(platform, deviceId) {
    return `${platform}:${deviceId}`;
}
function rememberAutomationDuty(state) {
    activeAutomationDuties.set(automationDutyKey(state.platform, state.deviceId), state);
}
function forgetAutomationDuty(platform, deviceId) {
    activeAutomationDuties.delete(automationDutyKey(platform, deviceId));
}
function currentAutomationDuty(platform, deviceId, authorityStore) {
    const active = activeAutomationDuties.get(automationDutyKey(platform, deviceId));
    if (active)
        return active;
    const authority = authorityStore?.read(platform, deviceId) ?? null;
    const file = readPersistedAutomationState(platform, deviceId);
    if (!authority)
        return file;
    if (!file)
        return authority;
    if (authority.invocationId !== file.invocationId ||
        authority.sessionId !== file.sessionId ||
        authority.claimEpoch !== file.claimEpoch) {
        return authority;
    }
    if (authority.kind === 'maestro-cleanup-refusal')
        return file;
    return authority.revision >= file.revision ? authority : file;
}
function isAutomationDuty(value) {
    if (!value || typeof value !== 'object')
        return false;
    const state = value;
    if (state.schemaVersion !== 1 ||
        (state.kind !== 'maestro-process-group' && state.kind !== 'maestro-cleanup-refusal') ||
        typeof state.invocationId !== 'string' ||
        typeof state.sessionId !== 'string' ||
        !Number.isSafeInteger(state.claimEpoch) ||
        (state.platform !== 'ios' && state.platform !== 'android') ||
        typeof state.deviceId !== 'string' ||
        typeof state.startedAt !== 'string' ||
        typeof state.tool !== 'string') {
        return false;
    }
    if (state.kind === 'maestro-cleanup-refusal')
        return true;
    const processState = value;
    return (Number.isSafeInteger(processState.revision) &&
        typeof processState.attributionComplete === 'boolean' &&
        Number.isSafeInteger(processState.pid) &&
        Number.isSafeInteger(processState.pgid) &&
        typeof processState.processBirth === 'string' &&
        Array.isArray(processState.attributedProcesses));
}
export function automationDutyStoreForSession(registry, session) {
    return {
        read(platform, deviceId) {
            const status = registry.getSessionStatus(session.sessionId);
            if (!status || status.claimEpoch !== session.claimEpoch)
                return null;
            const duty = status.bindings.automationDuty;
            if (duty === null || duty === undefined)
                return null;
            if (!isAutomationDuty(duty) || duty.platform !== platform || duty.deviceId !== deviceId) {
                throw new Error('AUTOMATION_CLEANUP_UNPROVEN: session automation duty is invalid');
            }
            return duty;
        },
        write(duty) {
            registry.updateBindings(session, { bindings: { automationDuty: duty } });
        },
    };
}
export function automationDutyStoreForClosingSession(registry, session) {
    const readable = automationDutyStoreForSession(registry, session);
    return {
        read: readable.read,
        write(duty) {
            if (duty !== null) {
                throw new Error('AUTOMATION_CLEANUP_UNPROVEN: closing session cannot replace its duty');
            }
            registry.clearAutomationDutyDuringClose(session);
        },
    };
}
export function automationDutyStore(runtime) {
    const { registry, session } = runtime.requireAvailable();
    return automationDutyStoreForSession(registry, session);
}
function defaultAutomationDutyStore(env) {
    if (!env.RN_DEV_AGENT_REGISTRY_PATH ||
        !env.RN_DEV_AGENT_WORKER_INSTANCE ||
        !env.RN_DEV_AGENT_SESSION_ID ||
        !env.RN_DEV_AGENT_CLAIM_EPOCH) {
        return null;
    }
    return automationDutyStore(getWorkerAuthorityRuntime());
}
function clearAutomationDuty(platform, deviceId, authorityStore) {
    authorityStore?.write(null);
    forgetAutomationDuty(platform, deviceId);
    deleteStateFile(automationStatePath(platform, deviceId));
}
function observeChildTerminal(child, timeoutMs) {
    let stop = () => { };
    const result = new Promise((resolve) => {
        let settled = false;
        let timer;
        const done = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(value);
        };
        child.once('error', (error) => done({ code: null, signal: null, timedOut: false, error: error.message }));
        child.once('close', (code, signal) => done({ code, signal, timedOut: false }));
        timer = setTimeout(() => done({ code: null, signal: 'SIGTERM', timedOut: true }), timeoutMs);
        stop = () => done({ code: null, signal: null, timedOut: false });
    });
    return { result, stop };
}
export function automationStatePath(platform, deviceId) {
    // Reuse the hardened runner-state namespace and atomic/symlink-refusing state
    // file primitives. Automation is another transient runner ownership duty,
    // not a second registry or ambient PID database.
    return runnerStatePath(`automation-${platform}-${deviceId}`);
}
export function readPersistedAutomationState(platform, deviceId) {
    const state = readJsonStateFile(automationStatePath(platform, deviceId));
    if (state?.schemaVersion !== 1 ||
        state.kind !== 'maestro-process-group' ||
        !Number.isSafeInteger(state.revision) ||
        typeof state.attributionComplete !== 'boolean' ||
        typeof state.invocationId !== 'string' ||
        typeof state.sessionId !== 'string' ||
        !Number.isSafeInteger(state.claimEpoch) ||
        state.platform !== platform ||
        state.deviceId !== deviceId ||
        !Number.isSafeInteger(state.pid) ||
        !Number.isSafeInteger(state.pgid) ||
        typeof state.processBirth !== 'string' ||
        typeof state.startedAt !== 'string' ||
        typeof state.tool !== 'string' ||
        !Array.isArray(state.attributedProcesses)) {
        return null;
    }
    return state;
}
function groupPresence(pgid, signalGroup) {
    try {
        signalGroup(pgid, 0);
        return 'present';
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return 'absent';
        return 'unknown';
    }
}
async function waitForGroupAbsence(pgid, signalGroup, delay, timeoutMs = ABSENCE_CONFIRM_MS) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const presence = groupPresence(pgid, signalGroup);
        if (presence !== 'present')
            return presence;
        if (Date.now() >= deadline)
            return 'present';
        await delay(POLL_MS);
    }
}
async function terminateProcessGroup(pgid, signalGroup, delay) {
    try {
        signalGroup(pgid, 'SIGTERM');
    }
    catch { }
    let presence = await waitForGroupAbsence(pgid, signalGroup, delay, TERM_GRACE_MS);
    if (presence !== 'present')
        return { presence, escalated: false };
    try {
        signalGroup(pgid, 'SIGKILL');
    }
    catch { }
    presence = await waitForGroupAbsence(pgid, signalGroup, delay);
    return { presence, escalated: true };
}
const AUTOMATION_TOKEN = /(?:maestro(?:-runner)?|xcodebuild|WebDriverAgentRunner-Runner)/i;
export function selectExactDeviceAutomationPids(psOutput, deviceId) {
    if (!deviceId)
        return [];
    const pids = [];
    for (const line of psOutput.split('\n')) {
        if (!line.includes(deviceId) || !AUTOMATION_TOKEN.test(line))
            continue;
        const pid = Number(line.trim().match(/^(\d+)\b/)?.[1]);
        if (Number.isSafeInteger(pid) && pid > 0)
            pids.push(pid);
    }
    return pids;
}
function defaultListProcesses() {
    return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], {
        encoding: 'utf8',
        timeout: 3_000,
    });
}
function currentSessionAuthority(env) {
    const sessionId = env.RN_DEV_AGENT_SESSION_ID;
    const claimEpoch = Number(env.RN_DEV_AGENT_CLAIM_EPOCH);
    return sessionId && Number.isSafeInteger(claimEpoch) && claimEpoch > 0
        ? { sessionId, claimEpoch }
        : null;
}
function safeUnlink(path) {
    try {
        unlinkSync(path);
    }
    catch {
        /* already gone */
    }
}
/** Execute one owned subprocess tree. Timeout is a whole-flow deadline. */
export async function spawnManagedProcessGroup(bin, args, options, dependencies = {}) {
    const spawnProcess = dependencies.spawn ?? spawn;
    const delay = dependencies.sleep ?? sleep;
    const signalGroup = dependencies.signalGroup ??
        ((pgid, signal) => {
            if (process.platform === 'win32')
                process.kill(pgid, signal);
            else
                process.kill(-pgid, signal);
        });
    const readBirth = dependencies.readBirth ?? readProcessBirth;
    const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
    const listProcesses = dependencies.listProcesses ?? defaultListProcesses;
    const writeState = dependencies.writeState ?? writeJsonStateFileAtomic;
    const env = options.env ?? process.env;
    const authorityStore = dependencies.authorityStore !== undefined
        ? dependencies.authorityStore
        : defaultAutomationDutyStore(env);
    const authority = currentSessionAuthority(env);
    const invocationId = randomUUID();
    let refusalDuty;
    if (authority && options.deviceId && authorityStore) {
        refusalDuty = {
            schemaVersion: 1,
            kind: 'maestro-cleanup-refusal',
            invocationId,
            sessionId: authority.sessionId,
            claimEpoch: authority.claimEpoch,
            platform: options.platform,
            deviceId: options.deviceId,
            startedAt: new Date().toISOString(),
            tool: options.tool,
        };
        try {
            authorityStore.write(refusalDuty);
        }
        catch (error) {
            return {
                stdout: '',
                stderr: '',
                code: null,
                signal: null,
                timedOut: false,
                cleanupProven: true,
                cleanupEscalated: false,
                error: `Failed to establish managed automation authority: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    const baseline = new Set();
    let baselineComplete = !options.deviceId;
    if (options.deviceId) {
        try {
            for (const pid of selectExactDeviceAutomationPids(listProcesses(), options.deviceId)) {
                baseline.add(pid);
            }
            baselineComplete = true;
        }
        catch {
            // Attribution is fallback-only. A failed pre-scan must not block the
            // proven process-group path or broaden ownership.
        }
    }
    let child;
    try {
        child = spawnProcess(bin, args, {
            detached: process.platform !== 'win32',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (error) {
        if (refusalDuty)
            clearAutomationDuty(options.platform, refusalDuty.deviceId, authorityStore);
        return {
            stdout: '',
            stderr: '',
            code: null,
            signal: null,
            timedOut: false,
            cleanupProven: true,
            cleanupEscalated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const terminalObserver = observeChildTerminal(child, options.timeoutMs);
    const pid = child.pid;
    if (!pid) {
        const terminal = await terminalObserver.result;
        if (refusalDuty)
            clearAutomationDuty(options.platform, refusalDuty.deviceId, authorityStore);
        return {
            stdout: '',
            stderr: '',
            code: null,
            signal: null,
            timedOut: false,
            cleanupProven: true,
            cleanupEscalated: false,
            error: terminal.error ?? 'Managed automation process did not expose a PID',
        };
    }
    const birth = readBirth(pid);
    const statePath = options.deviceId
        ? automationStatePath(options.platform, options.deviceId)
        : undefined;
    let state;
    const persistResidualAttribution = (recoverableState) => {
        const attributed = [];
        let attributionComplete = false;
        if (baselineComplete && options.deviceId) {
            try {
                attributionComplete = true;
                for (const candidate of selectExactDeviceAutomationPids(listProcesses(), options.deviceId)) {
                    if (baseline.has(candidate))
                        continue;
                    const observed = probeBirth(candidate);
                    if (observed.status === 'present') {
                        attributed.push({ pid: candidate, processBirth: observed.birth.token });
                    }
                    else if (observed.status === 'unknown') {
                        attributionComplete = false;
                    }
                }
            }
            catch {
                attributionComplete = false;
            }
        }
        recoverableState.attributedProcesses = attributed;
        recoverableState.attributionComplete = attributionComplete;
        recoverableState.revision += 1;
        rememberAutomationDuty(recoverableState);
        let authorityUpdated = false;
        let stateFileUpdated = false;
        if (authorityStore) {
            try {
                authorityStore.write(recoverableState);
                authorityUpdated = true;
            }
            catch { }
        }
        try {
            writeState(statePath, recoverableState);
            stateFileUpdated = true;
        }
        catch { }
        return stateFileUpdated || authorityUpdated;
    };
    const persistProvenCleanup = (recoverableState) => {
        recoverableState.attributedProcesses = [];
        recoverableState.attributionComplete = true;
        recoverableState.revision += 1;
        rememberAutomationDuty(recoverableState);
        let authorityUpdated = false;
        let stateFileUpdated = false;
        if (authorityStore) {
            try {
                authorityStore.write(recoverableState);
                authorityUpdated = true;
            }
            catch { }
        }
        try {
            writeState(statePath, recoverableState);
            stateFileUpdated = true;
        }
        catch { }
        return stateFileUpdated || authorityUpdated;
    };
    if (authority && options.deviceId && !birth) {
        const cleanup = await terminateProcessGroup(pid, signalGroup, delay);
        terminalObserver.stop();
        if (cleanup.presence === 'absent') {
            clearAutomationDuty(options.platform, options.deviceId, authorityStore);
        }
        return {
            stdout: '',
            stderr: '',
            code: null,
            signal: cleanup.escalated ? 'SIGKILL' : 'SIGTERM',
            timedOut: false,
            cleanupProven: cleanup.presence === 'absent',
            cleanupEscalated: cleanup.escalated,
            error: 'AUTOMATION_CLEANUP_UNPROVEN: process-birth authority was unavailable before Maestro dispatch',
        };
    }
    if (authority && options.deviceId && birth) {
        state = {
            schemaVersion: 1,
            kind: 'maestro-process-group',
            revision: 0,
            attributionComplete: false,
            invocationId,
            sessionId: authority.sessionId,
            claimEpoch: authority.claimEpoch,
            platform: options.platform,
            deviceId: options.deviceId,
            pid,
            pgid: pid,
            processBirth: birth.token,
            startedAt: new Date().toISOString(),
            tool: options.tool,
            attributedProcesses: [],
        };
        rememberAutomationDuty(state);
        let persistenceError;
        if (authorityStore) {
            try {
                authorityStore.write(state);
            }
            catch (error) {
                persistenceError = error;
            }
        }
        try {
            writeState(statePath, state);
        }
        catch (error) {
            persistenceError ??= error;
            const cleanup = await terminateProcessGroup(pid, signalGroup, delay);
            const cleanupProven = cleanup.presence === 'absent';
            const residualPersisted = cleanupProven
                ? persistProvenCleanup(state)
                : persistResidualAttribution(state);
            terminalObserver.stop();
            let clearError;
            if (cleanupProven) {
                try {
                    clearAutomationDuty(options.platform, options.deviceId, authorityStore);
                }
                catch (error) {
                    clearError = error;
                }
            }
            return {
                stdout: '',
                stderr: '',
                code: null,
                signal: cleanup.escalated ? 'SIGKILL' : 'SIGTERM',
                timedOut: false,
                cleanupProven,
                cleanupEscalated: cleanup.escalated,
                error: clearError
                    ? `AUTOMATION_CLEANUP_UNPROVEN: proven cleanup duty could not be cleared: ${clearError instanceof Error ? clearError.message : String(clearError)}`
                    : cleanupProven
                        ? `Failed to persist managed automation state: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`
                        : residualPersisted
                            ? 'AUTOMATION_CLEANUP_UNPROVEN: process-group absence could not be confirmed'
                            : 'AUTOMATION_CLEANUP_UNPROVEN: managed automation state and residual attribution could not be persisted',
            };
        }
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let overflow = false;
    const collect = (target) => (chunk) => {
        if (outputBytes >= OUTPUT_LIMIT) {
            overflow = true;
            return;
        }
        const remaining = OUTPUT_LIMIT - outputBytes;
        target.push(chunk.subarray(0, remaining));
        outputBytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining)
            overflow = true;
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const terminal = await terminalObserver.result;
    let cleanupEscalated = false;
    let presence = await waitForGroupAbsence(pid, signalGroup, delay, terminal.timedOut ? 0 : 250);
    if (terminal.timedOut || overflow || presence === 'present') {
        try {
            signalGroup(pid, 'SIGTERM');
        }
        catch {
            /* raced with exit */
        }
        presence = await waitForGroupAbsence(pid, signalGroup, delay, TERM_GRACE_MS);
        if (presence === 'present') {
            cleanupEscalated = true;
            try {
                signalGroup(pid, 'SIGKILL');
            }
            catch {
                /* raced with exit */
            }
            presence = await waitForGroupAbsence(pid, signalGroup, delay);
        }
    }
    const cleanupProven = presence === 'absent';
    let dutyClearError;
    if (!cleanupProven && state && options.deviceId) {
        if (!persistResidualAttribution(state)) {
            return {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                code: terminal.code,
                signal: terminal.signal,
                timedOut: terminal.timedOut,
                cleanupProven: false,
                cleanupEscalated,
                error: 'AUTOMATION_CLEANUP_UNPROVEN: residual automation attribution could not be persisted',
            };
        }
    }
    if (cleanupProven && state && statePath && options.deviceId) {
        persistProvenCleanup(state);
        try {
            clearAutomationDuty(options.platform, options.deviceId, authorityStore);
        }
        catch (error) {
            dutyClearError = error;
        }
    }
    return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: terminal.code,
        signal: terminal.signal,
        timedOut: terminal.timedOut,
        cleanupProven,
        cleanupEscalated,
        ...(dutyClearError
            ? {
                error: `AUTOMATION_CLEANUP_UNPROVEN: proven cleanup duty could not be cleared: ${dutyClearError instanceof Error ? dutyClearError.message : String(dutyClearError)}`,
            }
            : overflow
                ? { error: 'Maestro output exceeded 10 MiB' }
                : terminal.error
                    ? { error: terminal.error }
                    : {}),
    };
}
export function inspectAutomationDuty(platform, deviceId, dependencies = {}) {
    const path = automationStatePath(platform, deviceId);
    const authorityStore = dependencies.authorityStore !== undefined
        ? dependencies.authorityStore
        : defaultAutomationDutyStore(process.env);
    const state = currentAutomationDuty(platform, deviceId, authorityStore);
    if (!state) {
        if (existsSync(path)) {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: persisted automation state is invalid');
        }
        return null;
    }
    if (state.kind === 'maestro-cleanup-refusal')
        return state;
    const signalGroup = dependencies.signalGroup ??
        ((pgid, signal) => {
            if (process.platform === 'win32')
                process.kill(pgid, signal);
            else
                process.kill(-pgid, signal);
        });
    const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
    const group = groupPresence(state.pgid, signalGroup);
    const descendantsAbsent = state.attributedProcesses.every((owned) => {
        const observed = probeBirth(owned.pid);
        return (observed.status === 'absent' ||
            (observed.status === 'present' && observed.birth.token !== owned.processBirth));
    });
    if (group === 'absent' && state.attributionComplete && descendantsAbsent) {
        clearAutomationDuty(platform, deviceId, authorityStore);
        return null;
    }
    return state;
}
export async function recoverAutomationDuty(authority, dependencies = {}) {
    const path = automationStatePath(authority.platform, authority.deviceId);
    const authorityStore = dependencies.authorityStore !== undefined
        ? dependencies.authorityStore
        : defaultAutomationDutyStore(process.env);
    const state = currentAutomationDuty(authority.platform, authority.deviceId, authorityStore);
    if (!state) {
        if (existsSync(path)) {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: persisted automation state is invalid');
        }
        return { recovered: false };
    }
    if (state.sessionId !== authority.sessionId || state.claimEpoch !== authority.claimEpoch) {
        throw new Error('AUTOMATION_CLEANUP_UNPROVEN: persisted automation belongs to another session epoch');
    }
    if (state.kind === 'maestro-cleanup-refusal') {
        throw new Error('AUTOMATION_CLEANUP_UNPROVEN: cleanup is fenced without PID-birth recovery authority');
    }
    const delay = dependencies.sleep ?? sleep;
    const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
    const signalGroup = dependencies.signalGroup ??
        ((pgid, signal) => {
            if (process.platform === 'win32')
                process.kill(pgid, signal);
            else
                process.kill(-pgid, signal);
        });
    const signalProcess = dependencies.signalProcess ?? process.kill;
    let escalated = false;
    let presence = groupPresence(state.pgid, signalGroup);
    const leader = probeBirth(state.pid);
    if (presence === 'present') {
        if (leader.status !== 'present' || leader.birth.token !== state.processBirth) {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: process-group leader identity cannot be proven');
        }
        try {
            signalGroup(state.pgid, 'SIGTERM');
        }
        catch { }
        presence = await waitForGroupAbsence(state.pgid, signalGroup, delay, TERM_GRACE_MS);
        if (presence === 'present') {
            escalated = true;
            try {
                signalGroup(state.pgid, 'SIGKILL');
            }
            catch { }
            presence = await waitForGroupAbsence(state.pgid, signalGroup, delay);
        }
        if (presence !== 'absent') {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: process-group absence could not be confirmed');
        }
    }
    if (presence === 'unknown') {
        throw new Error('AUTOMATION_CLEANUP_UNPROVEN: process-group presence is unknown');
    }
    for (const owned of state.attributedProcesses) {
        const observed = probeBirth(owned.pid);
        if (observed.status === 'unknown') {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: attributed process identity is unknown');
        }
        if (observed.status === 'absent')
            continue;
        if (observed.birth.token !== owned.processBirth) {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: attributed PID birth changed; refusing cleanup');
        }
        try {
            signalProcess(owned.pid, 'SIGTERM');
        }
        catch { }
        await delay(TERM_GRACE_MS);
        const afterTerm = probeBirth(owned.pid);
        if (afterTerm.status === 'present' && afterTerm.birth.token === owned.processBirth) {
            escalated = true;
            try {
                signalProcess(owned.pid, 'SIGKILL');
            }
            catch { }
            await delay(50);
        }
        const after = probeBirth(owned.pid);
        if (after.status === 'unknown' ||
            (after.status === 'present' && after.birth.token === owned.processBirth)) {
            throw new Error('AUTOMATION_CLEANUP_UNPROVEN: attributed process absence could not be confirmed');
        }
    }
    if (!state.attributionComplete) {
        throw new Error('AUTOMATION_CLEANUP_UNPROVEN: residual automation attribution is incomplete');
    }
    clearAutomationDuty(authority.platform, authority.deviceId, authorityStore);
    return { recovered: true, invocationId: state.invocationId, escalated };
}
export function removeTemporaryInlineFlow(path) {
    safeUnlink(path);
}
