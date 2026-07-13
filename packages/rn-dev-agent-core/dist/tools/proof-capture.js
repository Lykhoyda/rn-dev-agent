import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { actionPathFor, loadAction } from '../domain/action-store.js';
import { hashProofArgs, validateTrace, } from '../domain/proof-capture.js';
import { acceptanceMappingSchema, evidenceReviewSchema, finalProofReceiptSchema, mechanicallyAcceptedProofReceiptSchema, proofActionSchema, proofClassSchema, proofDeviceSchema, proofFixtureSchema, proofIssueSchema, proofPullRequestSchema, proofRuntimeSchema, storyboardSchema, } from '../domain/proof-receipt.js';
import { failResult, okResult } from '../utils.js';
const absolutePathSchema = z.string().min(1).refine(isAbsolute, 'path must be absolute');
const beginRehearsalSchema = z
    .object({
    action: z.literal('begin_rehearsal'),
    projectRoot: absolutePathSchema,
    receiptPath: absolutePathSchema,
    videoPath: absolutePathSchema,
    contactSheetPath: absolutePathSchema,
    writerProvider: z.string().min(1),
    runId: z.string().min(1),
    issue: proofIssueSchema,
    pullRequest: proofPullRequestSchema,
    proofClass: proofClassSchema,
    acceptanceMappings: z.array(acceptanceMappingSchema).min(1),
    fixture: proofFixtureSchema,
    proofAction: proofActionSchema,
    storyboard: storyboardSchema,
})
    .strict();
const sessionActionSchema = (action) => z.object({ action: z.literal(action) }).strict();
const validateSchema = sessionActionSchema('validate');
const finalizeSchema = z
    .object({
    action: z.literal('finalize'),
    evidenceReview: evidenceReviewSchema,
})
    .strict();
export const proofCaptureInputSchema = z.discriminatedUnion('action', [
    beginRehearsalSchema,
    sessionActionSchema('finish_rehearsal'),
    sessionActionSchema('arm'),
    sessionActionSchema('start_recording'),
    sessionActionSchema('stop_recording'),
    validateSchema,
    finalizeSchema,
    sessionActionSchema('status'),
    sessionActionSchema('discard'),
    sessionActionSchema('contract'),
]);
const readinessSchema = z
    .object({
    cdpAttached: z.boolean(),
    helpersAttached: z.boolean(),
    metroReady: z.boolean(),
    metroBuildPending: z.boolean(),
    metroBuildFailed: z.boolean(),
    metroEventsConnected: z.boolean(),
    metroEventMarker: z.string().min(1),
    errorCount: z.number().int().nonnegative(),
    errorSha256: z.string().regex(/^[0-9a-f]{64}$/),
    device: proofDeviceSchema,
    runtime: proofRuntimeSchema,
})
    .strict();
function hashBytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function sameProofAction(left, right) {
    return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}
