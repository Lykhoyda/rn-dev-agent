// D1206 Tier 2 Sprint D / Phase 129 — ReusableAction load/save.
//
// Combines the YAML header + body (immutable contract) with the sidecar
// JSON (mutable runtime state) into a single ReusableAction in-memory
// composite. Underpins /run-action, self-repair, and auto-emission —
// they all read/write through this single chokepoint so schema
// invariants stay enforced.
import { existsSync, lstatSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseM7Header, serializeM7Header, } from './reusable-action.js';
import { loadOrInitSidecar, markSeen, saveSidecar, sidecarPathFor, yamlEditedSinceLastSeen, } from './sidecar-io.js';
import { atomicWriter } from './atomic-writer.js';
import { assertValidActionId, assertWithinDir } from './path-safety.js';
import { assertUnfollowedFileSnapshotUnchanged, createUnfollowedFileSnapshot, listUnfollowedDirectory, readUnfollowedFiles, readUnfollowedSnapshotFiles, } from './unfollowed-file.js';
import { buildMaestroFlow, collectRunFlowFileReferences, parseAndValidateFlow, } from './maestro-validator.js';
import { mirrorToDb } from './action-state-store.js';
import { assertReadableActionOperationUnchanged, captureReadableActionOperationSnapshot, readableActionsSnapshot, resolveReadableActionCorpus, } from '../session/worktree-inheritance.js';
/**
 * Resolve the canonical YAML path for an action id under a project root.
 * Mirrors the .rn-agent/actions/ convention (D1208 single-folder doctrine,
 * supersedes D1207).
 *
 * Phase 134.3 (deepsec HIGH path-traversal): the regex check is the
 * primary defense — `actionId` flows from caller args (MCP tool params,
 * project YAML file names) and a `../etc/passwd` slug would otherwise
 * escape `.rn-agent/actions/`. The assertWithinDir check is a
 * defense-in-depth chokepoint that catches any future bypass of the
 * regex (e.g. a new caller that forgets to validate).
 */
