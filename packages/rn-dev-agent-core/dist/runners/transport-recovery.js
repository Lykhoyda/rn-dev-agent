import { randomUUID } from 'node:crypto';
// Story 14 (#407): shared post-send transport-recovery policy for both native
// runner clients. Pure decisions only — the clients own fetch mechanics.
// Every verb whose execution changes device/app state. A lost response to any
// of these must NEVER trigger a resend: the tap may have landed. Union of both
// runners' surfaces (iOS CommandType + Android SUPPORTED_COMMANDS + client verbs).
const MUTATING_COMMANDS = new Set([
    'tap',
    'mouseClick',
    'tapSeries',
    'longPress',
    'drag',
    'dragSeries',
    'remotePress',
    'type',
    'fill',
    'press',
    'swipe',
    'scroll',
    'back',
    'backInApp',
    'backSystem',
    'home',
    'pressHome',
    'rotate',
    'appSwitcher',
    'keyboardDismiss',
    'dismissKeyboard',
    'keyboard',
    'alert',
    'pinch',
    'activate',
    'terminate',
    'shutdown',
]);
export function isMutatingCommand(command) {
    return MUTATING_COMMANDS.has(String(command));
}
export function generateCommandId() {
    return `c-${randomUUID()}`;
}
// A failure warrants a status probe only when the command MAY have reached the
// runner. "not started" never sent anything; a protocol mismatch is a reply we
// received and understood. Everything else (abort timeout, connection reset,
// unparseable reply) is ambiguous — probing a dead runner just fails fast to
// the existing invalidation path.
export function isAmbiguousTransportFailure(message) {
    if (message.startsWith('RUNNER_PROTOCOL_MISMATCH'))
        return false;
    if (/not started/i.test(message))
        return false;
    return true;
}
const PROBE_STATES = new Set(['completed', 'failed', 'unknown']);
export function parseStatusProbeReply(resp, expectedCommandId) {
    if (!resp || typeof resp !== 'object')
        return null;
    const r = resp;
    if (r.ok !== true || !r.data || typeof r.data !== 'object')
        return null;
    const data = r.data;
    if (data.commandId !== expectedCommandId)
        return null;
    if (typeof data.state !== 'string' || !PROBE_STATES.has(data.state))
        return null;
    const reply = { state: data.state };
    // A retained result must look like a runner response (object with boolean ok)
    // before we hand it back as one — anything else degrades to state-only.
    if (data.result !== undefined &&
        data.result !== null &&
        typeof data.result === 'object' &&
        typeof data.result.ok === 'boolean') {
        reply.result = data.result;
    }
    return reply;
}
export function decideRecovery(probe, command) {
    if (!probe || probe.state === 'unknown')
        return { action: 'rethrow' };
    if (probe.result !== undefined) {
        return {
            action: 'return-recovered',
            response: probe.result,
            outcome: probe.state === 'failed' ? 'recovered-error' : 'recovered',
        };
    }
    if (probe.state === 'completed' && !isMutatingCommand(command)) {
        return { action: 'resend-once' };
    }
    return { action: 'rethrow' };
}
