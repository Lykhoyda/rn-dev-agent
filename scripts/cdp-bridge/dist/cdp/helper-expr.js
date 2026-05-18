// CodeQL js/bad-code-sanitization (alerts #23 #24):
// `call` is interpolated into a JavaScript expression that the MCP server
// sends to Hermes via Runtime.evaluate. All production call sites use
// hardcoded method names + JSON.stringify'd arguments (e.g. `getStoreState(${pathArg}, ${typeArg})`
// where pathArg/typeArg come from JSON.stringify), so injection is not
// reachable in practice. The validator below adds defense in depth by
// rejecting any `call` containing characters that could escape the
// surrounding function-call boundary.
const SAFE_CALL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*\([^;{}]*\)$/;
function validateCall(call) {
    if (!SAFE_CALL_RE.test(call)) {
        throw new Error(`helper-expr: refusing to interpolate untrusted call "${call.slice(0, 80)}"; ` +
            `expected identifier-prefixed parenthesized expression with no ;{} characters.`);
    }
}
export function helperExpr(call, bridgeDetected) {
    validateCall(call);
    return bridgeDetected ? `__RN_DEV_BRIDGE__.${call}` : `__RN_AGENT.${call}`;
}
export function bridgeWithFallback(call, bridgeDetected) {
    validateCall(call);
    return bridgeDetected
        ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __RN_AGENT.${call}; })()`
        : `__RN_AGENT.${call}`;
}