export function actionPathFor(projectRoot, actionId) {
    assertValidActionId(actionId, 'actionPathFor');
    const actionsDir = join(projectRoot, '.rn-agent', 'actions');
    assertOwnedActionCorpus(projectRoot);
    const fileName = `${actionId}.yaml`;
    assertWithinDir(fileName, actionsDir);
    return join(actionsDir, fileName);
}
export function assertOwnedActionCorpus(projectRoot) {
    for (const path of [join(projectRoot, '.rn-agent'), join(projectRoot, '.rn-agent', 'actions')]) {
        const stat = lstatIfPresent(path);
        if (stat?.isSymbolicLink()) {
            throw new Error(`Refusing learned-action corpus symlink at ${path}.`);
        }
    }
}
export function assertReadableActionCorpus(projectRoot) {
    const corpus = resolveReadableActionCorpus(projectRoot);
    if (corpus.status === 'refused')
        throw new Error(corpus.reason);
}
export function assertReadableActionLoadContextStable(context) {
    assertReadableActionOperationUnchanged(context.operation);
    assertUnfollowedFileSnapshotUnchanged(context.fileSnapshot);
}
function lstatIfPresent(path) {
    try {
        return lstatSync(path);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
function actionFileExists(path) {
    const stat = lstatIfPresent(path);
    if (!stat)
        return false;
    if (stat.isSymbolicLink()) {
        throw new Error(`Refusing inherited action symlink at ${path}.`);
    }
    return true;
}
function captureOwnedActionPathIdentity(projectRoot, filePath) {
    const paths = [
        { path: join(projectRoot, '.rn-agent'), kind: 'directory' },
        { path: join(projectRoot, '.rn-agent', 'actions'), kind: 'directory' },
    ];
    if (filePath)
        paths.push({ path: filePath, kind: 'file' });
    return paths.map(({ path, kind }) => {
        const stat = lstatSync(path);
        const valid = !stat.isSymbolicLink() && (kind === 'directory' ? stat.isDirectory() : stat.isFile());
        if (!valid)
            throw new Error(`Refusing changed learned-action path at ${path}.`);
        return { path, kind, dev: stat.dev, ino: stat.ino };
    });
}
function ownedActionPathIdentityMatches(entries) {
    try {
        return entries.every((entry) => {
            const stat = lstatSync(entry.path);
            return (!stat.isSymbolicLink() &&
                stat.dev === entry.dev &&
                stat.ino === entry.ino &&
                (entry.kind === 'directory' ? stat.isDirectory() : stat.isFile()));
        });
    }
    catch {
        return false;
    }
}
function referencedActionPath(parentFile, reference) {
    if (isAbsolute(reference) ||
        reference.split(/[\\/]/).includes('..') ||
        !/\.ya?ml$/i.test(reference)) {
        return null;
    }
    const child = join(dirname(parentFile), reference);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
        return null;
    return child;
}
function prefetchRunFlowFiles(initial, readFiles, fileSnapshot) {
    const fileContents = new Map(initial);
    let frontier = [...fileContents.entries()];
    for (let depth = 0; depth < 5 && frontier.length > 0; depth += 1) {
        const pending = new Set();
        for (const [parentFile, text] of frontier) {
            for (const reference of collectRunFlowFileReferences(text)) {
                const child = referencedActionPath(parentFile, reference);
                if (child && !fileContents.has(child))
                    pending.add(child);
            }
        }
        const paths = [...pending].sort();
        if (paths.length === 0)
            break;
        const contents = readUnfollowedSnapshotFiles(fileSnapshot, paths, readFiles);
        frontier = [];
        paths.forEach((path, index) => {
            const text = contents[index];
            fileContents.set(path, text);
            frontier.push([path, text]);
        });
    }
    return fileContents;
}
export function openReadableActionLoadContext(projectRoot, dependencies = {}) {
    const corpus = resolveReadableActionCorpus(projectRoot);
    if (corpus.status === 'refused')
        throw new Error(corpus.reason);
    if (corpus.status !== 'owned-directory' && corpus.status !== 'approved-inherited')
        return null;
    const snapshot = readableActionsSnapshot(corpus);
    const operation = captureReadableActionOperationSnapshot(corpus);
    if (!snapshot || !operation)
        return null;
    const files = listUnfollowedDirectory(snapshot.directory, snapshot.identity);
    const requestedFiles = dependencies.actionId
        ? [`${dependencies.actionId}.yaml`, `${dependencies.actionId}.yml`]
        : files;
    const readableFiles = requestedFiles.filter((file) => /\.ya?ml$/.test(file) && files.includes(file));
    const readFiles = dependencies.readFiles ?? readUnfollowedFiles;
    const fileSnapshot = createUnfollowedFileSnapshot(snapshot.directory, snapshot.identity);
    const contents = readUnfollowedSnapshotFiles(fileSnapshot, readableFiles, readFiles);
    const fileContents = new Map();
    readableFiles.forEach((file, index) => {
        fileContents.set(file, contents[index]);
    });
    const completeFileContents = prefetchRunFlowFiles(fileContents, readFiles, fileSnapshot);
    assertReadableActionOperationUnchanged(operation);
    assertUnfollowedFileSnapshotUnchanged(fileSnapshot);
    return {
        projectRoot,
        corpus,
        snapshot,
        operation,
        files,
        fileContents: completeFileContents,
        fileSnapshot,
    };
}
function actionTextFromContext(context, fileName) {
    const text = context.fileContents.get(fileName);
    if (text !== undefined)
        return text;
    throw new Error(`Refusing inherited action symlink at ${context.snapshot.directory}/${fileName}.`);
}
export function refreshActionLoadContext(context, actionId) {
    assertReadableActionOperationUnchanged(context.operation);
    const refreshed = openReadableActionLoadContext(context.projectRoot, { actionId });
    if (!refreshed) {
        throw new Error(`Action ${actionId} disappeared while refreshing its snapshot.`);
    }
    return refreshed;
}
function resolveActionFileNameFromContext(actionId, context) {
    const fileName = `${actionId}.yaml`;
    assertWithinDir(fileName, context.corpus.actionsDir);
    assertWithinDir(fileName, context.snapshot.directory);
    const yamlExists = context.files.includes(fileName);
    const ymlFileName = fileName.replace(/\.yaml$/, '.yml');
    const ymlExists = context.files.includes(ymlFileName);
    if (yamlExists && ymlExists) {
        throw new Error(`Action ${actionId} is ambiguous because both ${actionId}.yaml and ${actionId}.yml exist; keep exactly one file before replay.`);
    }
    if (yamlExists)
        return fileName;
    if (ymlExists)
        return ymlFileName;
    return null;
}
export function resolveActionPath(projectRoot, actionId) {
    assertValidActionId(actionId, 'resolveActionPath');
    const context = openReadableActionLoadContext(projectRoot, { actionId });
    if (!context)
        return null;
    const fileName = resolveActionFileNameFromContext(actionId, context);
    if (!fileName)
        return null;
    actionTextFromContext(context, fileName);
    assertReadableActionLoadContextStable(context);
    return join(context.corpus.actionsDir, fileName);
}
export function createActionTextExclusive(projectRoot, actionId, yamlText) {
    const yamlPath = actionPathFor(projectRoot, actionId);
    const ymlPath = yamlPath.replace(/\.yaml$/, '.yml');
    return atomicWriter.withLock(yamlPath, () => {
        const pathIdentity = captureOwnedActionPathIdentity(projectRoot);
        const pathIsOwned = () => ownedActionPathIdentityMatches(pathIdentity);
        const existing = resolveActionPath(projectRoot, actionId);
        if (existing)
            throw new Error(`Action ${actionId} already exists at ${existing}.`);
        if (!atomicWriter.writeTextCreateExclusive(yamlPath, yamlText, pathIsOwned)) {
            throw new Error(`Action ${actionId} changed during creation.`);
        }
        try {
            if (pathIsOwned() && !actionFileExists(ymlPath))
                return yamlPath;
            throw new Error(`Action ${actionId} changed during creation; keep exactly one extension.`);
        }
        catch (err) {
            if (pathIsOwned() && readFileSync(yamlPath, 'utf8') === yamlText)
                unlinkSync(yamlPath);
            throw err;
        }
    });
}
export function writeRecordedActionTransaction(projectRoot, actionId, yamlText, state, overwrite) {
    const yamlPath = actionPathFor(projectRoot, actionId);
    return atomicWriter.withLock(yamlPath, () => {
        const existingPath = resolveActionPath(projectRoot, actionId);
        if (existingPath && !overwrite)
            return { ok: false, existingPath };
        const filePath = existingPath ?? yamlPath;
        const pathIdentity = captureOwnedActionPathIdentity(projectRoot, existingPath ?? undefined);
        const pathIsOwned = () => ownedActionPathIdentityMatches(pathIdentity);
        const sidecarPath = sidecarPathFor(filePath);
        if (!existingPath && existsSync(sidecarPath))
            return { ok: false, existingPath: null };
        const written = existingPath
            ? atomicWriter.pairWriteConditional(filePath, yamlText, sidecarPath, state, pathIsOwned, pathIsOwned, readFileSync(filePath, 'utf8'))
            : atomicWriter.pairWriteCreateExclusive(filePath, yamlText, sidecarPath, state, pathIsOwned);
        if (!written)
            return { ok: false, existingPath: resolveActionPath(projectRoot, actionId) };
        return {
            ok: true,
            filePath,
            sidecarPath,
            finalMtimeMs: written.finalMtimeMs,
            preexisted: existingPath !== null,
        };
    });
}
/**
 * Split a YAML file into (top-section before `---`, header comments
 * sitting above the first non-`#` content, body that follows). The body
 * is what self-repair patches; the header is what M7 metadata lives in.
 *
 * Format assumption (mirrors workspace test-app convention):
 *   appId: com.foo.app
 *   ---
 *   # id: ...
 *   # intent: ...
 *   # status: ...
 *   - launchApp
 *   - tapOn:
 *       id: "fab-create-task"
 *
 * The split returns `{ topSection, headerLines, bodyLines }` so callers
 * can reassemble the YAML preserving the structure.
 *
 * Pure function — exported for unit tests.
 */
export function splitYaml(text) {
    const allLines = text.split('\n');
    let separatorIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i].trim() === '---') {
            separatorIdx = i;
            break;
        }
    }
    // No separator → treat the entire text as body, no top section, parse
    // header out of leading `#` lines if present.
    //
    // Issue #102 A1: prior implementation flipped `inBody=true` on the
    // first blank line BEFORE any header had been seen, so a YAML with a
    // leading blank line followed by `# id: foo` would put the header in
    // bodyLines (round-trip then duplicated the header on save). Fix:
    // treat leading blank lines as a "leading-blanks" zone that doesn't
    // flip inBody — the body proper starts at the first non-blank,
    // non-comment line.
    if (separatorIdx === -1) {
        const headerLines = [];
        const bodyLines = [];
        let inBody = false;
        let seenAnyContent = false;
        for (const line of allLines) {
            if (!inBody && !seenAnyContent && line.trim() === '') {
                // Leading blank — skip; don't add to either bucket. Preserves
                // exact round-trip for files that start with blank lines.
                continue;
            }
            if (!inBody && line.startsWith('#')) {
                seenAnyContent = true;
                headerLines.push(line);
            }
            else if (!inBody && line.trim() === '' && headerLines.length > 0) {
                // First blank after the header — flip to body and capture this
                // blank as the header/body separator.
                inBody = true;
                bodyLines.push(line);
            }
            else {
                seenAnyContent = true;
                inBody = true;
                bodyLines.push(line);
            }
        }
        return { topSection: '', headerLines, bodyLines };
    }
    const topSection = allLines.slice(0, separatorIdx).join('\n');
    const afterSep = allLines.slice(separatorIdx + 1);
    // Header = leading `#` comment block (allowing blank lines within); body
    // = everything from the first non-comment, non-blank line onward.
    const headerLines = [];
    const bodyLines = [];
    let stillHeader = true;
    for (const line of afterSep) {
        if (stillHeader && (line.startsWith('#') || line.trim() === '')) {
            headerLines.push(line);
        }
        else {
            stillHeader = false;
            bodyLines.push(line);
        }
    }
    return { topSection, headerLines, bodyLines };
}
/**
 * Reassemble a YAML file from its parts. Inverse of splitYaml.
 */
