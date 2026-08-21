import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ACTION_ENGINE_PIN, MAESTRO_RUNNER_PIN, exactPinRefusal, findRegexTextSelectors, } from './engine-pin.js';
import { parseAndValidateFlow, MaestroValidationError } from './maestro-validator.js';
import { parseM7Header } from './reusable-action.js';
import { splitYaml, joinYaml } from './action-store.js';
export function actionEnginePinRefusal(enginePin) {
    if (!enginePin) {
        return (`Action is not migrated to ${ACTION_ENGINE_PIN}. Run ` +
            `node <plugin-root>/rn-dev-agent-core/dist/maestro-runner-pin.js migrate-actions --root <app> ` +
            `before replay. Incompatible actions are terminal — no manual fallback.`);
    }
    if (enginePin !== ACTION_ENGINE_PIN) {
        return (`Action enginePin ${enginePin} is incompatible with the session pin ${ACTION_ENGINE_PIN}. ` +
            `Migrate or re-record the action. Incompatible actions are terminal — no manual fallback.`);
    }
    return null;
}
export function regexSelectorCapabilityRefusal(commands) {
    const selectors = findRegexTextSelectors(commands);
    if (selectors.length === 0)
        return null;
    return (`Action uses regex text selectors (${selectors[0]}) which are not a validated ` +
        `maestro-runner ${MAESTRO_RUNNER_PIN.version} capability (GH #750 CONTAINS mistranslation). ` +
        `Rewrite as id or literal text selectors before replay. No UI mutation will run.`);
}
export function actionReplayPreflight(opts) {
    const pin = exactPinRefusal(opts.engineStatus);
    if (pin)
        return pin;
    const format = actionEnginePinRefusal(opts.enginePin);
    if (format)
        return format;
    return regexSelectorCapabilityRefusal(opts.commands);
}
export function isLearnedActionPath(path) {
    const parent = dirname(resolve(path));
    return basename(parent) === 'actions' && basename(dirname(parent)) === '.rn-agent';
}
const ENGINE_PIN_LINE = new RegExp(`^#\\s*enginePin\\s*:\\s*.+$`);
export function upsertEnginePinHeader(text) {
    const parts = splitYaml(text);
    const existingIdx = parts.headerLines.findIndex((line) => ENGINE_PIN_LINE.test(line));
    const nextLine = `# enginePin: ${ACTION_ENGINE_PIN}`;
    if (existingIdx >= 0) {
        if (parts.headerLines[existingIdx] === nextLine)
            return { text, changed: false };
        const headerLines = [...parts.headerLines];
        headerLines[existingIdx] = nextLine;
        return { text: joinYaml({ ...parts, headerLines }), changed: true };
    }
    const statusIdx = parts.headerLines.findIndex((line) => /^#\s*status\s*:/.test(line));
    const headerLines = [...parts.headerLines];
    if (statusIdx >= 0)
        headerLines.splice(statusIdx + 1, 0, nextLine);
    else
        headerLines.push(nextLine);
    return { text: joinYaml({ ...parts, headerLines }), changed: true };
}
function isOwnedActionFile(name) {
    return name.endsWith('.yaml') || name.endsWith('.yml');
}
function actionIdFromFile(name) {
    return name.replace(/\.ya?ml$/, '');
}
function inheritedActionsCorpusReason(projectRoot) {
    const rnAgentDir = join(projectRoot, '.rn-agent');
    const actionsDir = join(rnAgentDir, 'actions');
    try {
        if (lstatSync(rnAgentDir).isSymbolicLink()) {
            return (`Refusing to migrate through inherited .rn-agent symlink at ${rnAgentDir}. ` +
                `Symlink-inherited corpora are never modified.`);
        }
    }
    catch {
        return null;
    }
    try {
        if (lstatSync(actionsDir).isSymbolicLink()) {
            return (`Refusing to migrate through inherited .rn-agent/actions symlink at ${actionsDir}. ` +
                `Symlink-inherited corpora are never modified.`);
        }
    }
    catch {
        return null;
    }
    return null;
}
export function migrateLearnedActions(projectRoot) {
    const dir = join(projectRoot, '.rn-agent', 'actions');
    const inherited = inheritedActionsCorpusReason(projectRoot);
    if (inherited) {
        return [
            {
                id: 'actions',
                path: dir,
                status: 'incompatible',
                reason: inherited,
                mutated: false,
            },
        ];
    }
    let files = [];
    try {
        files = readdirSync(dir).filter(isOwnedActionFile);
    }
    catch {
        return [];
    }
    const results = [];
    for (const name of files) {
        const path = join(dir, name);
        const id = actionIdFromFile(name);
        try {
            if (lstatSync(path).isSymbolicLink()) {
                results.push({
                    id,
                    path,
                    status: 'incompatible',
                    reason: `Refusing to migrate through inherited action symlink at ${path}. ` +
                        `Symlink-inherited corpora are never modified.`,
                    mutated: false,
                });
                continue;
            }
        }
        catch (err) {
            results.push({
                id,
                path,
                status: 'unreadable',
                reason: err instanceof Error ? err.message : String(err),
                mutated: false,
            });
            continue;
        }
        let text;
        try {
            text = readFileSync(path, 'utf8');
        }
        catch (err) {
            results.push({
                id,
                path,
                status: 'unreadable',
                reason: err instanceof Error ? err.message : String(err),
                mutated: false,
            });
            continue;
        }
        const meta = parseM7Header(text, id);
        if (!meta) {
            results.push({
                id,
                path,
                status: 'unreadable',
                reason: 'missing M7 id/intent',
                mutated: false,
            });
            continue;
        }
        let commands = [];
        try {
            commands = parseAndValidateFlow(text, { flowDir: dirname(path), flowRoot: dir }).commands;
        }
        catch (err) {
            const reason = err instanceof MaestroValidationError ? err.message : String(err);
            results.push({ id, path, status: 'unreadable', reason, mutated: false });
            continue;
        }
        const selectorRefusal = regexSelectorCapabilityRefusal(commands);
        if (selectorRefusal) {
            results.push({ id, path, status: 'incompatible', reason: selectorRefusal, mutated: false });
            continue;
        }
        const updated = upsertEnginePinHeader(text);
        if (updated.changed)
            writeFileSync(path, updated.text, 'utf8');
        results.push({
            id,
            path,
            status: updated.changed ? 'migrated' : 'already-pinned',
            mutated: updated.changed,
        });
    }
    return results;
}
