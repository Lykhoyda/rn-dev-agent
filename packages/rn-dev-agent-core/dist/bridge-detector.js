const DETECT_EXPRESSION = `
(function() {
  var b = globalThis.__RN_DEV_BRIDGE__;
  if (typeof b !== 'object' || b === null) return JSON.stringify({ present: false, version: null });
  var required = ['getNavState', 'getStoreState', 'getConsole', 'getErrors'];
  for (var i = 0; i < required.length; i++) {
    if (typeof b[required[i]] !== 'function') return JSON.stringify({ present: false, version: null });
  }
  return JSON.stringify({ present: true, version: b.__v || null });
})()
`;
export async function detectBridge(client) {
    try {
        const result = await client.evaluate(DETECT_EXPRESSION);
        if (result.value && typeof result.value === 'string') {
            return JSON.parse(result.value);
        }
    }
    catch {
        // Bridge detection is best-effort — never fatal
    }
    return { present: false, version: null };
}