export function joinYaml(parts) {
    const out = [];
    if (parts.topSection) {
        out.push(parts.topSection);
        out.push('---');
    }
    for (const h of parts.headerLines)
        out.push(h);
    for (const b of parts.bodyLines)
        out.push(b);
    return out.join('\n');
}
export function captureActionFromContext(context, actionId) {
    assertValidActionId(actionId, 'loadAction');
    assertReadableActionLoadContextStable(context);
    const fileName = resolveActionFileNameFromContext(actionId, context);
    if (!fileName)
        return null;
    const { corpus, snapshot } = context;
    const filePath = join(corpus.actionsDir, fileName);
    const text = actionTextFromContext(context, fileName);
    const metadata = parseM7Header(text, actionId);
    if (metadata)
        assertActionMetadataIdentity(filePath, metadata);
    let replay;
    try {
        const parsed = parseAndValidateFlow(text, {
            flowDir: snapshot.directory,
            flowRoot: snapshot.directory,
            readFileFn: (path) => {
                const child = relative(snapshot.directory, path);
                if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
                    throw new Error(`Refusing action flow outside ${snapshot.directory}.`);
                }
                const text = context.fileContents.get(child);
                if (text === undefined) {
                    throw new Error(`Refusing inherited action symlink at ${snapshot.directory}/${child}.`);
                }
                return text;
            },
            realpathFn: (path) => resolve(path),
        });
        replay = {
            ok: true,
            yamlText: buildMaestroFlow(parsed.appId ? { appId: parsed.appId } : {}, parsed.commands),
            cdpYaml: buildMaestroFlow({}, parsed.commands),
            commands: parsed.commands,
            appId: parsed.appId,
        };
    }
    catch (err) {
        replay = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    assertReadableActionLoadContextStable(context);
    return { filePath, yamlText: text, metadata, replay };
}
export function loadActionFromContext(context, actionId) {
    const captured = captureActionFromContext(context, actionId);
    if (!captured?.metadata)
        return null;
    const { bodyLines } = splitYaml(captured.yamlText);
    const state = loadOrInitSidecar(captured.filePath);
    assertReadableActionLoadContextStable(context);
    return {
        metadata: captured.metadata,
        body: bodyLines.join('\n'),
        filePath: captured.filePath,
        state,
        yamlText: captured.yamlText,
        replay: captured.replay,
    };
}
export function loadAction(projectRoot, actionId) {
    const context = openReadableActionLoadContext(projectRoot, { actionId });
    return context ? loadActionFromContext(context, actionId) : null;
}
export function captureActionFromPath(path) {
    const absolutePath = resolve(path);
    if (!/\.ya?ml$/i.test(absolutePath))
        return null;
    const actionsDir = dirname(absolutePath);
    if (basename(actionsDir) !== 'actions' || basename(dirname(actionsDir)) !== '.rn-agent') {
        return null;
    }
    const actionId = basename(absolutePath).replace(/\.ya?ml$/i, '');
    const context = openReadableActionLoadContext(dirname(dirname(actionsDir)), { actionId });
    if (!context)
        return null;
    const action = captureActionFromContext(context, actionId);
    return action && basename(action.filePath) === basename(absolutePath) ? action : null;
}
/**
 * Persist a ReusableAction back to disk. Updates the YAML file, the
 * sidecar JSON, and the lastSeenMtimeMs so subsequent
 * yamlEditedSinceLastSeen() checks don't false-alarm on the agent's own
 * write.
 *
 * Caller is responsible for having computed the new metadata/body —
 * this function does not validate transitions (use the lifecycle helpers
 * from reusable-action.ts).
 *
 * NOTE: this overload does NOT do the CAS check (issue #117). Use
 * `saveActionWithCAS` from `cdp_run_action`'s persistRun to detect
 * read-modify-write races on concurrent writers. `saveAction` is kept
 * for callers that already gate concurrency another way (e.g.
 * `cdp_repair_action`, which checks `actionWasEditedExternally` before
 * patching).
 */
