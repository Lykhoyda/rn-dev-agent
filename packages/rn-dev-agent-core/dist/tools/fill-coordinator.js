/**
 * The single exact-fill transition table. The controlled helper gets first
 * refusal because only it can prove React ownership. Native is entered only
 * when that helper positively classifies the target as uncontrolled. Each
 * owner is called at most once; an uncertain dispatch is terminal.
 */
export async function runFillCoordinator(request, deps) {
    let controlled;
    try {
        controlled = await deps.controlledFill(request);
    }
    catch {
        return {
            kind: 'failure',
            code: 'TEXT_ENTRY_UNVERIFIED',
            mutation: 'possible',
            reason: 'dispatch-uncertain',
            owner: 'fiber',
        };
    }
    if (controlled.kind === 'success') {
        return { ...controlled, owner: 'fiber' };
    }
    if (controlled.kind === 'failure') {
        return { ...controlled, owner: 'fiber' };
    }
    try {
        const native = await deps.nativeFill(request);
        return native.kind === 'success'
            ? { ...native, owner: 'native' }
            : { ...native, owner: 'native' };
    }
    catch {
        return {
            kind: 'failure',
            code: 'TEXT_ENTRY_UNVERIFIED',
            mutation: 'possible',
            reason: 'dispatch-uncertain',
            owner: 'native',
        };
    }
}
