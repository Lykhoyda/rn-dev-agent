import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  StrictProofMonitor,
  validateTrace,
  type ProofObservation,
} from '../domain/proof-capture.js';
import {
  acceptanceMappingSchema,
  evidenceReviewSchema,
  finalProofReceiptSchema,
  mechanicallyAcceptedProofReceiptSchema,
  proofActionSchema,
  proofAssertionSchema,
  proofClassSchema,
  proofDeviceSchema,
  proofFixtureSchema,
  proofIssueSchema,
  proofPullRequestSchema,
  proofRuntimeSchema,
  storyboardSchema,
  type EvidenceReview,
  type FinalProofReceipt,
  type MechanicallyAcceptedProofReceipt,
  type ProofDevice,
  type ProofRuntime,
  type ProofStage,
  type Storyboard,
} from '../domain/proof-receipt.js';
import type { DeviceRecordArgs } from './device-record.js';
import { validateMedia, type MediaProcess, type MediaValidationInput } from './proof-media.js';
import { failResult, okResult, type ToolResult } from '../utils.js';

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

const sessionActionSchema = <T extends string>(action: T) =>
  z.object({ action: z.literal(action) }).strict();

const stepEvidenceSchema = z
  .object({
    stepId: z.string().min(1),
    screenshotPath: absolutePathSchema,
    timestampMs: z.number().nonnegative(),
    assertion: proofAssertionSchema,
  })
  .strict();

const validateSchema = z
  .object({
    action: z.literal('validate'),
    evidence: z.array(stepEvidenceSchema),
  })
  .strict();

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

export type ProofCaptureArgs = z.infer<typeof proofCaptureInputSchema>;
type BeginRehearsalArgs = z.infer<typeof beginRehearsalSchema>;

export interface ProofReadiness {
  cdpAttached: boolean;
  helpersAttached: boolean;
  metroReady: boolean;
  metroBuildPending: boolean;
  metroBuildFailed: boolean;
  errorCount: number;
  errorSha256: string;
  device: ProofDevice;
  runtime: ProofRuntime;
}

export interface ProofCaptureDeps {
  monitor: StrictProofMonitor;
  projectRoot: () => string | null;
  getGitInfo: (root: string) => { sha: string | null; dirty: boolean };
  readiness: () => Promise<ProofReadiness>;
  record: (args: DeviceRecordArgs) => Promise<ToolResult>;
  mediaProcess: MediaProcess;
  validateMedia: typeof validateMedia;
  now: () => Date;
  writeReceipt: (path: string, receipt: FinalProofReceipt) => void;
  removeArtifact: (path: string) => Promise<void> | void;
  readContract?: () => { schema: unknown; bytes: string; sha256: string };
}

interface Session {
  context: BeginRehearsalArgs;
  stage: ProofStage;
  invalidationReasons: string[];
  rehearsalStartedAt: Date;
  rehearsalFinishedAt: Date | null;
  rehearsalDurationMs: number | null;
  rehearsalEvents: ReturnType<StrictProofMonitor['snapshot']>;
  rehearsalObservations: readonly ProofObservation[];
  recordingStartedAt: Date | null;
  recordingEvents: ReturnType<StrictProofMonitor['snapshot']>;
  recordingObservations: readonly ProofObservation[];
  baseline: ProofReadiness | null;
  mechanicalReceipt: MechanicallyAcceptedProofReceipt | null;
}

const readinessSchema = z
  .object({
    cdpAttached: z.boolean(),
    helpersAttached: z.boolean(),
    metroReady: z.boolean(),
    metroBuildPending: z.boolean(),
    metroBuildFailed: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    errorSha256: z.string().regex(/^[0-9a-f]{64}$/),
    device: proofDeviceSchema,
    runtime: proofRuntimeSchema,
  })
  .strict();