export class SaveActionPreconditionError extends Error {
    constructor(filePath) {
        super(`saveAction precondition violated: yaml at ${filePath} has been ` +
            `edited externally since the in-memory action was loaded. The caller ` +
            `must invoke actionWasEditedExternally() first and abort on true ` +
            `(or use saveActionWithCAS for atomic detection). GH #113 contract ` +
            `enforcement.`);
        this.name = 'SaveActionPreconditionError';
    }
}
const migrationPathIdentities = new WeakMap();
function migrationConflict(filePath) {
    return new Error(`Action changed during migration: ${filePath}. Re-run migration.`);
}
function migrationBaselineMatches(filePath, baseline) {
    const pathIdentity = migrationPathIdentities.get(baseline);
    if (!pathIdentity || !migrationPathIdentityMatches(pathIdentity))
        return false;
    if (!migrationYamlBaselineMatches(filePath, baseline))
        return false;
    const sidecarPath = sidecarPathFor(filePath);
    const sidecarExists = existsSync(sidecarPath);
    if (sidecarExists !== baseline.sidecarExisted)
        return false;
    return !sidecarExists || runtimeSidecarMatches(sidecarPath, baseline.state);
}
function captureMigrationPathIdentity(filePath) {
    const actionsDir = dirname(filePath);
    const rnAgentDir = dirname(actionsDir);
    return [
        { path: rnAgentDir, kind: 'directory' },
        { path: actionsDir, kind: 'directory' },
        { path: filePath, kind: 'file' },
    ].map(({ path, kind }) => {
        const stat = lstatSync(path);
        const valid = !stat.isSymbolicLink() && (kind === 'directory' ? stat.isDirectory() : stat.isFile());
        if (!valid)
            throw new Error(`Refusing changed learned-action path at ${path}.`);
        return { path, kind, dev: stat.dev, ino: stat.ino };
    });
}
function migrationPathIdentityMatches(entries) {
    try {
        return entries.every((entry) => {
            const stat = lstatSync(entry.path);
            return (!stat.isSymbolicLink() &&
                stat.dev === entry.dev &&
                stat.ino === entry.ino &&
                (entry.kind === 'directory' ? stat.isDirectory() : stat.isFile()));
        });
    }
    catch {
        return false;
    }
}
function migrationYamlBaselineMatches(filePath, baseline) {
    try {
        return readFileSync(filePath, 'utf8') === baseline.yamlText;
    }
    catch {
        return false;
    }
}
function migrationYamlPublicationMatches(filePath, baseline) {
    const pathIdentity = migrationPathIdentities.get(baseline);
    return Boolean(pathIdentity &&
        migrationPathIdentityMatches(pathIdentity) &&
        migrationYamlBaselineMatches(filePath, baseline));
}
export function loadActionMigrationBaseline(filePath) {
    assertWritableActionFile(filePath);
    const pathIdentity = captureMigrationPathIdentity(filePath);
    const yamlText = readFileSync(filePath, 'utf8');
    const sidecarExisted = existsSync(sidecarPathFor(filePath));
    const state = loadOrInitSidecar(filePath);
    const baseline = { yamlText, state, sidecarExisted };
    migrationPathIdentities.set(baseline, pathIdentity);
    if (!migrationBaselineMatches(filePath, baseline))
        throw migrationConflict(filePath);
    return baseline;
}
export function commitMigratedActionText(filePath, baseline, yamlText) {
    assertWritableActionFile(filePath);
    const sidecarPath = sidecarPathFor(filePath);
    const result = atomicWriter.pairWriteConditional(filePath, yamlText, sidecarPath, baseline.state, () => migrationBaselineMatches(filePath, baseline), () => migrationYamlPublicationMatches(filePath, baseline), baseline.yamlText);
    if (!result)
        throw migrationConflict(filePath);
    const nextState = { ...baseline.state, lastSeenMtimeMs: result.finalMtimeMs };
    const metadata = parseM7Header(yamlText, basename(filePath).replace(/\.ya?ml$/i, ''));
    mirrorToDb({
        yamlFilePath: filePath,
        state: nextState,
        meta: {
            appId: metadata?.appId,
            status: metadata?.status,
            path: filePath,
        },
    });
    return { filePath, sidecarPath };
}
export function saveAction(action) {
    assertWritableActionFile(action.filePath);
    // GH #113: soft-assertion contract enforcement. Both current callers
    // (cdp_repair_action, cdp_record_test_save_as_action) gate this check
    // correctly, but a future caller (e.g. the planned issue-#104
    // auto-repair-on-failure wiring) could silently clobber a real human
    // edit if it forgot. One stat() per save is cheap defense.
    //
    // Skip the guard when the file doesn't exist yet (first write — there's
    // no external edit to detect, and actionWasEditedExternally returns
    // false in that case anyway via its statSync catch).
    if (existsSync(action.filePath) && actionWasEditedExternally(action)) {
        throw new SaveActionPreconditionError(action.filePath);
    }
    // Read existing top section so we don't lose the `appId:` line.
    let topSection = '';
    if (existsSync(action.filePath)) {
        const existing = readFileSync(action.filePath, 'utf8');
        topSection = splitYaml(existing).topSection;
    }
    // If the action specifies an appId in metadata but the topSection
    // doesn't have one, inject it. Otherwise preserve whatever the file
    // had.
    if (!topSection && action.metadata.appId) {
        topSection = `appId: ${action.metadata.appId}`;
    }
    const headerLines = serializeM7Header(action.metadata).split('\n');
    const bodyLines = action.body.split('\n');
    const yamlText = joinYaml({ topSection, headerLines, bodyLines });
    // Issue #101: sidecar-first atomic pair-write. The atomicWriter owns
    // `lastSeenMtimeMs` correctness — even on partial failure, the
    // persisted sidecar will have lastSeenMtimeMs ≥ the YAML's actual
    // mtime, so the next yamlEditedSinceLastSeen() check returns false
    // (no false-positive alarm).
    const sidecarPath = sidecarPathFor(action.filePath);
    const result = atomicWriter.pairWrite(action.filePath, yamlText, sidecarPath, action.state);
    const stateToWrite = { ...action.state, lastSeenMtimeMs: result.finalMtimeMs };
    // Reflect in-memory so subsequent calls share the just-written mtime.
    action.state = stateToWrite;
    // Task 5 (A2): best-effort DB mirror, STRICTLY AFTER the authoritative
    // #101 pair-write. mirrorToDb is sidecar-less (it must NOT re-write the
    // sidecar — that would break the atomic pair-write) and NEVER throws, so it
    // can't convert a successful write into a failure. No record is appended
    // here (the record-producing call sites do that); this refreshes the index
    // row + stats only.
    mirrorToDb({
        yamlFilePath: action.filePath,
        state: stateToWrite,
        meta: { appId: action.metadata.appId, status: action.metadata.status, path: action.filePath },
    });
    return { filePath: action.filePath, sidecarPath };
}
/**
 * Convenience: check whether a YAML on disk is newer than the in-memory
 * state's lastSeenMtimeMs. Wraps yamlEditedSinceLastSeen() — repair
 * flows abort early when a human has edited the file since the agent
 * last touched it.
 */
