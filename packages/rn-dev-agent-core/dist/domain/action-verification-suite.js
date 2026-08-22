import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { isLearnedActionPath, replayCompatibilityPreflight, standaloneLearnedActionPathRefusal, } from './action-engine-compat.js';
import { resolveActionPath } from './action-store.js';
import { parseAndValidateFlow } from './maestro-validator.js';
import { parseM7Header } from './reusable-action.js';
export function prepareActionVerificationSuite(files, flowDir, engineStatus) {
    const prepared = [];
    const errors = [];
    for (const file of files) {
        try {
            const actionPathRefusal = standaloneLearnedActionPathRefusal(file);
            if (actionPathRefusal)
                throw new Error(actionPathRefusal);
            const text = readFileSync(file, 'utf8');
            const parsed = parseAndValidateFlow(text, { flowDir: dirname(file), flowRoot: flowDir });
            const id = basename(file).replace(/\.ya?ml$/i, '');
            const meta = parseM7Header(text, id);
            const owned = isLearnedActionPath(file);
            if (owned) {
                const projectRoot = dirname(dirname(dirname(file)));
                const resolvedPath = resolveActionPath(projectRoot, id);
                if (resolvedPath === null || resolve(resolvedPath) !== resolve(file)) {
                    throw new Error(`Action ${id} did not resolve to ${file}`);
                }
            }
            const refusal = replayCompatibilityPreflight({
                enginePin: meta?.enginePin,
                commands: parsed.commands,
                engineStatus,
                requireEnginePin: meta !== null || owned,
            });
            if (refusal)
                throw new Error(refusal);
            prepared.push({ file, inlineYaml: parsed.raw });
        }
        catch (err) {
            errors.push({ file, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return { prepared, errors };
}
