import { instrumentStartupSource } from './startup-integrity.js';
let entrypointUrl = null;
export function initialize(data) {
    const value = data;
    if (!value ||
        typeof value.entrypointUrl !== 'string' ||
        !value.entrypointUrl.startsWith('file:')) {
        throw new Error('STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint URL is invalid');
    }
    entrypointUrl = value.entrypointUrl;
}
export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (url !== entrypointUrl)
        return result;
    if (result.source === null || result.source === undefined || result.format !== 'module') {
        throw new Error('STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint source is unavailable');
    }
    const instrumented = instrumentStartupSource(url, result.source);
    return {
        ...result,
        source: instrumented.source,
        shortCircuit: true,
    };
}