export function actionWasEditedExternally(action) {
    return yamlEditedSinceLastSeen(action.filePath, action.state);
}
/**
 * GH #173 (sub-issue 3): treat the YAML's current on-disk mtime as the
 * new baseline. Stats the YAML, persists `markSeen(state, currentMtime)`
 * to the sidecar, and returns a new ReusableAction with the refreshed
 * lastSeenMtimeMs. Subsequent `actionWasEditedExternally()` checks
 * return false until something edits the YAML again.
 *
 * Use case: `cdp_run_action` is called while the human is actively
 * composing the YAML. The human's edit IS the intent; the Phase 129
 * guardrail (which exists to protect offline human edits from
 * auto-repair clobber) is over-protective in this loop. The orchestrator
 * acknowledges the edit before running so any downstream repair
 * proceeds without `STALE_TARGET`.
 *
 * No-op when the YAML mtime equals the sidecar's lastSeenMtimeMs (the
 * common case where no external write happened).
 */
export function acknowledgeExternalEdit(action) {
    const nextAction = atomicWriter.withLock(action.filePath, () => {
        let currentMtimeMs;
        try {
            currentMtimeMs = statSync(action.filePath).mtimeMs;
        }
        catch {
            return action;
        }
        const currentState = loadOrInitSidecar(action.filePath);
        if (currentMtimeMs <= currentState.lastSeenMtimeMs) {
            return action;
        }
        const nextState = markSeen(currentState, currentMtimeMs);
        saveSidecar(action.filePath, nextState);
        return { ...action, state: nextState };
    });
    if (nextAction === action)
        return action;
    // Task 5 (A2): mirror the refreshed mtime baseline to the DB (best-effort,
    // never throws). No record append — this is a baseline-only update.
    mirrorToDb({
        yamlFilePath: action.filePath,
        state: nextAction.state,
        meta: { appId: action.metadata.appId, status: action.metadata.status, path: action.filePath },
    });
    return nextAction;
}
/**
 * Issue #117: CAS variant of `saveAction`. Compares the on-disk
 * sidecar's `lastSeenMtimeMs` to the in-memory `action.state.
 * lastSeenMtimeMs` BEFORE writing. If disk has advanced (some other
 * writer raced between the caller's `loadAction` and this save), returns
 * `{ ok: false, conflict: 'EXTERNAL_WRITE' }` instead of writing —
 * caller reloads the action and retries.
 *
 * The two saveAction variants exist because:
 *
 *   - `saveAction` (no CAS): used by `cdp_repair_action` after its
 *     `actionWasEditedExternally` guard runs. The repair handler
 *     already gates concurrency at the entry; CAS would be redundant.
 *
 *   - `saveActionWithCAS` (CAS): used by `cdp_run_action`'s persistRun.
 *     The orchestrator emits multiple RunRecord appends per call (first
 *     attempt + retry) and competing `cdp_run_action` calls on the same
 *     actionId need lost-update protection. CAS + retry-on-conflict
 *     makes the read-modify-write atomic at the orchestrator layer.
 *
 * The CAS check uses `lastSeenMtimeMs` rather than `revision` because:
 * (a) `revision` doesn't bump on RunRecord appends today (only on YAML
 * edits + repair), so it's not a unique-per-write counter; (b)
 * `atomicWriter.pairWrite` already advances `lastSeenMtimeMs` on every
 * successful write, so it's a natural monotonic counter.
 */
