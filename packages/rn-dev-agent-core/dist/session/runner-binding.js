import { getFastRunnerState } from '../runners/rn-fast-runner-client.js';
import { getAndroidRunnerState } from '../runners/rn-android-runner-client.js';
import { inspectSessionOwner } from './process-owner.js';
import { SessionAuthorityError } from './registry.js';
export function bindNativeRunner(runtime, target) {
    const { registry, session } = runtime.requireAvailable();
    const status = registry.getSessionStatus(session.sessionId);
    const expectedDevice = status?.bindings.device;
    if (!status ||
        expectedDevice?.platform !== target.platform ||
        expectedDevice.deviceId !== target.deviceId ||
        expectedDevice.appId !== target.appId) {
        throw new SessionAuthorityError('DEVICE_AUTHORITY_MISMATCH', 'native runner target does not match the exact claimed device and app');
    }
    const state = target.platform === 'ios' ? getFastRunnerState() : getAndroidRunnerState();
    const port = state && ('port' in state ? state.port : state.hostPort);
    if (!state ||
        !Number.isSafeInteger(port) ||
        !state.instanceId ||
        state.sessionId !== session.sessionId ||
        state.claimEpoch !== session.claimEpoch ||
        !state.capability ||
        !state.processBirth ||
        inspectSessionOwner({
            sessionId: session.sessionId,
            pid: state.pid,
            token: state.processBirth,
        }) !== 'match') {
        throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'native runner process and capability could not be bound to this claim epoch');
    }
    registry.claimResources(session, [
        { type: 'runner', key: `${target.platform}:${target.deviceId}:${port}` },
    ]);
    registry.updateBindings(session, {
        state: status.bindings.bundle ? 'ready' : 'runtime_bound',
        bindings: {
            runner: {
                platform: target.platform,
                port,
                pid: state.pid,
                processBirth: state.processBirth,
                instanceId: state.instanceId,
                sessionId: state.sessionId,
                claimEpoch: state.claimEpoch,
                capability: state.capability,
                deviceId: target.deviceId,
                appId: target.appId,
                protocolVersion: state.protocolVersion,
            },
        },
    });
}
export function unbindNativeRunner(runtime) {
    const { registry, session } = runtime.requireAvailable();
    const status = registry.getSessionStatus(session.sessionId);
    const runner = status?.bindings.runner;
    if (!status || !runner)
        return;
    registry.releaseResources(session, [
        {
            type: 'runner',
            key: `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`,
        },
    ]);
    registry.updateBindings(session, {
        state: status.bindings.bundle ? 'ready' : 'device_bound',
        bindings: { runner: null },
    });
}
