import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function loadE2eConfig(projectRoot) {
    const filePath = join(projectRoot, '.rn-agent', 'e2e.config.json');
    try {
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export function resolveParams(config, testId, required) {
    const merged = {
        ...config.defaults?.params,
        ...config.tests?.[testId]?.params,
    };
    const missing = required.filter((k) => !merged[k]);
    if (missing.length > 0)
        return { ok: false, missing };
    const params = {};
    for (const k of required)
        params[k] = merged[k];
    for (const k of Object.keys(merged)) {
        if (!(k in params))
            params[k] = merged[k];
    }
    return { ok: true, params: merged };
}
export function secretValuesFor(config, params) {
    const names = new Set(config.secretParams ?? []);
    return Object.entries(params)
        .filter(([k, v]) => names.has(k) && v !== '')
        .map(([, v]) => v);
}
export function redactSecrets(text, secretValues) {
    const active = secretValues.filter((s) => s !== '');
    if (active.length === 0)
        return text;
    let result = text;
    for (const secret of active) {
        result = result.split(secret).join('***');
    }
    return result;
}