export function saveActionWithCAS(action) {
    const sidecarPath = sidecarPathFor(action.filePath);
    // CAS: re-read the on-disk sidecar's lastSeenMtimeMs and compare
    // against the in-memory snapshot.
    if (existsSync(sidecarPath)) {
        try {
            const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
            const diskMtimeMs = onDisk.lastSeenMtimeMs ?? 0;
            const expectedMtimeMs = action.state.lastSeenMtimeMs;
            // CAS skip on first save (action loaded with a placeholder zero
            // mtime — happens when `loadOrInitSidecar` couldn't find an
            // existing sidecar). In that case there's nothing to conflict
            // against — proceed to write.
            if (expectedMtimeMs > 0 && diskMtimeMs > expectedMtimeMs) {
                return { ok: false, conflict: 'EXTERNAL_WRITE', diskMtimeMs, expectedMtimeMs };
            }
        }
        catch {
            // Corrupted sidecar — treat as no prior state, proceed to write.
        }
    }
    // NOTE on the SaveActionPreconditionError that saveAction can throw here:
    // this throw is LOAD-BEARING, not a contract bug. When forceReload=false and
    // the YAML was edited externally, the throw propagates to cdp_run_action's
    // top-level catch and becomes the correct strict-mode (Phase 129) refusal —
    // see gh-173-run-action-force-reload. Converting it to a structured conflict
    // makes persistRun treat it as a transient CAS race and retry-then-succeed,
    // silently dropping the refusal. The RunRecord can't be persisted in that
    // case anyway (the sidecar is pair-written with the YAML, which strict mode
    // is deliberately refusing to clobber), so there is nothing to recover.
    const { filePath, sidecarPath: writtenSidecarPath } = saveAction(action);
    return { ok: true, filePath, sidecarPath: writtenSidecarPath };
}
function canonicalRuntimeJson(state) {
    return JSON.stringify(state, (_key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const record = value;
            return Object.fromEntries(Object.keys(record)
                .sort()
                .map((k) => [k, record[k]]));
        }
        return value;
    });
}
/**
 * Compare the on-disk sidecar against the loaded baseline using the same
 * normalization `loadOrInitSidecar` applies, so a legacy sidecar missing
 * `lastSeenMtimeMs` (re-seeded on load) is not read as an external write.
 */