function hashBytes(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNormalizedDescendant(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path) || resolve(root) !== root || resolve(path) !== path) {
    return false;
  }
  const fromRoot = relative(root, path);
  return (
    fromRoot.length > 0 &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function hasExistingSymlink(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep);
  for (let length = 0; length <= parts.length; length += 1) {
    const candidate = resolve(root, ...parts.slice(0, length));
    try {
      if (lstatSync(candidate).isSymbolicLink()) return true;
    } catch {
      // A nonexistent descendant cannot currently redirect outside the root.
    }
  }
  return false;
}

function validCaptureContext(args: BeginRehearsalArgs, expectedRoot: string | null): boolean {
  if (
    !expectedRoot ||
    args.projectRoot !== expectedRoot ||
    resolve(expectedRoot) !== expectedRoot
  ) {
    return false;
  }
  const screenshots = args.storyboard.steps.map((step) => step.screenshotPath);
  const destinations = [args.receiptPath, args.videoPath, args.contactSheetPath, ...screenshots];
  if (
    destinations.some(
      (path) =>
        !isNormalizedDescendant(expectedRoot, path) || hasExistingSymlink(expectedRoot, path),
    ) ||
    new Set(destinations).size !== destinations.length
  ) {
    return false;
  }
  const imageExtensions = new Set(['.jpg', '.jpeg', '.png']);
  return (
    basename(args.receiptPath) === 'proof-receipt.json' &&
    extname(args.videoPath).toLowerCase() === '.mp4' &&
    ['.jpg', '.jpeg'].includes(extname(args.contactSheetPath).toLowerCase()) &&
    screenshots.every((path) => imageExtensions.has(extname(path).toLowerCase()))
  );
}

export function resolveProofWorktreeRoot(detectedProjectRoot: string | null): string | null {
  if (
    !detectedProjectRoot ||
    !isAbsolute(detectedProjectRoot) ||
    resolve(detectedProjectRoot) !== detectedProjectRoot
  ) {
    return null;
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: detectedProjectRoot,
      encoding: 'utf8',
    }).trim();
    return root && isAbsolute(root) && resolve(root) === root ? root : null;
  } catch {
    return null;
  }
}

function normalizeTool(tool: string): string {
  const bare = tool.startsWith('mcp__') ? (tool.split('__').at(-1) ?? tool) : tool;
  return bare
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replaceAll('-', '_');
}

function toolData(result: ToolResult): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? '') as {
      ok?: boolean;
      data?: Record<string, unknown>;
    };
    return parsed.ok === true && parsed.data && typeof parsed.data === 'object'
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

function proofFailure(reasons: readonly string[], stage: ProofStage): ToolResult {
  return failResult('Strict proof capture rejected.', {
    reasons: [...new Set(reasons)],
    stage,
  });
}

function requiredToolSequence(storyboard: Storyboard): string[] {
  return storyboard.steps.flatMap((step) => [step.expectedTool, step.assertionTool]);
}

function sequenceObservations(
  storyboard: Storyboard,
  observations: readonly ProofObservation[],
): Array<{ expected: ProofObservation; assertion: ProofObservation }> | null {
  const required = requiredToolSequence(storyboard).map(normalizeTool);
  const relevant = observations.filter((observation) =>
    required.includes(normalizeTool(observation.tool)),
  );
  if (relevant.length !== required.length) return null;
  if (relevant.some((observation, index) => normalizeTool(observation.tool) !== required[index])) {
    return null;
  }
  return storyboard.steps.map((_, index) => ({
    expected: relevant[index * 2]!,
    assertion: relevant[index * 2 + 1]!,
  }));
}

function traceFor(storyboard: Storyboard, events: ReturnType<StrictProofMonitor['snapshot']>) {
  const required = requiredToolSequence(storyboard);
  const allowedExtras = storyboard.allowedTools.filter(
    (tool) => !required.map(normalizeTool).includes(normalizeTool(tool)),
  );
  return validateTrace([...required, ...allowedExtras], events);
}

