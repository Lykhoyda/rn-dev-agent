export function helperExpr(call, bridgeDetected) {
    return bridgeDetected ? `__RN_DEV_BRIDGE__.${call}` : `__RN_AGENT.${call}`;
}
export function bridgeWithFallback(call, bridgeDetected) {
    return bridgeDetected
        ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __RN_AGENT.${call}; })()`
        : `__RN_AGENT.${call}`;
}