function runtimeSidecarMatches(sidecarPath, expected) {
    let onDisk;
    try {
        onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    }
    catch {
        return false;
    }
    const normalized = typeof onDisk?.lastSeenMtimeMs === 'number'
        ? onDisk
        : { ...onDisk, lastSeenMtimeMs: expected.lastSeenMtimeMs };
    return canonicalRuntimeJson(normalized) === canonicalRuntimeJson(expected);
}
function runtimeBaselineMatches(filePath, expected) {
    const sidecarPath = sidecarPathFor(filePath);
    return existsSync(sidecarPath)
        ? runtimeSidecarMatches(sidecarPath, expected)
        : expected.runHistory.length === 0 && expected.repairHistory.length === 0;
}
/**
 * Persist run telemetry without reserializing the tracked action YAML. The
 * synchronous compare+write is atomic with respect to this MCP process and
 * preserves the bounded sidecar reload/retry contract used by persistRun.
 *
 * YAML mtime divergence is deliberately not a conflict here: this path writes
 * only the runtime sidecar, so a stale lastSeenMtimeMs cannot cause a lost YAML
 * update. The stale baseline remains unchanged, which means forceReload=false
 * still blocks later YAML-mutating promotion/repair through their existing
 * actionWasEditedExternally guards. The sidecar equality check below remains
 * the CAS authority for telemetry lost-update protection.
 */
