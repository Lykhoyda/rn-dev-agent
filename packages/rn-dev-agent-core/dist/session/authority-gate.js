import { randomUUID } from 'node:crypto';
import { failResult } from '../utils.js';
import { authorityErrorMeta, SessionAuthorityError, shortAuthorityIdentity } from './registry.js';
import { authorityProfileFor } from './tool-profiles.js';
const axisBinding = {
    I: 'install',
    M: 'metro',
    B: 'bundle',
    D: 'device',
    R: 'runner',
    O: 'observe',
    P: 'proof',
};
const axisErrors = {
    C: 'SESSION_AUTHORITY_REQUIRED',
    S: 'SOURCE_WORKTREE_MISMATCH',
    I: 'APP_INSTALL_IDENTITY_CHANGED',
    M: 'METRO_AUTHORITY_MISMATCH',
    B: 'BUNDLE_HANDSHAKE_UNAVAILABLE',
    D: 'DEVICE_AUTHORITY_MISMATCH',
    R: 'RUNNER_OWNERSHIP_MISMATCH',
    O: 'OBSERVE_AUTHORITY_MISMATCH',
    P: 'PROOF_AUTHORITY_MISMATCH',
};
function requireCompleteAxes(status, profile) {
    for (const axis of profile.axes) {
        if (axis === 'C') {
            if (!status.worker.instanceId || !status.worker.birthAvailable) {
                throw new SessionAuthorityError(axisErrors.C, 'worker controller identity is incomplete');
            }
            continue;
        }
        if (axis === 'S') {
            if (!status.source.kind) {
                throw new SessionAuthorityError(axisErrors.S, 'source identity is incomplete');
            }
            continue;
        }
        const binding = axisBinding[axis];
        if (binding && !status.bindings[binding]) {
            throw new SessionAuthorityError(axisErrors[axis], `${axis} authority is not bound`);
        }
    }
}
function requireDeviceTransition(status, args) {
    const action = args.action ?? 'snapshot';
    if (action === 'open') {
        for (const binding of ['install', 'metro', 'device']) {
            if (!status.bindings[binding]) {
                throw new SessionAuthorityError(binding === 'install' ? 'APP_INSTALL_IDENTITY_CHANGED' : 'SESSION_AUTHORITY_REQUIRED', `${binding} authority must be bound before opening the native runner`);
            }
        }
        const device = status.bindings.device;
        if (args.platform !== device.platform ||
            args.deviceId !== device.deviceId ||
            args.appId !== device.appId) {
            throw new SessionAuthorityError('DEVICE_AUTHORITY_MISMATCH', 'device_snapshot open arguments must equal the exact session device binding');
        }
    }
}
function bindExactArgument(args, field, expected, code) {
    if (expected === undefined || expected === null || expected === '')
        return;
    const supplied = args[field];
    if (supplied !== undefined && supplied !== expected) {
        throw new SessionAuthorityError(code, `${field} contradicts the active session binding`, undefined, {
            expected: shortAuthorityIdentity(expected),
            observed: shortAuthorityIdentity(supplied),
        });
    }
    args[field] = expected;
}
function bindSessionArguments(status, profile, args) {
    const device = status.bindings.device;
    const metro = status.bindings.metro;
    const install = status.bindings.install;
    if (device && (profile.axes.includes('D') || profile.kind === 'transition')) {
        bindExactArgument(args, 'platform', device.platform, 'DEVICE_AUTHORITY_MISMATCH');
        bindExactArgument(args, 'deviceId', device.deviceId, 'DEVICE_AUTHORITY_MISMATCH');
        bindExactArgument(args, 'appId', device.appId, 'APP_INSTALL_IDENTITY_CHANGED');
        bindExactArgument(args, 'bundleId', device.appId, 'APP_INSTALL_IDENTITY_CHANGED');
    }
    if (install && profile.axes.includes('I')) {
        bindExactArgument(args, 'platform', install.platform, 'APP_INSTALL_IDENTITY_CHANGED');
        bindExactArgument(args, 'deviceId', install.deviceId, 'APP_INSTALL_IDENTITY_CHANGED');
        bindExactArgument(args, 'appId', install.appId, 'APP_INSTALL_IDENTITY_CHANGED');
        bindExactArgument(args, 'bundleId', install.appId, 'APP_INSTALL_IDENTITY_CHANGED');
    }
    if (metro && (profile.axes.includes('M') || profile.kind === 'transition')) {
        bindExactArgument(args, 'metroPort', metro.port, 'METRO_AUTHORITY_MISMATCH');
    }
}
function authorityFailure(error) {
    if (error instanceof SessionAuthorityError) {
        return failResult(error.message, error.code, authorityErrorMeta(error));
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
    return failResult(message, code ?? 'AUTHORITY_LOST_DURING_OPERATION');
}
function addMeta(result, meta) {
    if (!result || typeof result !== 'object')
        return result;
    const toolResult = result;
    const first = toolResult.content?.[0];
    if (!first?.text)
        return result;
    try {
        const envelope = JSON.parse(first.text);
        envelope.meta = {
            ...envelope.meta,
            ...meta,
        };
        return {
            ...toolResult,
            content: [{ ...first, text: JSON.stringify(envelope) }, ...toolResult.content.slice(1)],
        };
    }
    catch {
        return result;
    }
}
function resultSucceeded(result) {
    const first = result?.content?.[0];
    if (!first?.text)
        return false;
    try {
        return JSON.parse(first.text).ok === true;
    }
    catch {
        return false;
    }
}
function receipt(status, profile, observations) {
    return {
        version: 1,
        sessionId: status.sessionId.slice(0, 12),
        claimEpoch: status.claimEpoch,
        authorityVersion: status.authorityVersion,
        axes: observations.map(({ axis, identity, detail }) => ({
            axis,
            identity: identity.slice(0, 16),
            ...(detail ? { detail } : {}),
        })),
        bundle: profile.axes.includes('B')
            ? { authorityScope: 'initial-bundle', sourceFidelity: 'not-proven' }
            : undefined,
    };
}
export function createAuthorityGate(runtime, dependencies) {
    return {
        wrap: (tool, handler) => async (...handlerArgs) => {
            const args = handlerArgs[0] && typeof handlerArgs[0] === 'object'
                ? handlerArgs[0]
                : {};
            const baseProfile = authorityProfileFor(tool);
            const profile = tool === 'rn_session' && args.action === 'status'
                ? {
                    kind: 'diagnostic',
                    axes: [],
                    mutation: false,
                    liveBundleProbe: false,
                }
                : tool === 'observe' && args.action === 'status'
                    ? {
                        kind: 'diagnostic',
                        axes: [],
                        mutation: false,
                        liveBundleProbe: false,
                    }
                    : tool === 'proof_capture' && (args.action === 'status' || args.action === 'contract')
                        ? {
                            kind: 'diagnostic',
                            axes: [],
                            mutation: false,
                            liveBundleProbe: false,
                        }
                        : (tool === 'device_snapshot' &&
                            (args.action === 'open' || args.action === 'close')) ||
                            (tool === 'observe' &&
                                (args.action === 'start' ||
                                    args.action === 'restart' ||
                                    args.action === 'stop')) ||
                            (tool === 'proof_capture' && args.action === 'begin_rehearsal')
                            ? {
                                kind: 'transition',
                                axes: tool === 'proof_capture'
                                    ? ['C', 'S', 'I', 'M', 'B', 'D', 'R']
                                    : ['C', 'S'],
                                mutation: true,
                                liveBundleProbe: tool === 'proof_capture',
                            }
                            : baseProfile;
            if (profile.kind === 'diagnostic') {
                return addMeta(await handler(...handlerArgs), { authoritative: false });
            }
            if (profile.kind === 'transition') {
                try {
                    runtime.requireAvailable();
                    const status = runtime.status();
                    if (!status.available) {
                        throw new SessionAuthorityError(status.code, status.reason);
                    }
                    bindSessionArguments(status, profile, args);
                    requireCompleteAxes(status, profile);
                    if (tool === 'device_snapshot')
                        requireDeviceTransition(status, args);
                    if (tool === 'observe' && (args.action === 'start' || args.action === 'restart')) {
                        requireCompleteAxes(status, {
                            kind: 'authoritative',
                            axes: ['C', 'S', 'I', 'M', 'B', 'D'],
                            mutation: false,
                            liveBundleProbe: true,
                        });
                    }
                    const before = await Promise.all(profile.axes.map((axis) => dependencies.probe({ axis, phase: 'preflight', tool, profile, status, args })));
                    const result = await handler(...handlerArgs);
                    const after = await Promise.all(profile.axes.map((axis) => dependencies.probe({ axis, phase: 'postflight', tool, profile, status, args })));
                    for (let index = 0; index < before.length; index += 1) {
                        if (before[index]?.identity !== after[index]?.identity) {
                            throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', `${before[index]?.axis ?? 'unknown'} authority changed during the transition`);
                        }
                    }
                    if (tool === 'proof_capture' && args.action === 'begin_rehearsal') {
                        const runId = typeof args.runId === 'string' ? args.runId : '';
                        if (!runId) {
                            throw new SessionAuthorityError('PROOF_AUTHORITY_MISMATCH', 'proof transition did not provide a run ID');
                        }
                        const envelope = JSON.parse(result.content?.[0]?.text ?? '{}');
                        if (envelope.ok !== true)
                            return result;
                        const { registry, session } = runtime.requireAvailable();
                        registry.updateBindings(session, {
                            bindings: { proof: { runId } },
                            expectedAuthorityVersion: status.authorityVersion,
                        });
                    }
                    return addMeta(result, {
                        authorityTransition: true,
                        authorityReceipt: receipt(status, profile, after),
                    });
                }
                catch (error) {
                    return authorityFailure(error);
                }
            }
            let operation = null;
            let registry = null;
            try {
                const available = runtime.requireAvailable();
                registry = available.registry;
                const initialStatus = runtime.status();
                if (!initialStatus.available) {
                    throw new SessionAuthorityError(initialStatus.code, initialStatus.reason);
                }
                let status = initialStatus;
                requireCompleteAxes(status, profile);
                bindSessionArguments(status, profile, args);
                operation = registry.beginOperation(available.session, {
                    operationId: randomUUID(),
                    tool,
                    profile: profile.axes.join(''),
                });
                const before = await Promise.all(profile.axes.map((axis) => dependencies.probe({ axis, phase: 'preflight', tool, profile, status, args })));
                registry.verifyOperation(operation);
                const result = await handler(...handlerArgs);
                const replacesRuntimeTarget = tool === 'cdp_reload' || tool === 'cdp_restart';
                if (replacesRuntimeTarget && !resultSucceeded(result)) {
                    const priorBundle = status.bindings.bundle;
                    const metro = status.bindings.metro;
                    const oldTargetId = priorBundle?.targetId;
                    const metroPort = metro?.port;
                    operation = registry.replaceBindingsDuringOperation(operation, {
                        state: 'device_bound',
                        bindings: { bundle: null },
                        releaseResources: typeof oldTargetId === 'string' && Number.isSafeInteger(metroPort)
                            ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
                            : [],
                    });
                    return addMeta(result, {
                        authorityInvalidated: true,
                        nextAction: 'Run rn_session action "pin_dev_client" before another CDP operation.',
                    });
                }
                if (replacesRuntimeTarget && resultSucceeded(result)) {
                    if (!dependencies.refreshRuntimeBinding) {
                        throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'runtime reset cannot commit without a binding refresh');
                    }
                    const priorBundle = status.bindings.bundle;
                    const metro = status.bindings.metro;
                    const bundle = await dependencies.refreshRuntimeBinding(status);
                    const oldTargetId = priorBundle?.targetId;
                    const newTargetId = bundle.targetId;
                    const metroPort = metro?.port;
                    if (typeof oldTargetId !== 'string' ||
                        typeof newTargetId !== 'string' ||
                        !Number.isSafeInteger(metroPort)) {
                        throw new SessionAuthorityError('CDP_TARGET_AUTHORITY_MISMATCH', 'runtime reset did not produce an exact target replacement');
                    }
                    operation = registry.replaceBindingsDuringOperation(operation, {
                        state: 'ready',
                        bindings: { bundle },
                        releaseResources: [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }],
                        claimResources: [{ type: 'target', key: `${String(metroPort)}:${newTargetId}` }],
                    });
                    const refreshedStatus = runtime.status();
                    if (!refreshedStatus.available) {
                        throw new SessionAuthorityError(refreshedStatus.code, refreshedStatus.reason);
                    }
                    status = refreshedStatus;
                }
                const after = await Promise.all(profile.axes.map((axis) => dependencies.probe({ axis, phase: 'postflight', tool, profile, status, args })));
                for (let index = 0; index < before.length; index += 1) {
                    if (replacesRuntimeTarget && before[index]?.axis === 'B')
                        continue;
                    if (before[index]?.identity !== after[index]?.identity) {
                        throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', `${before[index]?.axis ?? 'unknown'} authority changed during the operation`);
                    }
                }
                registry.verifyOperation(operation);
                if (tool === 'proof_capture' &&
                    (args.action === 'finalize' || args.action === 'discard')) {
                    const envelope = JSON.parse(result.content?.[0]?.text ?? '{}');
                    if (envelope.ok === true) {
                        registry.endOperation(operation);
                        operation = null;
                        registry.updateBindings(available.session, {
                            bindings: { proof: null },
                            expectedAuthorityVersion: status.authorityVersion,
                        });
                    }
                }
                return addMeta(result, { authorityReceipt: receipt(status, profile, after) });
            }
            catch (error) {
                return authorityFailure(error);
            }
            finally {
                if (registry && operation) {
                    try {
                        registry.endOperation(operation);
                    }
                    catch {
                        registry.cancelOperation(operation);
                    }
                }
            }
        },
    };
}