function defaultContract(): { schema: unknown; bytes: string; sha256: string } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const path = resolve(moduleDir, '../../schemas/proof-receipt.schema.json');
  const bytes = readFileSync(path, 'utf8');
  return { schema: JSON.parse(bytes), bytes, sha256: hashBytes(bytes) };
}

export function writeProofReceiptAtomic(path: string, receipt: FinalProofReceipt): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${randomUUID()}.proof-receipt.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of an unpromoted sibling temp file.
    }
    throw error;
  }
}

export function createProofCaptureHandler(
  deps: ProofCaptureDeps,
): (args: ProofCaptureArgs) => Promise<ToolResult> {
  let session: Session | null = null;

  const contextIsCurrent = (active: Session): boolean => {
    try {
      return validCaptureContext(active.context, deps.projectRoot());
    } catch {
      return false;
    }
  };

  const rejectPathDrift = (active: Session): ToolResult => {
    active.stage = 'rejected';
    active.invalidationReasons = ['PROOF_PATH_DRIFT'];
    return proofFailure(active.invalidationReasons, active.stage);
  };

  const artifactPaths = (active: Session): string[] => [
    active.context.videoPath,
    active.context.contactSheetPath,
    ...active.context.storyboard.steps.map((step) => step.screenshotPath),
  ];

  const removeArtifacts = async (active: Session): Promise<boolean> => {
    if (!contextIsCurrent(active)) return false;
    await Promise.all(
      artifactPaths(active).map(async (path) => {
        try {
          await deps.removeArtifact(path);
        } catch {
          // Rejection remains authoritative even when cleanup needs a later retry.
        }
      }),
    );
    return true;
  };

  const beginFreshRehearsal = (active: Session, reasons: readonly string[]): void => {
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
    active.baseline = null;
    active.mechanicalReceipt = null;
    deps.monitor.begin();
  };

  const rejectCapture = async (
    active: Session,
    reasons: readonly string[],
    stopRecording: boolean,
  ): Promise<ToolResult> => {
    deps.monitor.stop();
    if (stopRecording) {
      try {
        await deps.record({ action: 'stop' });
      } catch {
        // The original stable reason remains primary.
      }
    }
    if (!(await removeArtifacts(active))) return rejectPathDrift(active);
    beginFreshRehearsal(active, reasons);
    return proofFailure(reasons, active.stage);
  };

  return async (unparsedArgs: ProofCaptureArgs): Promise<ToolResult> => {
    const parsed = proofCaptureInputSchema.safeParse(unparsedArgs);
    if (!parsed.success) {
      const action = (unparsedArgs as { action?: unknown })?.action;
      const reason = action === 'finalize' ? 'EVIDENCE_REVIEW_INVALID' : 'INVALID_PROOF_INPUT';
      return proofFailure([reason], session?.stage ?? 'idle');
    }
    const args = parsed.data;

    if (args.action === 'contract') {
      try {
        const contract = (deps.readContract ?? defaultContract)();
        if (hashBytes(contract.bytes) !== contract.sha256) {
          return proofFailure(['CONTRACT_DIGEST_MISMATCH'], session?.stage ?? 'idle');
        }
        return okResult({ schema: contract.schema, sha256: contract.sha256 });
      } catch {
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
      if (!session) return okResult({ stage: 'idle', discarded: false });
      deps.monitor.stop();
      if (!contextIsCurrent(session)) {
        if (session.stage === 'recording') {
          try {
            await deps.record({ action: 'stop' });
          } catch {
            // Path drift remains primary after best-effort recorder shutdown.
          }
        }
        return rejectPathDrift(session);
      }
      if (session.stage === 'recording') {
        try {
          await deps.record({ action: 'stop' });
        } catch {
          // Artifact removal still proceeds.
        }
      }
      if (!(await removeArtifacts(session))) return rejectPathDrift(session);
      session = null;
      return okResult({ stage: 'idle', discarded: true });
    }

    if (args.action === 'begin_rehearsal') {
      if (session && session.stage !== 'accepted') {
        return proofFailure(['PROOF_SESSION_ACTIVE'], session.stage);
      }
      let expectedRoot: string | null = null;
      try {
        expectedRoot = deps.projectRoot();
      } catch {
        // An unresolved project root is never caller-recoverable proof identity.
      }
      if (
        !validCaptureContext(args, expectedRoot) ||
        args.storyboard.proofClass !== args.proofClass ||
        args.storyboard.actionId !== args.proofAction.id
      ) {
        return proofFailure(['INVALID_PROOF_CONTEXT'], 'idle');
      }
      const startedAt = deps.now();
      session = {
        context: args,
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
        baseline: null,
        mechanicalReceipt: null,
      };
      deps.monitor.begin();
      return okResult({ stage: session.stage, runId: args.runId });
    }

    if (!session) return proofFailure(['INVALID_PROOF_STAGE'], 'idle');
    const active = session;

    if (args.action === 'finish_rehearsal') {
      if (active.stage !== 'rehearsing') return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
      active.rehearsalEvents = deps.monitor.stop();
      active.rehearsalObservations = deps.monitor.observations();
      const finishedAt = deps.now();
      const durationMs = finishedAt.getTime() - active.rehearsalStartedAt.getTime();
      const trace = traceFor(active.context.storyboard, active.rehearsalEvents);
      const sequence = sequenceObservations(
        active.context.storyboard,
        active.rehearsalObservations,
      );
      if (durationMs < 0 || !trace.ok || !sequence) {
        const reasons = [
          ...(durationMs < 0 ? ['REHEARSAL_CLOCK_INVALID'] : []),
          ...trace.reasons,
          ...(sequence ? [] : ['STORYBOARD_ORDER_VIOLATION']),
        ];
        beginFreshRehearsal(active, reasons);
        return proofFailure(reasons, active.stage);
      }
      active.rehearsalFinishedAt = finishedAt;
      active.rehearsalDurationMs = durationMs;
      active.stage = 'rehearsed';
      active.invalidationReasons = [];
      return okResult({ stage: active.stage, durationMs });
    }

    if (args.action === 'arm') {
      if (active.stage !== 'rehearsed') return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
      const git = deps.getGitInfo(active.context.projectRoot);
      let readiness: ProofReadiness;
      try {
        readiness = readinessSchema.parse(await deps.readiness());
      } catch {
        return proofFailure(['READINESS_INVALID'], active.stage);
      }
      const startAssertion = sequenceObservations(
        active.context.storyboard,
        active.rehearsalObservations,
      )?.[0]?.assertion;
      const armReasons = [
        ...(git.dirty ? ['GIT_DIRTY'] : []),
        ...(git.sha !== active.context.storyboard.sourceTreeSha ||
        git.sha !== active.context.pullRequest.headSha
          ? ['SOURCE_SHA_MISMATCH']
          : []),
        ...(!readiness.cdpAttached ? ['CDP_DETACHED'] : []),
        ...(!readiness.helpersAttached ? ['HELPERS_DETACHED'] : []),
        ...(!readiness.metroReady || !readiness.runtime.metroReady ? ['METRO_NOT_READY'] : []),
        ...(readiness.metroBuildPending ? ['METRO_BUILD_PENDING'] : []),
        ...(readiness.metroBuildFailed ? ['METRO_BUILD_FAILED'] : []),
        ...(readiness.errorCount !== 0 ? ['ERROR_BASELINE_DIRTY'] : []),
        ...(!startAssertion?.ok || !startAssertion.assertionPassed
          ? ['START_ASSERTION_FAILED']
          : []),
      ];
      if (armReasons.length > 0) {
        active.invalidationReasons = [...new Set(armReasons)];
        return proofFailure(armReasons, active.stage);
      }
      active.baseline = readiness;
      active.stage = 'armed';
      active.invalidationReasons = [];
      return okResult({
        stage: active.stage,
        device: readiness.device,
        runtime: readiness.runtime,
      });
    }

    if (args.action === 'start_recording') {
      if (active.stage !== 'armed' || !active.baseline) {
        return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
      }
      if (!contextIsCurrent(active)) return rejectPathDrift(active);
      let statusResult: ToolResult;
      try {
        statusResult = await deps.record({ action: 'status' });
      } catch {
        return proofFailure(['RECORDING_STATUS_FAILED'], active.stage);
      }
      const status = toolData(statusResult);
      const recordings = status?.active;
      if (!Array.isArray(recordings))
        return proofFailure(['RECORDING_STATUS_FAILED'], active.stage);
      if (recordings.length > 0) {
        return proofFailure(['RECORDING_ALREADY_ACTIVE'], active.stage);
      }
      let startResult: ToolResult;
      try {
        startResult = await deps.record({
          action: 'start',
          platform: active.baseline.device.platform,
          deviceId: active.baseline.device.id,
          outputPath: active.context.videoPath,
        });
      } catch {
        return rejectCapture(active, ['RECORDING_START_FAILED'], true);
      }
      const started = toolData(startResult);
      if (!started) return rejectCapture(active, ['RECORDING_START_FAILED'], true);
      const reasons = [
        ...(started.deviceId !== active.baseline.device.id ? ['RECORDING_DEVICE_MISMATCH'] : []),
        ...(started.output !== active.context.videoPath ? ['RECORDING_PATH_MISMATCH'] : []),
      ];
      if (reasons.length > 0) return rejectCapture(active, reasons, true);
      active.recordingStartedAt = deps.now();
      active.stage = 'recording';
      active.invalidationReasons = [];
      deps.monitor.begin();
      return okResult({ stage: active.stage, deviceId: started.deviceId, output: started.output });
    }

    if (args.action === 'stop_recording') {
      if (active.stage !== 'recording') return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
      active.recordingEvents = deps.monitor.stop();
      active.recordingObservations = deps.monitor.observations();
      const pathDrifted = !contextIsCurrent(active);
      let stopResult: ToolResult;
      try {
        stopResult = await deps.record({ action: 'stop' });
      } catch {
        if (pathDrifted) return rejectPathDrift(active);
        return rejectCapture(active, ['RECORDING_STOP_FAILED'], false);
      }
      if (pathDrifted) return rejectPathDrift(active);
      const stopped = toolData(stopResult);
      const saved = stopped?.saved;
      if (!Array.isArray(saved)) return rejectCapture(active, ['RECORDING_STOP_FAILED'], false);
      if (saved.length !== 1) return rejectCapture(active, ['RECORDING_AMBIGUOUS'], false);
      const savedPath = (saved[0] as { path?: unknown }).path;
      if (savedPath !== active.context.videoPath) {
        return rejectCapture(active, ['RECORDING_PATH_MISMATCH'], false);
      }
      active.stage = 'validating';
      active.invalidationReasons = [];
      return okResult({ stage: active.stage, videoPath: savedPath });
    }

    if (args.action === 'validate') {
      if (
        active.stage !== 'validating' ||
        !active.baseline ||
        !active.recordingStartedAt ||
        active.rehearsalDurationMs === null ||
        !active.rehearsalFinishedAt
      ) {
        return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
      }
      if (!contextIsCurrent(active)) return rejectPathDrift(active);
      const evidence = args.evidence;
      const steps = active.context.storyboard.steps;
      const ids = evidence.map((item) => item.stepId);
      const expectedIds = steps.map((step) => step.id);
      const evidenceReasons: string[] = [];
      if (evidence.length !== steps.length) evidenceReasons.push('STEP_EVIDENCE_MISSING');
      if (new Set(ids).size !== ids.length) evidenceReasons.push('STEP_EVIDENCE_DUPLICATE');
      if (JSON.stringify(ids) !== JSON.stringify(expectedIds))
        evidenceReasons.push('STEP_EVIDENCE_ORDER');

      const trace = traceFor(active.context.storyboard, active.recordingEvents);
      evidenceReasons.push(...trace.reasons);
      const bound = sequenceObservations(active.context.storyboard, active.recordingObservations);
      if (!bound) evidenceReasons.push('STORYBOARD_ORDER_VIOLATION');

      if (bound && evidence.length === steps.length) {
        for (const [index, step] of steps.entries()) {
          const item = evidence[index]!;
          const observed = bound[index]!.assertion;
          const observedTimestamp = observed.ts - active.recordingStartedAt.getTime();
          if (
            item.screenshotPath !== step.screenshotPath ||
            observed.screenshotPath !== step.screenshotPath
          ) {
            evidenceReasons.push('SCREENSHOT_PATH_MISMATCH');
            if (
              observed.screenshotPath !== null &&
              steps.some(
                (candidate) =>
                  candidate.id !== step.id && candidate.screenshotPath === observed.screenshotPath,
              )
            ) {
              evidenceReasons.push('STORYBOARD_ORDER_VIOLATION');
            }
          }
          if (item.assertion.stepId !== step.id || item.assertion.tool !== step.assertionTool) {
            evidenceReasons.push('ASSERTION_TOOL_MISMATCH');
          }
          if (!item.assertion.ok || !observed.ok || !observed.assertionPassed) {
            evidenceReasons.push('ASSERTION_FAILED');
            if (index === steps.length - 1) evidenceReasons.push('FINAL_ASSERTION_FAILED');
          }
          if (item.assertion.resultHash !== observed.resultHash) {
            evidenceReasons.push('ASSERTION_RESULT_HASH_MISMATCH');
            if (index === steps.length - 1) evidenceReasons.push('FINAL_ASSERTION_FAILED');
          }
          if (item.timestampMs !== observedTimestamp) {
            evidenceReasons.push('SCREENSHOT_TIMESTAMP_MISMATCH');
          }
        }
      }

      const mediaInput: MediaValidationInput = {
        videoPath: active.context.videoPath,
        rehearsalDurationMs: active.rehearsalDurationMs,
        screenshots: evidence.map((item) => ({
          stepId: item.stepId,
          path: item.screenshotPath,
          timestampMs: item.timestampMs,
        })),
        contactSheetPath: active.context.contactSheetPath,
      };
      const media = await deps.validateMedia(deps.mediaProcess, mediaInput);
      if (!contextIsCurrent(active)) return rejectPathDrift(active);
      if (!media.ok) evidenceReasons.push(...media.reasons);

      if (media.ok) {
        const timestamps = evidence.map((item) => item.timestampMs);
        const increasing = timestamps.every(
          (timestamp, index) =>
            timestamp >= 0 &&
            timestamp <= media.video.durationMs &&
            (index === 0 || timestamp > timestamps[index - 1]!),
        );
        if (!increasing) evidenceReasons.push('SCREENSHOT_TIMESTAMPS_INVALID');
        for (const [index, step] of steps.entries()) {
          const dwellEnd = timestamps[index + 1] ?? media.video.durationMs;
          const dwell = dwellEnd - (timestamps[index] ?? 0);
          if (dwell < step.expectedDwellMs || dwell > step.maximumDwellMs) {
            evidenceReasons.push('STEP_DWELL_OUT_OF_BOUNDS');
          }
        }
        if (
          media.screenshots.length !== evidence.length ||
          media.screenshots.some(
            (screenshot, index) =>
              screenshot.stepId !== evidence[index]?.stepId ||
              screenshot.path !== evidence[index]?.screenshotPath ||
              screenshot.timestampMs !== evidence[index]?.timestampMs,
          )
        ) {
          evidenceReasons.push('MEDIA_EVIDENCE_MISMATCH');
        }
      }

      const git = deps.getGitInfo(active.context.projectRoot);
      let after: ProofReadiness | null = null;
      try {
        after = readinessSchema.parse(await deps.readiness());
      } catch {
        evidenceReasons.push('READINESS_INVALID');
      }
      if (git.dirty) evidenceReasons.push('GIT_DIRTY');
      if (
        git.sha !== active.context.storyboard.sourceTreeSha ||
        git.sha !== active.context.pullRequest.headSha
      ) {
        evidenceReasons.push('SOURCE_SHA_MISMATCH');
      }
      if (after) {
        if (!after.cdpAttached) evidenceReasons.push('CDP_DETACHED');
        if (!after.helpersAttached) evidenceReasons.push('HELPERS_DETACHED');
        if (!after.metroReady || !after.runtime.metroReady) evidenceReasons.push('METRO_NOT_READY');
        if (after.metroBuildPending) evidenceReasons.push('METRO_BUILD_PENDING');
        if (after.metroBuildFailed) evidenceReasons.push('METRO_BUILD_FAILED');
        if (
          after.errorCount !== active.baseline.errorCount ||
          after.errorSha256 !== active.baseline.errorSha256 ||
          after.errorCount !== 0
        ) {
          evidenceReasons.push('ERROR_BASELINE_CHANGED');
        }
        if (JSON.stringify(after.device) !== JSON.stringify(active.baseline.device)) {
          evidenceReasons.push('DEVICE_IDENTITY_CHANGED');
        }
        if (JSON.stringify(after.runtime) !== JSON.stringify(active.baseline.runtime)) {
          evidenceReasons.push('RUNTIME_IDENTITY_CHANGED');
        }
      }

      if (evidenceReasons.length > 0 || !media.ok || !after || !bound) {
        return rejectCapture(active, evidenceReasons, false);
      }

      const storyboardBytes = JSON.stringify(active.context.storyboard);
      const receipt = mechanicallyAcceptedProofReceiptSchema.parse({
        schemaVersion: 1,
        runId: active.context.runId,
        issue: active.context.issue,
        pullRequest: active.context.pullRequest,
        proofClass: active.context.proofClass,
        acceptanceMappings: active.context.acceptanceMappings,
        git: {
          sourceTreeSha: active.context.storyboard.sourceTreeSha,
          proofHeadSha: git.sha,
          dirty: false,
        },
        device: after.device,
        runtime: after.runtime,
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
          afterSha256: after.errorSha256,
          beforeCount: active.baseline.errorCount,
          afterCount: after.errorCount,
          clean: true,
        },
        invalidationReasons: [],
        verdict: 'mechanically_accepted',
      });
      active.mechanicalReceipt = receipt;
      active.stage = 'mechanically_accepted';
      active.invalidationReasons = [];
      return okResult({ stage: active.stage, receipt });
    }

    if (args.action === 'finalize') {
      if (active.stage !== 'mechanically_accepted' || !active.mechanicalReceipt) {
        return proofFailure(['INVALID_PROOF_STAGE'], active.stage);
      }
      if (!contextIsCurrent(active)) return rejectPathDrift(active);
      let review: EvidenceReview;
      try {
        review = evidenceReviewSchema.parse(args.evidenceReview);
      } catch {
        return proofFailure(['EVIDENCE_REVIEW_INVALID'], active.stage);
      }
      if (
        review.provider === active.context.writerProvider ||
        review.provider === review.writerProvider ||
        review.writerProvider !== active.context.writerProvider
      ) {
        return proofFailure(['REVIEWER_NOT_INDEPENDENT'], active.stage);
      }
      const { verdict: _mechanicalVerdict, ...acceptedEvidence } = active.mechanicalReceipt;
      const finalReceipt = finalProofReceiptSchema.parse({
        ...acceptedEvidence,
        evidenceReview: review,
        verdict: 'accepted',
      });
      if (!contextIsCurrent(active)) return rejectPathDrift(active);
      try {
        deps.writeReceipt(active.context.receiptPath, finalReceipt);
      } catch {
        return proofFailure(['RECEIPT_WRITE_FAILED'], active.stage);
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