export function saveActionRuntimeWithCAS(expected, nextState) {
    return atomicWriter.withLock(expected.filePath, () => {
        const sidecarPath = sidecarPathFor(expected.filePath);
        if (!runtimeBaselineMatches(expected.filePath, expected.state)) {
            return { ok: false, conflict: 'EXTERNAL_WRITE' };
        }
        saveSidecar(expected.filePath, nextState);
        expected.state = nextState;
        return { ok: true, sidecarPath };
    });
}
/** Byte-preserving lifecycle promotion; comments/body remain exactly intact. */
export function promoteActionRuntimeWithCAS(expected, nextState) {
    try {
        assertWritableActionFile(expected.filePath);
    }
    catch {
        return { ok: false, conflict: 'EXTERNAL_WRITE' };
    }
    const sidecarPath = sidecarPathFor(expected.filePath);
    if (existsSync(sidecarPath)) {
        if (!runtimeSidecarMatches(sidecarPath, expected.state)) {
            return { ok: false, conflict: 'EXTERNAL_WRITE' };
        }
    }
    else if (expected.state.runHistory.length > 0 || expected.state.repairHistory.length > 0) {
        // Same refusal as saveActionRuntimeWithCAS: a sidecar that vanished under a
        // state that has history is an external signal, and promoting would rewrite
        // both YAML and sidecar over it.
        return { ok: false, conflict: 'EXTERNAL_WRITE' };
    }
    if (actionWasEditedExternally(expected))
        return { ok: false, conflict: 'EXTERNAL_WRITE' };
    const yaml = readFileSync(expected.filePath, 'utf8');
    const marker = /^# status: experimental[ \t]*$/gm;
    if ((yaml.match(marker) ?? []).length !== 1)
        return { ok: false, conflict: 'EXTERNAL_WRITE' };
    const promoted = yaml.replace(marker, '# status: active');
    const written = atomicWriter.pairWriteConditional(expected.filePath, promoted, sidecarPath, nextState, () => {
        try {
            return (runtimeBaselineMatches(expected.filePath, expected.state) &&
                !actionWasEditedExternally(expected) &&
                readFileSync(expected.filePath, 'utf8') === yaml);
        }
        catch {
            return false;
        }
    }, undefined, yaml);
    if (!written)
        return { ok: false, conflict: 'EXTERNAL_WRITE' };
    expected.state = { ...nextState, lastSeenMtimeMs: written.finalMtimeMs };
    return { ok: true, sidecarPath };
}
function assertWritableActionFile(filePath) {
    const actionsDir = dirname(filePath);
    const rnAgentDir = dirname(actionsDir);
    if (basename(actionsDir) !== 'actions' || basename(rnAgentDir) !== '.rn-agent') {
        throw new Error(`Refusing action mutation outside an owned learned-action corpus: ${filePath}.`);
    }
    assertOwnedActionCorpus(dirname(rnAgentDir));
    actionFileExists(filePath);
}
export function assertActionMetadataIdentity(filePath, metadata) {
    const fileId = basename(filePath).replace(/\.ya?ml$/i, '');
    if (metadata.id !== fileId) {
        throw new Error(`Action metadata id ${metadata.id} does not match filename identity ${fileId}.`);
    }
}
/**
 * Update only the M7 metadata of an action without touching the body.
 * Used by lifecycle transitions (status: experimental → active).
 */
export function withMetadata(action, metadata) {
    return { ...action, metadata };
}
/**
 * Update only the body of an action (preserves metadata + filePath +
 * state). Used by self-repair to write a patched body.
 */
export function withBody(action, body) {
    return { ...action, body };
}
