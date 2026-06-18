import { okResult, failResult, withConnection } from "../utils.js";
/**
 * Pure builder — returns a JS expression that, when evaluated in Hermes,
 * performs the MMKV action and returns a JSON-stringified result.
 *
 * Extracted from the handler so tests can verify the expression shape
 * without spinning up Hermes. Format follows the existing pattern in
 * other CDP tools: an IIFE that catches all error paths and emits a
 * `__agent_error` sentinel for the handler to surface as failResult.
 *
 * The JS template is plain ES5 — Hermes supports more, but ES5 keeps
 * this readable and matches the style of injected-helpers.ts.
 */
export function buildMmkvExpression(args) {
    const instanceId = args.instanceId ?? "mmkv.default";
    const valueType = args.type ?? "string";
    let actionBody;
    switch (args.action) {
        case "get": {
            if (typeof args.key !== "string" || args.key.length === 0) {
                return `JSON.stringify({ __agent_error: 'get requires non-empty key' })`;
            }
            // GH #209: `getBoolean` — the spelling on BOTH the Nitro hybrid object
            // (MMKV.nitro.ts) and the JS wrapper class. The previous `getBool`
            // existed on neither; type=boolean reads were broken since the tool
            // shipped.
            const getMethod = valueType === "number" ? "getNumber" : valueType === "boolean" ? "getBoolean" : "getString";
            actionBody = `var v = mmkv.${getMethod}(${JSON.stringify(args.key)}); return JSON.stringify({ value: v === undefined ? null : v });`;
            break;
        }
        case "set": {
            if (typeof args.key !== "string" || args.key.length === 0) {
                return `JSON.stringify({ __agent_error: 'set requires non-empty key' })`;
            }
            if (args.value === undefined || args.value === null) {
                return `JSON.stringify({ __agent_error: 'set requires value' })`;
            }
            // MMKV's `set` is overloaded by JS-side type inference; pass the
            // raw literal cast to the requested type.
            let valueLiteral;
            if (valueType === "number") {
                valueLiteral = String(Number(args.value));
            }
            else if (valueType === "boolean") {
                valueLiteral = args.value === true || args.value === "true" ? "true" : "false";
            }
            else {
                valueLiteral = JSON.stringify(String(args.value));
            }
            actionBody = `mmkv.set(${JSON.stringify(args.key)}, ${valueLiteral}); return JSON.stringify({ ok: true });`;
            break;
        }
        case "delete": {
            if (typeof args.key !== "string" || args.key.length === 0) {
                return `JSON.stringify({ __agent_error: 'delete requires non-empty key' })`;
            }
            // GH #209: the raw Nitro hybrid object (v4 / 3.0-beta line) exposes
            // `remove(key)` per MMKV.nitro.ts — `delete(key)` only exists on the JS
            // wrapper class. Prefer the spec name, fall back to the wrapper name,
            // and fail with a named error instead of a bare TypeError.
            actionBody = `if (typeof mmkv.remove === 'function') { mmkv.remove(${JSON.stringify(args.key)}); }
      else if (typeof mmkv.delete === 'function') { mmkv.delete(${JSON.stringify(args.key)}); }
      else { return JSON.stringify({ __agent_error: 'MMKV instance has neither remove() nor delete() — unexpected API surface; report the react-native-mmkv version' }); }
      return JSON.stringify({ ok: true });`;
            break;
        }
        case "has": {
            if (typeof args.key !== "string" || args.key.length === 0) {
                return `JSON.stringify({ __agent_error: 'has requires non-empty key' })`;
            }
            actionBody = `var present = mmkv.contains(${JSON.stringify(args.key)}); return JSON.stringify({ present: !!present });`;
            break;
        }
        case "keys": {
            actionBody = `var ks = mmkv.getAllKeys(); return JSON.stringify({ keys: ks || [] });`;
            break;
        }
        case "clear": {
            actionBody = `mmkv.clearAll(); return JSON.stringify({ cleared: true });`;
            break;
        }
        default: {
            // Use JSON.stringify to safely embed user-supplied action — even though
            // zod gates this at the tool boundary, the helper is exported and could
            // be invoked from internal callers that bypass schema validation.
            return `JSON.stringify({ __agent_error: 'unknown action: ' + ${JSON.stringify(String(args.action))} })`;
        }
    }
    return `(function() {
    try {
      var nitro = globalThis.NitroModulesProxy;
      if (typeof nitro !== 'object' || !nitro || typeof nitro.createHybridObject !== 'function') {
        return JSON.stringify({ __agent_error: 'NitroModulesProxy not available — requires react-native-mmkv v3+ (Nitro-based). For older MMKV versions, expose globalThis.__MMKV__ in your app entry.' });
      }
      var factory = nitro.createHybridObject('MMKVFactory');
      if (!factory || typeof factory.createMMKV !== 'function') {
        return JSON.stringify({ __agent_error: 'MMKVFactory not registered — is react-native-mmkv installed?' });
      }
      var mmkv = factory.createMMKV({ id: ${JSON.stringify(instanceId)} });
      if (!mmkv) {
        return JSON.stringify({ __agent_error: 'createMMKV returned no instance for id=' + ${JSON.stringify(instanceId)} });
      }
      ${actionBody}
    } catch (e) {
      return JSON.stringify({ __agent_error: 'MMKV op threw: ' + (e && e.message ? e.message : String(e)) });
    }
  })()`;
}
export function createMmkvHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const expr = buildMmkvExpression(args);
        const result = await client.evaluate(expr);
        if (result.error) {
            return failResult(`MMKV evaluate error: ${result.error}`);
        }
        if (typeof result.value !== "string") {
            return failResult("Unexpected response from MMKV expression (not a string)");
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Could not parse MMKV response: ${result.value.slice(0, 200)}`);
        }
        if (parsed !== null && typeof parsed === "object") {
            const obj = parsed;
            if ("__agent_error" in obj) {
                return failResult(String(obj.__agent_error));
            }
        }
        return okResult(parsed);
    });
}
