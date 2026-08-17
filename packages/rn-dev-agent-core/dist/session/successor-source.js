import { join } from 'node:path';
import { deleteStateFile, readJsonStateFile, writeJsonStateFileAtomic, } from '../util/secure-state-file.js';
import { sessionRuntimeDirectory } from './state-root.js';
const DECLARATION_FILE = 'successor-source.json';
export function successorSourceDeclarationPath(runtimeRoot) {
    return join(runtimeRoot, DECLARATION_FILE);
}
export function writeSuccessorSourceDeclaration(runtimeRoot, declaration) {
    writeJsonStateFileAtomic(successorSourceDeclarationPath(runtimeRoot), declaration);
}
export function consumeSuccessorSourceDeclaration(layout, sessionId) {
    const path = successorSourceDeclarationPath(sessionRuntimeDirectory(layout, sessionId));
    const value = readJsonStateFile(path);
    deleteStateFile(path);
    if (!value ||
        value.version !== 1 ||
        typeof value.projectRoot !== 'string' ||
        value.projectRoot.length === 0 ||
        typeof value.sourceKey !== 'string' ||
        value.sourceKey.length === 0 ||
        !Number.isFinite(value.declaredAtMs) ||
        value.sessionId !== sessionId) {
        return null;
    }
    return value;
}
/**
 * GH #776: successor mint precedence — a validated bind_source declaration wins,
 * otherwise the terminal session's own source is inherited (sticky), and only a
 * first mint falls back to the supervisor's boot working directory.
 */
export function resolveSuccessorMintSource(input) {
    const diagnostic = input.diagnostic ?? (() => { });
    const terminal = input.terminal;
    if (!terminal)
        return input.bootSource;
    const declaration = consumeSuccessorSourceDeclaration(terminal.layout, terminal.session.sessionId);
    if (declaration) {
        try {
            const declared = input.resolveIdentity(declaration.projectRoot);
            if (declared.sourceKey === declaration.sourceKey &&
                declared.sourceKey === terminal.source.sourceKey) {
                return declared;
            }
            diagnostic('declared successor root belongs to a different repository than the released session; ignoring the declaration');
        }
        catch (error) {
            diagnostic(`declared successor root could not be resolved: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }
    return terminal.source;
}