export function readProofActionIdentity(appProjectRoot, actionId) {
    try {
        const path = actionPathFor(appProjectRoot, actionId);
        const bytesBefore = readFileSync(path);
        const action = loadAction(appProjectRoot, actionId);
        const bytesAfter = readFileSync(path);
        if (!action ||
            action.metadata.id !== actionId ||
            !bytesBefore.equals(bytesAfter) ||
            !Number.isInteger(action.state.revision) ||
            action.state.revision < 1) {
            return null;
        }
        return {
            id: actionId,
            version: String(action.state.revision),
            sha256: createHash('sha256').update(bytesAfter).digest('hex'),
        };
    }
    catch {
        return null;
    }
}
function isNormalizedDescendant(root, path) {
    if (!isAbsolute(root) || !isAbsolute(path) || resolve(root) !== root || resolve(path) !== path) {
        return false;
    }
    const fromRoot = relative(root, path);
    return (fromRoot.length > 0 &&
        fromRoot !== '..' &&
        !fromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(fromRoot));
}
function hasExistingSymlink(root, path) {
    const parts = relative(root, path).split(sep);
    for (let length = 0; length <= parts.length; length += 1) {
        const candidate = resolve(root, ...parts.slice(0, length));
        try {
            if (lstatSync(candidate).isSymbolicLink())
                return true;
        }
        catch {
            // A nonexistent descendant cannot currently redirect outside the root.
        }
    }
    return false;
}
function validCaptureContext(args, expectedRoot) {
    if (!expectedRoot ||
        args.projectRoot !== expectedRoot ||
        resolve(expectedRoot) !== expectedRoot) {
        return false;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(args.runId))
        return false;
    const proofRoot = join(expectedRoot, 'docs', 'proof', args.runId);
    const screenshots = args.storyboard.steps.map((step) => step.screenshotPath);
    const destinations = [args.receiptPath, args.videoPath, args.contactSheetPath, ...screenshots];
    if (destinations.some((path) => !isNormalizedDescendant(proofRoot, path) || hasExistingSymlink(expectedRoot, path)) ||
        new Set(destinations).size !== destinations.length) {
        return false;
    }
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png']);
    return (basename(args.receiptPath) === 'proof-receipt.json' &&
        extname(args.videoPath).toLowerCase() === '.mp4' &&
        ['.jpg', '.jpeg'].includes(extname(args.contactSheetPath).toLowerCase()) &&
        screenshots.every((path) => imageExtensions.has(extname(path).toLowerCase())) &&
        args.storyboard.steps.every((step) => step.assertionArgsSha256 ===
            hashProofArgs({
                verifyTestID: step.verifyTestID,
                screenshotPath: step.screenshotPath,
                waitMs: step.assertionWaitMs,
            })));
}
function proofRootExists(args) {
    const proofRoot = join(args.projectRoot, 'docs', 'proof', args.runId);
    try {
        lstatSync(proofRoot);
        return true;
    }
    catch (error) {
        return error.code !== 'ENOENT';
    }
}
export function resolveProofWorktreeRoot(detectedProjectRoot) {
    if (!detectedProjectRoot ||
        !isAbsolute(detectedProjectRoot) ||
        resolve(detectedProjectRoot) !== detectedProjectRoot) {
        return null;
    }
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: detectedProjectRoot,
            encoding: 'utf8',
        }).trim();
        return root && isAbsolute(root) && resolve(root) === root ? root : null;
    }
    catch {
        return null;
    }
}
export function parseProofGitChanges(porcelain) {
    const records = porcelain.split('\0');
    const changes = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record || record.length < 4)
            continue;
        const change = {
            path: record.slice(3).replaceAll('\\', '/'),
            indexStatus: record[0],
            worktreeStatus: record[1],
        };
        if (/[RC]/.test(record.slice(0, 2))) {
            const sourcePath = records[index + 1];
            if (sourcePath)
                change.sourcePath = sourcePath.replaceAll('\\', '/');
            index += 1;
        }
        changes.push(change);
    }
    return changes;
}
export function parseProofGitChangedPaths(porcelain) {
    return [
        ...new Set(parseProofGitChanges(porcelain).flatMap((change) => change.sourcePath ? [change.path, change.sourcePath] : [change.path])),
    ];
}
export function readProofGitInfo(root) {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
        cwd: root,
        encoding: 'utf8',
    });
    const changes = parseProofGitChanges(status);
    return { sha: sha || null, dirty: changes.length > 0, changes };
}
export function proofRootHasTrackedEntries(root, proofRoot) {
    if (!isNormalizedDescendant(root, proofRoot))
        throw new Error('INVALID_PROOF_ROOT');
    const path = relative(root, proofRoot).replaceAll(sep, '/');
    return (execFileSync('git', ['ls-files', '-z', '--', path], {
        cwd: root,
        encoding: 'utf8',
    }).length > 0);
}
export function resolveProofIdentity(input) {
    const { session, target, nativeDevice } = input;
    const appIdMatchesTarget = session?.appId !== undefined &&
        (target?.description === session.appId ||
            target?.title === session.appId ||
            target?.title?.startsWith(`${session.appId} (`));
    if (!session?.deviceId ||
        !session.appId ||
        (session.platform !== 'ios' && session.platform !== 'android') ||
        !target ||
        target.platform !== session.platform ||
        !appIdMatchesTarget ||
        !target.deviceName ||
        !nativeDevice ||
        nativeDevice.id !== session.deviceId ||
        nativeDevice.osVersion.length === 0) {
        return null;
    }
    const normalizeIdentity = (value) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (session.platform === 'ios') {
        if (normalizeIdentity(target.deviceName) !== normalizeIdentity(nativeDevice.name))
            return null;
    }
    else {
        const match = target.deviceName.match(/^(.+?)\s+-\s+(.+?)\s+-\s+API\s+(\d+)$/i);
        if (!match ||
            normalizeIdentity(match[1]) !== normalizeIdentity(nativeDevice.name) ||
            normalizeIdentity(match[2]) !== normalizeIdentity(nativeDevice.osVersion)) {
            return null;
        }
    }
    return {
        device: {
            id: session.deviceId,
            platform: session.platform,
            model: nativeDevice.name,
            osVersion: nativeDevice.osVersion,
        },
        runtime: {
            bundleId: session.appId,
            metroPort: input.metroPort,
            metroReady: input.metroReady,
            pluginVersion: input.pluginVersion,
        },
    };
}
function normalizeTool(tool) {
    const bare = tool.startsWith('mcp__') ? (tool.split('__').at(-1) ?? tool) : tool;
    return bare
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replaceAll('-', '_');
}
function toolData(result) {
    try {
        const parsed = JSON.parse(result.content[0]?.text ?? '');
        return parsed.ok === true && parsed.data && typeof parsed.data === 'object'
            ? parsed.data
            : null;
    }
    catch {
        return null;
    }
}
function proofFailure(reasons, stage) {
    return failResult('Strict proof capture rejected.', {
        reasons: [...new Set(reasons)],
        stage,
    });
}
function requiredToolSequence(storyboard) {
    return storyboard.steps.flatMap((step) => [step.expectedTool, step.assertionTool]);
}
function sequenceObservations(storyboard, observations) {
    const required = requiredToolSequence(storyboard).map(normalizeTool);
    const relevant = observations.filter((observation) => required.includes(normalizeTool(observation.tool)));
    if (relevant.length !== required.length)
        return null;
    if (relevant.some((observation, index) => normalizeTool(observation.tool) !== required[index])) {
        return null;
    }
    return storyboard.steps.map((_, index) => ({
        expected: relevant[index * 2],
        assertion: relevant[index * 2 + 1],
    }));
}
function traceFor(storyboard, events) {
    const required = requiredToolSequence(storyboard);
    const allowedExtras = storyboard.allowedTools.filter((tool) => !required.map(normalizeTool).includes(normalizeTool(tool)));
    return validateTrace([...required, ...allowedExtras], events);
}
export function readProofContractAt(moduleUrl = import.meta.url) {
    const moduleDir = dirname(fileURLToPath(moduleUrl));
    const candidates = [
        resolve(moduleDir, '../../schemas/proof-receipt.schema.json'),
        resolve(moduleDir, '../schemas/proof-receipt.schema.json'),
    ];
    for (const path of candidates) {
        try {
            const bytes = readFileSync(path, 'utf8');
            return { schema: JSON.parse(bytes), bytes, sha256: hashBytes(bytes) };
        }
        catch {
            // Try the split-module and bundled runtime layouts before failing.
        }
    }
    throw new Error('PROOF_CONTRACT_MISSING');
}
export function writeProofReceiptAtomic(path, receipt) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = resolve(directory, `.${randomUUID()}.proof-receipt.tmp`);
    let descriptor = null;
    try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        renameSync(temporary, path);
        chmodSync(path, 0o600);
    }
    catch (error) {
        if (descriptor !== null)
            closeSync(descriptor);
        try {
            unlinkSync(temporary);
        }
        catch {
            // Best-effort cleanup of an unpromoted sibling temp file.
        }
        throw error;
    }
}
export function createProofCaptureHandler(deps) {
    let session = null;
    const contextIsCurrent = (active) => {
        try {
            return validCaptureContext(active.context, deps.projectRoot());
        }
        catch {
            return false;
        }
    };
    const rejectPathDrift = (active) => {
        active.stage = 'rejected';
        active.invalidationReasons = ['PROOF_PATH_DRIFT'];
        return proofFailure(active.invalidationReasons, active.stage);
    };
    const artifactPaths = (active) => [
        active.context.receiptPath,
        active.context.videoPath,
        active.context.contactSheetPath,
        ...active.context.storyboard.steps.map((step) => step.screenshotPath),
    ];
    const removeArtifacts = async (active) => {
        if (!contextIsCurrent(active))
            return ['PROOF_PATH_DRIFT'];
        const reasons = [];
        for (const path of artifactPaths(active)) {
            if (!contextIsCurrent(active)) {
                reasons.push('PROOF_PATH_DRIFT');
                break;
            }
            try {
                await deps.removeArtifact(path);
            }
            catch {
                reasons.push('ARTIFACT_CLEANUP_FAILED');
            }
            if (!contextIsCurrent(active)) {
                reasons.push('PROOF_PATH_DRIFT');
                break;
            }
        }
        return [...new Set(reasons)];
    };
    const shutdownRecorder = async (active) => {
        if (!active.mayOwnRecorder)
            return { confirmed: true, reasons: [], stopData: null };
        const reasons = [];
        let stopData = null;
        try {
            stopData = toolData(await deps.record({ action: 'stop' }));
            if (!stopData)
                reasons.push('RECORDING_STOP_FAILED');
        }
        catch {
            reasons.push('RECORDING_STOP_FAILED');
        }
        let confirmed = false;
        try {
            const status = toolData(await deps.record({ action: 'status' }));
            confirmed = Array.isArray(status?.active) && status.active.length === 0;
        }
        catch {
            confirmed = false;
        }
        if (!confirmed)
            reasons.push('RECORDING_SHUTDOWN_FAILED');
        if (confirmed)
            active.mayOwnRecorder = false;
        return { confirmed, reasons: [...new Set(reasons)], stopData };
    };
    const beginFreshRehearsal = (active, reasons) => {
        active.stage = 'rehearsing';
        active.invalidationReasons = [...new Set(reasons)];
        active.rehearsalStartedAt = deps.now();
        active.rehearsalFinishedAt = null;
        active.rehearsalDurationMs = null;
        active.rehearsalEvents = [];
        active.rehearsalObservations = [];
        active.recordingStartedAt = null;
        active.recordingEvents = [];
        active.recordingObservations = [];
        active.evidenceDraft = null;
        active.armedObservationCount = null;
        active.freshStartAssertion = null;
        active.mayOwnRecorder = false;
        active.baseline = null;
        active.mechanicalReceipt = null;
        deps.monitor.begin();
    };
    const rejectCapture = async (active, reasons) => {
        deps.monitor.stop();
        const shutdown = await shutdownRecorder(active);
        const pathCurrent = contextIsCurrent(active);
        const removalReasons = pathCurrent ? await removeArtifacts(active) : ['PROOF_PATH_DRIFT'];
        const allReasons = [...new Set([...reasons, ...shutdown.reasons, ...removalReasons])];
        if (!shutdown.confirmed || removalReasons.length > 0) {
            active.stage = 'rejected';
            active.invalidationReasons = allReasons;
            return proofFailure(allReasons, active.stage);
        }
        beginFreshRehearsal(active, allReasons);
        return proofFailure(allReasons, active.stage);
    };
    const readGit = (active) => {
        try {
            const value = deps.getGitInfo(active.context.projectRoot);
            if (!Array.isArray(value.changes))
                return { ok: false, reasons: ['GIT_READ_FAILED'] };
            return { ok: true, value };
        }
        catch {
            return { ok: false, reasons: ['GIT_READ_FAILED'] };
        }
    };
    const readCurrentActionIdentity = (active) => {
        try {
            const value = deps.readActionIdentity(active.context.proofAction.id);
            if (!value)
                return { ok: false, reasons: ['PROOF_ACTION_MISSING'] };
            return { ok: true, value };
        }
        catch {
            return { ok: false, reasons: ['PROOF_ACTION_READ_FAILED'] };
        }
    };
    const actionIdentityReasons = (active) => {
        const current = readCurrentActionIdentity(active);
        if (!current.ok)
            return current.reasons;
        return sameProofAction(current.value, active.actionIdentity)
            ? []
            : ['PROOF_ACTION_IDENTITY_CHANGED'];
    };
    const repositoryPath = (active, path) => relative(active.context.projectRoot, path).replaceAll(sep, '/');
    const observedSetupScreenshots = (active) => {
        const owned = new Set();
        for (const observation of deps.monitor.observations()) {
            const step = active.context.storyboard.steps.find((candidate) => normalizeTool(candidate.assertionTool) === normalizeTool(observation.tool) &&
                candidate.screenshotPath === observation.screenshotPath &&
                candidate.assertionArgsSha256 === observation.argsHash);
            if (step && observation.ok && observation.assertionPassed) {
                owned.add(repositoryPath(active, step.screenshotPath));
            }
        }
        return owned;
    };
    const gitReasons = (active, git, phase) => {
        const proofOutputs = [
            active.context.videoPath,
            active.context.contactSheetPath,
            ...active.context.storyboard.steps.map((step) => step.screenshotPath),
        ].map((path) => repositoryPath(active, path));
        const requiredOutputs = new Set(phase === 'finalized'
            ? [...proofOutputs, repositoryPath(active, active.context.receiptPath)]
            : proofOutputs);
        const allowedOutputs = phase === 'setup'
            ? observedSetupScreenshots(active)
            : phase === 'clean'
                ? new Set()
                : requiredOutputs;
        const invalidChange = git.changes.some((change) => isAbsolute(change.path) ||
            change.path === '..' ||
            change.path.startsWith('../') ||
            change.indexStatus !== '?' ||
            change.worktreeStatus !== '?' ||
            change.sourcePath !== undefined);
        const changedPaths = new Set(git.changes.map((change) => change.path.replaceAll('\\', '/')));
        const unrelated = [...changedPaths].some((path) => !allowedOutputs.has(path));
        const missing = (phase === 'validation' || phase === 'finalized') &&
            [...requiredOutputs].some((path) => !changedPaths.has(path));
        return [
            ...(invalidChange || unrelated || git.dirty !== git.changes.length > 0 ? ['GIT_DIRTY'] : []),
            ...(missing ? ['PROOF_OUTPUT_MISSING'] : []),
            ...(git.sha !== active.context.storyboard.sourceTreeSha ||
                git.sha !== active.context.pullRequest.headSha
                ? ['SOURCE_SHA_MISMATCH']
                : []),
        ];
    };
    const readReadiness = async () => {
        let raw;
        try {
            raw = await deps.readiness();
        }
        catch {
            return { ok: false, reasons: ['READINESS_FAILED'] };
        }
        const parsed = readinessSchema.safeParse(raw);
        return parsed.success
            ? { ok: true, value: parsed.data }
            : { ok: false, reasons: ['READINESS_INVALID'] };
    };
    const readinessReasons = (readiness, baseline) => [
        ...(!readiness.cdpAttached ? ['CDP_DETACHED'] : []),
        ...(!readiness.helpersAttached ? ['HELPERS_DETACHED'] : []),
        ...(!readiness.metroReady || !readiness.runtime.metroReady ? ['METRO_NOT_READY'] : []),
        ...(!readiness.metroEventsConnected ? ['METRO_EVENTS_UNAVAILABLE'] : []),
        ...(readiness.metroBuildPending ? ['METRO_BUILD_PENDING'] : []),
        ...(readiness.metroBuildFailed ? ['METRO_BUILD_FAILED'] : []),
        ...(baseline
            ? readiness.errorCount !== baseline.errorCount ||
                readiness.errorSha256 !== baseline.errorSha256 ||
                readiness.errorCount !== 0
                ? ['ERROR_BASELINE_CHANGED']
                : []
            : readiness.errorCount !== 0
                ? ['ERROR_BASELINE_DIRTY']
                : []),
        ...(baseline && JSON.stringify(readiness.device) !== JSON.stringify(baseline.device)
            ? ['DEVICE_IDENTITY_CHANGED']
            : []),
        ...(baseline && JSON.stringify(readiness.runtime) !== JSON.stringify(baseline.runtime)
            ? ['RUNTIME_IDENTITY_CHANGED']
            : []),
        ...(baseline && readiness.metroEventMarker !== baseline.metroEventMarker
            ? ['METRO_ACTIVITY_CHANGED']
            : []),
    ];
    const deriveEvidence = (active) => {
        if (!active.recordingStartedAt)
            return { evidence: null, reasons: ['INVALID_PROOF_STAGE'] };
        const bound = sequenceObservations(active.context.storyboard, active.recordingObservations);
        if (!bound)
            return { evidence: null, reasons: ['STORYBOARD_ORDER_VIOLATION'] };
        const reasons = [];
        const evidence = active.context.storyboard.steps.map((step, index) => {
            const operation = bound[index].expected;
            const observed = bound[index].assertion;
            if (operation.argsHash !== step.expectedArgsSha256) {
                reasons.push('OPERATION_ARGUMENT_MISMATCH');
            }
            if (observed.argsHash !== step.assertionArgsSha256) {
                reasons.push('ASSERTION_ARGUMENT_MISMATCH');
            }
            if (!observed.ok || !observed.assertionPassed) {
                reasons.push('ASSERTION_FAILED');
                if (index === active.context.storyboard.steps.length - 1) {
                    reasons.push('FINAL_ASSERTION_FAILED');
                }
            }
            if (observed.screenshotPath !== step.screenshotPath) {
                reasons.push('SCREENSHOT_PATH_MISMATCH');
            }
            return {
                stepId: step.id,
                screenshotPath: observed.screenshotPath ?? '',
                timestampMs: observed.ts - active.recordingStartedAt.getTime(),
                assertion: {
                    stepId: step.id,
                    tool: step.assertionTool,
                    ok: true,
                    resultHash: observed.resultHash,
                },
            };
        });
        return { evidence, reasons: [...new Set(reasons)] };
    };
    return async (unparsedArgs) => {
        const parsed = proofCaptureInputSchema.safeParse(unparsedArgs);
        if (!parsed.success) {
            const action = unparsedArgs?.action;
            const reason = action === 'finalize' ? 'EVIDENCE_REVIEW_INVALID' : 'INVALID_PROOF_INPUT';
            return proofFailure([reason], session?.stage ?? 'idle');
        }
        const args = parsed.data;
        if (args.action === 'contract') {
            try {
                const contract = (deps.readContract ?? readProofContractAt)();
                if (hashBytes(contract.bytes) !== contract.sha256) {
                    return proofFailure(['CONTRACT_DIGEST_MISMATCH'], session?.stage ?? 'idle');
                }
                return okResult({ schema: contract.schema, sha256: contract.sha256 });
            }
            catch {
                return proofFailure(['CONTRACT_READ_FAILED'], session?.stage ?? 'idle');
            }
        }
        if (args.action === 'status') {
            return okResult({
                stage: session?.stage ?? 'idle',
                runId: session?.context.runId ?? null,
                invalidationReasons: session?.invalidationReasons ?? [],
            });
        }
        if (args.action === 'discard') {
            if (!session)
                return okResult({ stage: 'idle', discarded: false });
            deps.monitor.stop();
            const shutdown = await shutdownRecorder(session);
            const pathCurrent = contextIsCurrent(session);
            const removalReasons = pathCurrent ? await removeArtifacts(session) : ['PROOF_PATH_DRIFT'];
            const cleanupReasons = [...new Set([...shutdown.reasons, ...removalReasons])];
            if (!shutdown.confirmed || cleanupReasons.length > 0) {
                session.stage = 'rejected';
                session.invalidationReasons = cleanupReasons;
                return proofFailure(cleanupReasons, session.stage);
            }
            session = null;
            return okResult({ stage: 'idle', discarded: true });
        }
        if (args.action === 'begin_rehearsal') {
            if (session && session.stage !== 'accepted') {
                return proofFailure(['PROOF_SESSION_ACTIVE'], session.stage);
            }
            let expectedRoot = null;
            try {
                expectedRoot = deps.projectRoot();
            }
            catch {
                // An unresolved project root is never caller-recoverable proof identity.
            }
            if (!validCaptureContext(args, expectedRoot) ||
                args.storyboard.proofClass !== args.proofClass ||
                args.storyboard.actionId !== args.proofAction.id) {
                return proofFailure(['INVALID_PROOF_CONTEXT'], 'idle');
            }
            let actionIdentity = null;
            try {
                actionIdentity = deps.readActionIdentity(args.proofAction.id);
            }
            catch {
                return proofFailure(['PROOF_ACTION_READ_FAILED'], 'idle');
            }
            if (!actionIdentity)
                return proofFailure(['PROOF_ACTION_MISSING'], 'idle');
            if (!sameProofAction(actionIdentity, args.proofAction)) {
                return proofFailure(['PROOF_ACTION_IDENTITY_MISMATCH'], 'idle');
            }
            try {
                const proofRoot = join(args.projectRoot, 'docs', 'proof', args.runId);
                if (deps.proofRootTracked(args.projectRoot, proofRoot)) {
                    return proofFailure(['PROOF_ROOT_TRACKED'], 'idle');
                }
            }
            catch {
                return proofFailure(['PROOF_ROOT_TRACKED_CHECK_FAILED'], 'idle');
            }
            if (proofRootExists(args)) {
                return proofFailure(['PROOF_ROOT_NOT_FRESH'], 'idle');
            }
            const startedAt = deps.now();
            session = {
                context: args,
                actionIdentity,
                stage: 'rehearsing',
                invalidationReasons: [],
                rehearsalStartedAt: startedAt,
                rehearsalFinishedAt: null,
                rehearsalDurationMs: null,
                rehearsalEvents: [],
                rehearsalObservations: [],
                recordingStartedAt: null,
                recordingEvents: [],
                recordingObservations: [],
                evidenceDraft: null,
                armedObservationCount: null,
                freshStartAssertion: null,
                mayOwnRecorder: false,
                baseline: null,
                mechanicalReceipt: null,
            };
            deps.monitor.begin();
            return okResult({ stage: session.stage, runId: args.runId });
        }
        if (!session)
            return proofFailure(['INVALID_PROOF_STAGE'], 'idle');
        const active = session;
        if (args.action === 'finish_rehearsal') {
            if (active.stage !== 'rehearsing')
                return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
            active.rehearsalEvents = deps.monitor.stop();
            active.rehearsalObservations = deps.monitor.observations();
            const finishedAt = deps.now();
            const durationMs = finishedAt.getTime() - active.rehearsalStartedAt.getTime();
            const trace = validateTrace(['cdp_run_action'], active.rehearsalEvents);
            const actionObservation = active.rehearsalObservations.length === 1 &&
                normalizeTool(active.rehearsalObservations[0].tool) === 'cdp_run_action'
                ? active.rehearsalObservations[0]
                : null;
            const actionReasons = [
                ...(!actionObservation ? ['ACTION_REHEARSAL_SEQUENCE_INVALID'] : []),
                ...(actionObservation &&
                    actionObservation.argsHash !==
                        hashProofArgs({
                            actionId: active.context.proofAction.id,
                            autoRepair: false,
                            forceReload: false,
                            proofReplay: true,
                        })
                    ? ['ACTION_ARGUMENT_MISMATCH']
                    : []),
            ];
            const git = readGit(active);
            const authorityReasons = [
                ...actionIdentityReasons(active),
                ...(git.ok ? gitReasons(active, git.value, 'clean') : git.reasons),
            ];
            if (durationMs < 0 || !trace.ok || actionReasons.length > 0 || authorityReasons.length > 0) {
                const reasons = [
                    ...(durationMs < 0 ? ['REHEARSAL_CLOCK_INVALID'] : []),
                    ...trace.reasons,
                    ...actionReasons,
                    ...authorityReasons,
                ];
                beginFreshRehearsal(active, reasons);
                return proofFailure(reasons, active.stage);
            }
            active.rehearsalFinishedAt = finishedAt;
            active.rehearsalDurationMs = durationMs;
            active.stage = 'rehearsed';
            active.invalidationReasons = [];
            active.armedObservationCount = null;
            active.freshStartAssertion = null;
            deps.monitor.begin();
            return okResult({ stage: active.stage, durationMs });
        }
        if (args.action === 'arm') {
            if (active.stage !== 'rehearsed')
                return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
            const setupObservations = deps.monitor.observations();
            const firstStep = active.context.storyboard.steps[0];
            const assertions = setupObservations.filter((observation) => normalizeTool(observation.tool) === normalizeTool(firstStep.assertionTool));
            const startAssertion = assertions.at(-1) ?? null;
            const git = readGit(active);
            const ready = await readReadiness();
            const armReasons = [
                ...actionIdentityReasons(active),
                ...(!startAssertion ? ['START_ASSERTION_MISSING'] : []),
                ...(startAssertion &&
                    (!startAssertion.ok ||
                        !startAssertion.assertionPassed ||
                        startAssertion.screenshotPath !== firstStep.screenshotPath)
                    ? ['START_ASSERTION_FAILED']
                    : []),
                ...(startAssertion && startAssertion.argsHash !== firstStep.assertionArgsSha256
                    ? ['START_ASSERTION_ARGUMENT_MISMATCH']
                    : []),
                ...(startAssertion && setupObservations.at(-1) !== startAssertion
                    ? ['START_STATE_DRIFT']
                    : []),
                ...(git.ok ? gitReasons(active, git.value, 'setup') : git.reasons),
                ...(ready.ok ? readinessReasons(ready.value, null) : ready.reasons),
            ];
            if (armReasons.length > 0) {
                active.invalidationReasons = [...new Set(armReasons)];
                return proofFailure(armReasons, active.stage);
            }
            if (!ready.ok)
                return proofFailure(ready.reasons, active.stage);
            active.baseline = ready.value;
            active.armedObservationCount = setupObservations.length;
            active.freshStartAssertion = startAssertion;
            active.stage = 'armed';
            active.invalidationReasons = [];
            return okResult({
                stage: active.stage,
                device: ready.value.device,
                runtime: ready.value.runtime,
            });
        }
        if (args.action === 'start_recording') {
            if (active.stage !== 'armed' ||
                !active.baseline ||
                active.armedObservationCount === null ||
                !active.freshStartAssertion) {
                return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
            }
            if (!contextIsCurrent(active))
                return rejectPathDrift(active);
            const actionReasons = actionIdentityReasons(active);
            if (actionReasons.length > 0)
                return proofFailure(actionReasons, active.stage);
            const firstStep = active.context.storyboard.steps[0];
            const setupObservations = deps.monitor.observations();
            const postArmAssertion = setupObservations[active.armedObservationCount] ?? null;
            const postArmReasons = [
                ...(!postArmAssertion ? ['START_ASSERTION_MISSING'] : []),
                ...(postArmAssertion &&
                    normalizeTool(postArmAssertion.tool) !== normalizeTool(firstStep.assertionTool)
                    ? ['START_ASSERTION_MISSING', 'START_STATE_DRIFT']
                    : []),
                ...(postArmAssertion &&
                    (!postArmAssertion.ok ||
                        !postArmAssertion.assertionPassed ||
                        postArmAssertion.screenshotPath !== firstStep.screenshotPath)
                    ? ['START_ASSERTION_FAILED']
                    : []),
                ...(postArmAssertion && postArmAssertion.argsHash !== firstStep.assertionArgsSha256
                    ? ['START_ASSERTION_ARGUMENT_MISMATCH']
                    : []),
                ...(setupObservations.length !== active.armedObservationCount + 1
                    ? ['START_STATE_DRIFT']
                    : []),
            ];
            if (postArmReasons.length > 0)
                return proofFailure(postArmReasons, active.stage);
            active.freshStartAssertion = postArmAssertion;
            active.armedObservationCount = setupObservations.length;
            const stillAtStart = () => {
                const observations = deps.monitor.observations();
                return (observations.length === active.armedObservationCount &&
                    observations.at(-1)?.resultHash === active.freshStartAssertion?.resultHash &&
                    observations.at(-1)?.ts === active.freshStartAssertion?.ts);
            };
            if (!stillAtStart())
                return proofFailure(['START_STATE_DRIFT'], active.stage);
            const git = readGit(active);
            const ready = await readReadiness();
            const startReasons = [
                ...(git.ok ? gitReasons(active, git.value, 'setup') : git.reasons),
                ...(ready.ok ? readinessReasons(ready.value, active.baseline) : ready.reasons),
            ];
            if (startReasons.length > 0)
                return proofFailure(startReasons, active.stage);
            const cleanupReasons = await removeArtifacts(active);
            if (cleanupReasons.length > 0) {
                active.stage = 'rejected';
                active.invalidationReasons = cleanupReasons;
                return proofFailure(cleanupReasons, active.stage);
            }
            const cleanedGit = readGit(active);
            const cleanedGitReasons = cleanedGit.ok
                ? gitReasons(active, cleanedGit.value, 'clean')
                : cleanedGit.reasons;
            if (cleanedGitReasons.length > 0) {
                active.stage = 'rejected';
                active.invalidationReasons = cleanedGitReasons;
                return proofFailure(cleanedGitReasons, active.stage);
            }
            if (!stillAtStart())
                return proofFailure(['START_STATE_DRIFT'], active.stage);
            let statusResult;
            try {
                statusResult = await deps.record({ action: 'status' });
            }
            catch {
                return proofFailure(['RECORDING_STATUS_FAILED'], active.stage);
            }
            const status = toolData(statusResult);
            const recordings = status?.active;
            if (!Array.isArray(recordings))
                return proofFailure(['RECORDING_STATUS_FAILED'], active.stage);
            if (recordings.length > 0) {
                return proofFailure(['RECORDING_ALREADY_ACTIVE'], active.stage);
            }
            if (!stillAtStart())
                return proofFailure(['START_STATE_DRIFT'], active.stage);
            let startResult;
            active.mayOwnRecorder = true;
            try {
                startResult = await deps.record({
                    action: 'start',
                    platform: active.baseline.device.platform,
                    deviceId: active.baseline.device.id,
                    outputPath: active.context.videoPath,
                });
            }
            catch {
                return rejectCapture(active, ['RECORDING_START_FAILED']);
            }
            const started = toolData(startResult);
            if (!started)
                return rejectCapture(active, ['RECORDING_START_FAILED']);
            const reasons = [
                ...(started.deviceId !== active.baseline.device.id ? ['RECORDING_DEVICE_MISMATCH'] : []),
                ...(started.output !== active.context.videoPath ? ['RECORDING_PATH_MISMATCH'] : []),
            ];
            if (reasons.length > 0)
                return rejectCapture(active, reasons);
            active.recordingStartedAt = deps.now();
            active.stage = 'recording';
            active.invalidationReasons = [];
            deps.monitor.begin();
            return okResult({ stage: active.stage, deviceId: started.deviceId, output: started.output });
        }
        if (args.action === 'stop_recording') {
            if (active.stage !== 'recording')
                return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
            active.recordingEvents = deps.monitor.stop();
            active.recordingObservations = deps.monitor.observations();
            const pathDrifted = !contextIsCurrent(active);
            const shutdown = await shutdownRecorder(active);
            if (pathDrifted) {
                active.stage = 'rejected';
                active.invalidationReasons = [...new Set(['PROOF_PATH_DRIFT', ...shutdown.reasons])];
                return proofFailure(active.invalidationReasons, active.stage);
            }
            if (!shutdown.confirmed || shutdown.reasons.length > 0) {
                return rejectCapture(active, shutdown.reasons);
            }
            const saved = shutdown.stopData?.saved;
            if (!Array.isArray(saved))
                return rejectCapture(active, ['RECORDING_STOP_FAILED']);
            if (saved.length !== 1)
                return rejectCapture(active, ['RECORDING_AMBIGUOUS']);
            const savedPath = saved[0].path;
            if (savedPath !== active.context.videoPath) {
                return rejectCapture(active, ['RECORDING_PATH_MISMATCH']);
            }
            const derived = deriveEvidence(active);
            active.evidenceDraft = derived.evidence;
            active.stage = 'validating';
            active.invalidationReasons = [];
            return okResult({
                stage: active.stage,
                videoPath: savedPath,
                evidenceDraft: derived.evidence,
                evidenceReasons: derived.reasons,
            });
        }
        if (args.action === 'validate') {
            if (active.stage !== 'validating' ||
                !active.baseline ||
                !active.recordingStartedAt ||
                active.rehearsalDurationMs === null ||
                !active.rehearsalFinishedAt) {
                return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
            }
            if (!contextIsCurrent(active))
                return rejectPathDrift(active);
            const actionReasons = actionIdentityReasons(active);
            if (actionReasons.length > 0)
                return rejectCapture(active, actionReasons);
            const derived = deriveEvidence(active);
            const evidence = derived.evidence ?? [];
            const steps = active.context.storyboard.steps;
            const evidenceReasons = [...derived.reasons];
            const trace = traceFor(active.context.storyboard, active.recordingEvents);
            evidenceReasons.push(...trace.reasons);
            if (!derived.evidence)
                evidenceReasons.push('STEP_EVIDENCE_MISSING');
            const mediaInput = {
                videoPath: active.context.videoPath,
                rehearsalDurationMs: active.rehearsalDurationMs,
                screenshots: evidence.map((item) => ({
                    stepId: item.stepId,
                    path: item.screenshotPath,
                    timestampMs: item.timestampMs,
                })),
                contactSheetPath: active.context.contactSheetPath,
            };
            let media;
            try {
                media = await deps.validateMedia(deps.mediaProcess, mediaInput);
            }
            catch {
                return rejectCapture(active, ['MEDIA_VALIDATION_FAILED']);
            }
            if (!contextIsCurrent(active))
                return rejectPathDrift(active);
            if (!media.ok)
                evidenceReasons.push(...media.reasons);
            if (media.ok) {
                const timestamps = evidence.map((item) => item.timestampMs);
                const increasing = timestamps.every((timestamp, index) => timestamp >= 0 &&
                    timestamp <= media.video.durationMs &&
                    (index === 0 || timestamp > timestamps[index - 1]));
                if (!increasing)
                    evidenceReasons.push('SCREENSHOT_TIMESTAMPS_INVALID');
                for (const [index, step] of steps.entries()) {
                    const dwellEnd = timestamps[index + 1] ?? media.video.durationMs;
                    const dwell = dwellEnd - (timestamps[index] ?? 0);
                    if (dwell < step.expectedDwellMs || dwell > step.maximumDwellMs) {
                        evidenceReasons.push('STEP_DWELL_OUT_OF_BOUNDS');
                    }
                }
                if (media.screenshots.length !== evidence.length ||
                    media.screenshots.some((screenshot, index) => screenshot.stepId !== evidence[index]?.stepId ||
                        screenshot.path !== evidence[index]?.screenshotPath ||
                        screenshot.timestampMs !== evidence[index]?.timestampMs)) {
                    evidenceReasons.push('MEDIA_EVIDENCE_MISMATCH');
                }
            }
            const git = readGit(active);
            const ready = await readReadiness();
            evidenceReasons.push(...(git.ok ? gitReasons(active, git.value, 'validation') : git.reasons));
            evidenceReasons.push(...(ready.ok ? readinessReasons(ready.value, active.baseline) : ready.reasons));
            if (evidenceReasons.length > 0 || !media.ok || !ready.ok || !git.ok) {
                return rejectCapture(active, evidenceReasons);
            }
            const storyboardBytes = JSON.stringify(active.context.storyboard);
            let receipt;
            try {
                receipt = mechanicallyAcceptedProofReceiptSchema.parse({
                    schemaVersion: 1,
                    runId: active.context.runId,
                    issue: active.context.issue,
                    pullRequest: active.context.pullRequest,
                    proofClass: active.context.proofClass,
                    acceptanceMappings: active.context.acceptanceMappings,
                    git: {
                        sourceTreeSha: active.context.storyboard.sourceTreeSha,
                        proofHeadSha: git.value.sha,
                        dirty: false,
                    },
                    device: ready.value.device,
                    runtime: ready.value.runtime,
                    fixture: active.context.fixture,
                    action: active.context.proofAction,
                    storyboard: { id: active.context.storyboard.id, sha256: hashBytes(storyboardBytes) },
                    rehearsal: {
                        startedAt: active.rehearsalStartedAt.toISOString(),
                        finishedAt: active.rehearsalFinishedAt.toISOString(),
                        durationMs: active.rehearsalDurationMs,
                        clean: true,
                    },
                    video: media.video,
                    screenshots: media.screenshots,
                    assertions: evidence.map((item) => item.assertion),
                    eventTrace: {
                        allowedTools: active.context.storyboard.allowedTools,
                        observed: active.recordingEvents,
                    },
                    frameMatches: media.frameMatches,
                    contactSheet: media.contactSheet,
                    errorBaseline: {
                        beforeSha256: active.baseline.errorSha256,
                        afterSha256: ready.value.errorSha256,
                        beforeCount: active.baseline.errorCount,
                        afterCount: ready.value.errorCount,
                        clean: true,
                    },
                    invalidationReasons: [],
                    verdict: 'mechanically_accepted',
                });
            }
            catch {
                return rejectCapture(active, ['RECEIPT_CONSTRUCTION_FAILED']);
            }
            active.mechanicalReceipt = receipt;
            active.stage = 'mechanically_accepted';
            active.invalidationReasons = [];
            return okResult({ stage: active.stage, receipt });
        }
        if (args.action === 'finalize') {
            if (active.stage !== 'mechanically_accepted' || !active.mechanicalReceipt) {
                return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
            }
            if (!contextIsCurrent(active))
                return rejectPathDrift(active);
            let review;
            try {
                review = evidenceReviewSchema.parse(args.evidenceReview);
            }
            catch {
                return proofFailure(['EVIDENCE_REVIEW_INVALID'], active.stage);
            }
            if (review.provider === active.context.writerProvider ||
                review.provider === review.writerProvider ||
                review.writerProvider !== active.context.writerProvider) {
                return proofFailure(['REVIEWER_NOT_INDEPENDENT'], active.stage);
            }
            const { verdict: _mechanicalVerdict, ...acceptedEvidence } = active.mechanicalReceipt;
            let finalReceipt;
            try {
                finalReceipt = finalProofReceiptSchema.parse({
                    ...acceptedEvidence,
                    evidenceReview: review,
                    verdict: 'accepted',
                });
            }
            catch {
                return proofFailure(['RECEIPT_CONSTRUCTION_FAILED'], active.stage);
            }
            if (!contextIsCurrent(active))
                return rejectPathDrift(active);
            try {
                deps.writeReceipt(active.context.receiptPath, finalReceipt);
            }
            catch {
                return proofFailure(['RECEIPT_WRITE_FAILED'], active.stage);
            }
            const finalizedGit = readGit(active);
            const finalizedGitReasons = finalizedGit.ok
                ? gitReasons(active, finalizedGit.value, 'finalized')
                : finalizedGit.reasons;
            if (finalizedGitReasons.length > 0) {
                return rejectCapture(active, finalizedGitReasons);
            }
            active.stage = 'accepted';
            return okResult({
                stage: active.stage,
                receiptPath: active.context.receiptPath,
                receipt: finalReceipt,
            });
        }
        return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
    };
}
