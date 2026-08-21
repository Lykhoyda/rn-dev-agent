import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { okResult, failResult } from '../utils.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { buildMaestroFlow, isValidBundleId, isSafeMaestroScalar, MaestroValidationError, } from '../domain/maestro-validator.js';
import { ACTION_ENGINE_PIN } from '../domain/engine-pin.js';
import { regexSelectorCapabilityRefusal } from '../domain/action-engine-compat.js';
import { assertOwnedActionCorpus, joinYaml, resolveActionPath, splitYaml, } from '../domain/action-store.js';
import { serializeM7Header } from '../domain/reusable-action.js';
import { isValidActionId } from '../domain/path-safety.js';
/**
 * Phase 134.1 (deepsec CRITICAL #3): every step is now produced as a
 * structured object that flows through `buildMaestroFlow` for serialization,
 * so testID / text / input / url / direction scalars never reach a
 * string-concat path. The validator rejects scalars that contain CR/LF,
 * YAML document separators, unicode line breaks, or control characters
 * before the file is written.
 *
 * Swipe directions are constrained to the 4 enum values at this layer too
 * — the deepsec finding noted that saved recordings could land non-enum
 * directions if loaded from JSON without runtime validation.
 */
function stepToMaestroCommands(step) {
    const ALLOWED_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
    switch (step.action) {
        case 'launch':
            return [{ launchApp: null }];
        case 'tap':
            if (step.testID)
                return [{ tapOn: { id: step.testID } }];
            if (step.text)
                return [{ tapOn: step.text }];
            return [];
        case 'fill':
            if (step.testID && step.input !== undefined) {
                return [{ tapOn: { id: step.testID } }, { inputText: step.input }];
            }
            if (step.text && step.input !== undefined) {
                return [{ tapOn: step.text }, { inputText: step.input }];
            }
            return [];
        case 'assert':
            if (step.testID)
                return [{ assertVisible: { id: step.testID } }];
            if (step.text)
                return [{ assertVisible: step.text }];
            return [];
        case 'scroll':
            return [{ scroll: null }];
        case 'swipe': {
            const dir = step.direction;
            if (dir && ALLOWED_DIRECTIONS.has(dir)) {
                return [{ swipe: { direction: dir.toUpperCase() } }];
            }
            return [{ swipe: { direction: 'UP' } }];
        }
        case 'navigate':
            if (step.url)
                return [{ openLink: step.url }];
            return [];
        case 'back':
            return [{ pressKey: 'back' }];
        case 'wait':
            if (step.waitMs && step.waitMs > 0) {
                return [{ waitForAnimationToEnd: { timeout: step.waitMs } }];
            }
            return [];
        default:
            return [];
    }
}
export function createMaestroGenerateHandler() {
    return async (args) => {
        if (!args.name || !args.steps?.length) {
            return failResult('Provide a flow name and at least one step.');
        }
        if (!isSafeMaestroScalar(args.name)) {
            return failResult('Flow name contains an unsafe control character or is too long.');
        }
        const root = findProjectRoot();
        const outputDir = args.outputDir ?? (root ? join(root, '.rn-agent', 'actions') : null);
        if (!outputDir) {
            return failResult('Cannot determine project root. Pass outputDir explicitly.');
        }
        const sanitizedName = args.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
        if (!isValidActionId(sanitizedName)) {
            return failResult('Flow name must produce an action id that starts with a letter or number and is at most 64 characters.');
        }
        const fileName = `${sanitizedName}.yaml`;
        const filePath = join(outputDir, fileName);
        try {
            const learnedProjectRoot = basename(outputDir) === 'actions' && basename(dirname(outputDir)) === '.rn-agent'
                ? dirname(dirname(outputDir))
                : null;
            const existingPath = learnedProjectRoot
                ? resolveActionPath(learnedProjectRoot, sanitizedName)
                : [filePath, join(outputDir, `${sanitizedName}.yml`)].find((path) => existsSync(path));
            if (existingPath) {
                return failResult(`Action ${sanitizedName} already exists at ${existingPath}.`);
            }
            if (learnedProjectRoot)
                assertOwnedActionCorpus(learnedProjectRoot);
        }
        catch (err) {
            return failResult(err instanceof Error ? err.message : String(err));
        }
        if (args.appId !== undefined && !isValidBundleId(args.appId)) {
            return failResult(`Invalid appId '${String(args.appId).slice(0, 80)}' (Phase 134.1)`);
        }
        const commands = [];
        for (const [index, step] of args.steps.entries()) {
            const stepCommands = stepToMaestroCommands(step);
            if (stepCommands.length === 0) {
                return failResult(`Step ${index + 1} (${step.action}) is missing required input.`);
            }
            commands.push(...stepCommands);
        }
        const compatibilityRefusal = regexSelectorCapabilityRefusal(commands);
        if (compatibilityRefusal)
            return failResult(compatibilityRefusal, 'ENGINE_PIN_MISMATCH');
        let content;
        try {
            const generated = buildMaestroFlow(args.appId ? { appId: args.appId } : {}, commands);
            const parts = splitYaml(generated);
            content = joinYaml({
                ...parts,
                headerLines: serializeM7Header({
                    id: sanitizedName,
                    intent: args.name,
                    status: 'experimental',
                    enginePin: ACTION_ENGINE_PIN,
                }).split('\n'),
            });
        }
        catch (err) {
            if (err instanceof MaestroValidationError) {
                return failResult(`Refusing to write Maestro flow: ${err.message} (Phase 134.1)`);
            }
            throw err;
        }
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }
        writeFileSync(filePath, content, 'utf-8');
        return okResult({
            generated: true,
            path: filePath,
            name: fileName,
            stepCount: args.steps.length,
        });
    };
}
