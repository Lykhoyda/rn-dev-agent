import { okResult } from '../utils.js';
/**
 * GH#244: after a Maestro flow tears down the runner/daemon (the #237 slot-release),
 * the in-memory session survives but the agent-device session that `close` routes
 * through is gone — the CLI returns SESSION_NOT_FOUND. Treat ONLY that shape as
 * benign; any other error is a real close failure and is surfaced unchanged.
 *
 * Match on the STRUCTURED code first (runAgentDevice → failResult(msg, { code, hint })
 * puts it under meta.code), then a narrow message fallback applied ONLY to the error
 * field — never the whole serialized envelope, so an unrelated failure whose hint
 * mentions the phrase can't be misclassified as benign.
 */
export function isBenignSessionGoneError(result) {
    if (!result.isError)
        return false;
    const text = result.content?.[0]?.text ?? '';
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        // B192: unparseable payload → no error field to scope the match to. Never
        // classify as benign; surface it so a real failure can't be swallowed just
        // because its raw text mentions the phrase.
        return false;
    }
    if ((envelope.meta?.code ?? envelope.code) === 'SESSION_NOT_FOUND')
        return true;
    return /no active session|session not found/i.test(envelope.error ?? '');
}
export async function closeDeviceSession(deps) {
    if (!deps.hasActiveSession()) {
        return okResult({ closed: true, message: 'No active session to close' });
    }
    // GH #383: read the closing session's deviceId before clearActiveSession()
    // wipes it, so the adoption-aware stopFastRunner reaps the right per-device runner.
    const deviceId = deps.getDeviceId?.();
    const result = await deps.closeUnderlyingSession();
    if (!result.isError) {
        deps.clearActiveSession();
        deps.stopFastRunner(deviceId);
        await deps.stopAndroidRunner();
        deps.releaseDeviceLock();
        return result;
    }
    if (isBenignSessionGoneError(result)) {
        deps.clearActiveSession();
        deps.stopFastRunner(deviceId);
        await deps.stopAndroidRunner();
        deps.releaseDeviceLock();
        return okResult({
            closed: true,
            sessionAlreadyGone: true,
            message: 'Underlying device session was already gone (likely torn down by a Maestro flow); cleared local session state.',
        });
    }
    return result;
}
