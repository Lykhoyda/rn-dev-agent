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
export function resolveParams(config, testId, required, provided) {
    // Caller-provided values (e.g. typed into the observe UI) take precedence
    // over config; empty strings are treated as "not provided" so a blank input
    // never masks a configured value.
    const overrides = Object.fromEntries(Object.entries(provided ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''));
    const merged = {
        ...config.defaults?.params,
        ...config.tests?.[testId]?.params,
        ...overrides,
    };
    const missing = required.filter((k) => !merged[k]);
    if (missing.length > 0)
        return { ok: false, missing };
    // Return ONLY the params the action declares — never leak unrelated
    // defaults (which may include secrets) into a test that doesn't use them.
    const params = {};
    for (const k of required)
        params[k] = merged[k];
    return { ok: true, params };
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
