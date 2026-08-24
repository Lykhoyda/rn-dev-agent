import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { classifyLearnedActionPath, isLearnedActionPath, replayCompatibilityPreflight, standaloneLearnedActionPathRefusal, } from './action-engine-compat.js';
import { captureActionFromContext, openReadableActionLoadContext, } from './action-store.js';
import { parseAndValidateFlow } from './maestro-validator.js';
import { parseM7Header } from './reusable-action.js';
export function prepareActionVerificationSuite(files, flowDir, engineStatus, context) {
    const prepared = [];
    const errors = [];
    const learnedCorpus = classifyLearnedActionPath(resolve(flowDir, '__action__.yaml')) === 'action';
    let learnedContext = context;
    if (learnedCorpus && !learnedContext) {
        try {
            learnedContext =
                openReadableActionLoadContext(dirname(dirname(resolve(flowDir))), {
                    includeRunFlowFiles: true,
                }) ?? undefined;
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { prepared, errors: files.map((file) => ({ file, error })) };
        }
    }
    for (const file of files) {
        try {
            const id = basename(file).replace(/\.ya?ml$/i, '');
            const owned = isLearnedActionPath(file);
            let inlineYaml;
            let commands;
            let meta;
            if (learnedContext) {
                const action = captureActionFromContext(learnedContext, id);
                if (!action || basename(action.filePath) !== basename(file)) {
                    throw new Error(`Action ${id} did not resolve to ${file}`);
                }
                if (!action.replay.ok)
                    throw new Error(action.replay.error);
                inlineYaml = action.replay.yamlText;
                commands = action.replay.commands;
                meta = action.metadata;
            }
            else {
                const actionPathRefusal = standaloneLearnedActionPathRefusal(file);
                if (actionPathRefusal)
                    throw new Error(actionPathRefusal);
                const text = readFileSync(file, 'utf8');
                const parsed = parseAndValidateFlow(text, { flowDir: dirname(file), flowRoot: flowDir });
                inlineYaml = parsed.raw;
                commands = parsed.commands;
                meta = parseM7Header(text, id);
            }
            const refusal = replayCompatibilityPreflight({
                enginePin: meta?.enginePin,
                commands,
                engineStatus,
                requireEnginePin: meta !== null || owned,
            });
            if (refusal)
                throw new Error(refusal);
            prepared.push({
                file,
                inlineYaml,
                ...(meta ? { actionMetadata: meta } : {}),
            });
        }
        catch (err) {
            errors.push({ file, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return { prepared, errors };
}
