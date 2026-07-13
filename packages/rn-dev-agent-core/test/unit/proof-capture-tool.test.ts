import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { StrictProofMonitor, type ProofObservation } from '../../dist/domain/proof-capture.js';
import {
  finalProofReceiptSchema,
  type EvidenceReview,
  type FinalProofReceipt,
} from '../../dist/domain/proof-receipt.js';
import {
  createProofCaptureHandler,
  proofCaptureInputSchema,
  writeProofReceiptAtomic,
  type ProofCaptureArgs,
  type ProofCaptureDeps,
  type ProofReadiness,
} from '../../dist/tools/proof-capture.js';
import type { MediaValidationResult } from '../../dist/tools/proof-media.js';
import type { MediaProcess, MediaValidationInput } from '../../dist/tools/proof-media.js';
import type { DeviceRecordArgs } from '../../dist/tools/device-record.js';
import { redact } from '../../dist/util/redact.js';
import { failResult, okResult, type ToolResult } from '../../dist/utils.js';

const CORE_ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_PATH = resolve(CORE_ROOT, 'schemas/proof-receipt.schema.json');
const SOURCE_SHA = 'a'.repeat(40);
const HASH = (value: string): string => createHash('sha256').update(value).digest('hex');
const ACTION_YAML_BYTES = `appId: dev.rnproof.fixture
---
# id: canonical-proof
# intent: Create a task through the proof fixture
# status: active
- tapOn:
    id: open-task-form
`;
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
};
const argsHash = (value: Record<string, unknown>): string =>
  HASH(JSON.stringify(stable(redact(value))));
const git = (root: string, args: string[]): string =>
  execFileSync('git', args[0] === 'commit' ? ['-c', 'commit.gpgSign=false', ...args] : args, {
    cwd: root,
    encoding: 'utf8',
  });

function actionRunArgs(): Record<string, unknown> {
  return {
    actionId: 'canonical-proof',
    autoRepair: false,
    forceReload: false,
    proofReplay: true,
  };
}

function operationArgs(index = 0): Record<string, unknown> {
  return [
    { interactiveOnly: true },
    { action: 'tap', testID: 'open-task-form' },
    { testID: 'task-title-input', text: 'Proof task' },
    { action: 'tap', testID: 'submit-task' },
  ][index]!;
}

function trustedActionIdentity(
  overrides: Partial<{ id: string; version: string; sha256: string }> = {},
): { id: string; version: string; sha256: string } {
  return { id: 'canonical-proof', version: '1', sha256: HASH(ACTION_YAML_BYTES), ...overrides };
}

function assertionArgs(
  step: {
    id: string;
    screenshotPath: string;
    verifyTestID: string;
    assertionWaitMs: number;
  },
  verifyTestID = step.verifyTestID,
): Record<string, unknown> {
  return { verifyTestID, screenshotPath: step.screenshotPath, waitMs: step.assertionWaitMs };
}

function envelope(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function reasons(result: ToolResult): string[] {
  const parsed = envelope(result);
  return ((parsed.meta as { reasons?: string[] } | undefined)?.reasons ?? []).slice();
}

function assertionResult(path: string, verified = true): ToolResult {
  return okResult({
    screenshotPath: path,
    verified,
    ...(verified ? {} : { errors: ['wrong state'] }),
  });
}

function resultHash(result: ToolResult): string {
  return HASH(JSON.stringify(result));
}

function baseReadiness(): ProofReadiness {
  return {
    cdpAttached: true,
    helpersAttached: true,
    metroReady: true,
    metroBuildPending: false,
    metroBuildFailed: false,
    metroEventsConnected: true,
    metroEventMarker: 'connection-1:event-0',
    errorCount: 0,
    errorSha256: HASH('clean-errors'),
    device: {
      id: 'SIM-1',
      platform: 'ios',
      model: 'iPhone 16 Pro',
      osVersion: '18.5',
    },
    runtime: {
      bundleId: 'dev.rnproof.fixture',
      metroPort: 8081,
      metroReady: true,
      pluginVersion: '0.69.0',
    },
  };
}

function beginArgs(
  projectRoot = '/tmp/proof-project',
): Extract<ProofCaptureArgs, { action: 'begin_rehearsal' }> {
  const proofRoot = join(projectRoot, 'docs', 'proof', 'run-42');
  return {
    action: 'begin_rehearsal',
    projectRoot,
    receiptPath: join(proofRoot, 'proof-receipt.json'),
    videoPath: join(proofRoot, 'proof.mp4'),
    contactSheetPath: join(proofRoot, 'proof-contact-sheet.jpg'),
    writerProvider: 'codex',
    runId: 'run-42',
    issue: { repository: 'Lykhoyda/rn-dev-agent', number: 42 },
    pullRequest: { number: 108, headSha: SOURCE_SHA },
    proofClass: 'feature',
    acceptanceMappings: [
      {
        criterion: 'Shows the exact task creation behavior',
        storyboardStepIds: ['start-state', 'open-form', 'fill-form', 'submit-form'],
      },
    ],
    fixture: { name: 'proof-fixture', version: '1' },
    proofAction: trustedActionIdentity(),
    storyboard: {
      schemaVersion: 1,
      id: 'strict-task-creation-flow',
      proofClass: 'feature',
      actionId: 'canonical-proof',
      sourceTreeSha: SOURCE_SHA,
      allowedTools: ['device_snapshot', 'cdp_interact', 'device_fill', 'proof_step'],
      steps: [
        {
          id: 'start-state',
          criterion: 'Start state is visible',
          expectedTool: 'device_snapshot',
          assertionTool: 'proof_step',
          expectedArgsSha256: argsHash(operationArgs(0)),
          assertionArgsSha256: argsHash({
            verifyTestID: 'task-list',
            screenshotPath: join(proofRoot, 'start-state.png'),
            waitMs: 0,
          }),
          verifyTestID: 'task-list',
          screenshotPath: join(proofRoot, 'start-state.png'),
          assertionWaitMs: 0,
          expectedDwellMs: 3_000,
          maximumDwellMs: 5_000,
        },
        {
          id: 'open-form',
          criterion: 'Task form opens',
          expectedTool: 'cdp_interact',
          assertionTool: 'proof_step',
          expectedArgsSha256: argsHash(operationArgs(1)),
          assertionArgsSha256: argsHash({
            verifyTestID: 'task-title-input',
            screenshotPath: join(proofRoot, 'open-form.png'),
            waitMs: 800,
          }),
          verifyTestID: 'task-title-input',
          screenshotPath: join(proofRoot, 'open-form.png'),
          assertionWaitMs: 800,
          expectedDwellMs: 3_000,
          maximumDwellMs: 5_000,
        },
        {
          id: 'fill-form',
          criterion: 'Task title is filled',
          expectedTool: 'device_fill',
          assertionTool: 'proof_step',
          expectedArgsSha256: argsHash(operationArgs(2)),
          assertionArgsSha256: argsHash({
            verifyTestID: 'submit-task',
            screenshotPath: join(proofRoot, 'fill-form.png'),
            waitMs: 300,
          }),
          verifyTestID: 'submit-task',
          screenshotPath: join(proofRoot, 'fill-form.png'),
          assertionWaitMs: 300,
          expectedDwellMs: 3_000,
          maximumDwellMs: 5_000,
        },
        {
          id: 'submit-form',
          criterion: 'Created task is visible',
          expectedTool: 'cdp_interact',
          assertionTool: 'proof_step',
          expectedArgsSha256: argsHash(operationArgs(3)),
          assertionArgsSha256: argsHash({
            verifyTestID: 'task-proof-task',
            screenshotPath: join(proofRoot, 'submit-form.png'),
            waitMs: 800,
          }),
          verifyTestID: 'task-proof-task',
          screenshotPath: join(proofRoot, 'submit-form.png'),
          assertionWaitMs: 800,
          expectedDwellMs: 3_000,
          maximumDwellMs: 5_000,
        },
      ],
    },
  };
}

interface Harness {
  handler: ReturnType<typeof createProofCaptureHandler>;
  monitor: StrictProofMonitor;
  clock: { value: number };
  readiness: ProofReadiness;
  git: { sha: string | null; dirty: boolean; changes: TestGitChange[] };
  recordCalls: DeviceRecordArgs[];
  removed: string[];
  written: FinalProofReceipt[];
  mediaCalls: Array<{ process: MediaProcess; input: MediaValidationInput }>;
  setRecord: (fn: (args: DeviceRecordArgs) => Promise<ToolResult>) => void;
  setMedia: (result: MediaValidationResult) => void;
  setMediaImpl: (
    fn: (process: MediaProcess, input: MediaValidationInput) => Promise<MediaValidationResult>,
  ) => void;
  setRemove: (fn: (path: string) => Promise<void>) => void;
  setWrite: (fn: (path: string, receipt: FinalProofReceipt) => void) => void;
  setGitInfo: (fn: () => { sha: string | null; dirty: boolean; changes: TestGitChange[] }) => void;
  setProofRootTracked: (value: boolean) => void;
  setReadiness: (fn: () => Promise<ProofReadiness>) => void;
  setActionIdentity: (value: { id: string; version: string; sha256: string } | null) => void;
  setActionIdentityReader: (
    fn: (actionId: string) => { id: string; version: string; sha256: string } | null,
  ) => void;
}

interface TestGitChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  sourcePath?: string;
}

function successfulMedia(args = beginArgs()): Extract<MediaValidationResult, { ok: true }> {
  const timestamps = [1_000, 5_000, 9_000, 13_000];
  return {
    ok: true,
    video: {
      path: args.videoPath,
      sha256: HASH('video'),
      durationMs: 16_000,
      sizeBytes: 4_096,
      codec: 'h264',
      width: 1_080,
      height: 1_920,
    },
    screenshots: args.storyboard.steps.map((step, index) => ({
      stepId: step.id,
      path: step.screenshotPath,
      timestampMs: timestamps[index]!,
      sha256: HASH(`screenshot-${step.id}`),
    })),
    frameMatches: args.storyboard.steps.map((step, index) => ({
      stepId: step.id,
      screenshotSha256: HASH(`screenshot-${step.id}`),
      videoTimestampMs: index === 0 ? 0 : timestamps[index]!,
      score: 0.96,
    })),
    contactSheet: { path: args.contactSheetPath, sha256: HASH('contact-sheet') },
  };
}

function createHarness(t: TestContext, expectedProjectRoot = '/tmp/proof-project'): Harness {
  const clock = { value: 1_800_000_000_000 };
  const monitor = new StrictProofMonitor(() => clock.value);
  const readiness = baseReadiness();
  const git = { sha: SOURCE_SHA as string | null, dirty: false, changes: [] as TestGitChange[] };
  const recordCalls: DeviceRecordArgs[] = [];
  const removed: string[] = [];
  const written: FinalProofReceipt[] = [];
  const mediaCalls: Array<{ process: MediaProcess; input: MediaValidationInput }> = [];
  const mediaProcess: MediaProcess = {
    run: async () => ({ stdout: '', stderr: '' }),
  };
  let mediaResult: MediaValidationResult = successfulMedia(beginArgs(expectedProjectRoot));
  let mediaImpl = async (): Promise<MediaValidationResult> => structuredClone(mediaResult);
  let removeImpl = async (): Promise<void> => undefined;
  let writeImpl = (path: string, receipt: FinalProofReceipt): void => {
    written.push(structuredClone(receipt));
    const repositoryPath = path.slice(expectedProjectRoot.length + 1);
    if (!git.changes.some((change) => change.path === repositoryPath)) {
      git.changes.push({ path: repositoryPath, indexStatus: '?', worktreeStatus: '?' });
      git.dirty = true;
    }
  };
  let gitImpl = (): { sha: string | null; dirty: boolean; changes: TestGitChange[] } => ({
    ...git,
    changes: structuredClone(git.changes),
  });
  let proofRootTracked = false;
  let actionIdentity: { id: string; version: string; sha256: string } | null =
    trustedActionIdentity();
  let actionIdentityReader = () => structuredClone(actionIdentity);
  let readinessImpl = async (): Promise<ProofReadiness> => structuredClone(readiness);
  let recordedOutput = beginArgs(expectedProjectRoot).videoPath;
  let recordImpl = async (args: DeviceRecordArgs): Promise<ToolResult> => {
    if (args.action === 'status') return okResult({ action: 'status', active: [] });
    if (args.action === 'start') {
      recordedOutput = args.outputPath ?? recordedOutput;
      return okResult({
        action: 'start',
        platform: args.platform,
        deviceId: args.deviceId,
        output: args.outputPath,
        pid: 99,
      });
    }
    return okResult({
      action: 'stop',
      saved: [{ path: recordedOutput, sizeBytes: 4_096 }],
    });
  };
  const schemaBytesPromise = readFile(SCHEMA_PATH, 'utf8');
  const deps: ProofCaptureDeps = {
    monitor,
    projectRoot: () => expectedProjectRoot,
    readActionIdentity: (actionId) => actionIdentityReader(actionId),
    getGitInfo: () => gitImpl(),
    proofRootTracked: () => proofRootTracked,
    readiness: () => readinessImpl(),
    record: async (args) => {
      recordCalls.push(structuredClone(args));
      return recordImpl(args);
    },
    mediaProcess,
    validateMedia: async (process, input) => {
      mediaCalls.push({ process, input: structuredClone(input) });
      return mediaImpl(process, input);
    },
    now: () => new Date(clock.value),
    writeReceipt: (path, receipt) => writeImpl(path, receipt),
    removeArtifact: async (path) => {
      removed.push(path);
      await removeImpl(path);
    },
    readContract: () => {
      throw new Error('use createContractHarness for the async file fixture');
    },
  };
  const harness: Harness = {
    handler: createProofCaptureHandler(deps),
    monitor,
    clock,
    readiness,
    git,
    recordCalls,
    removed,
    written,
    mediaCalls,
    setRecord: (fn) => {
      recordImpl = fn;
    },
    setMedia: (result) => {
      mediaResult = result;
    },
    setMediaImpl: (fn) => {
      mediaImpl = fn;
    },
    setRemove: (fn) => {
      removeImpl = fn;
    },
    setWrite: (fn) => {
      writeImpl = fn;
    },
    setGitInfo: (fn) => {
      gitImpl = fn;
    },
    setProofRootTracked: (value) => {
      proofRootTracked = value;
    },
    setReadiness: (fn) => {
      readinessImpl = fn;
    },
    setActionIdentity: (value) => {
      actionIdentity = value;
    },
    setActionIdentityReader: (fn) => {
      actionIdentityReader = fn;
    },
  };
  t.after(async () => {
    await schemaBytesPromise;
  });
  return harness;
}

function observe(
  harness: Harness,
  tool: string,
  atMs: number,
  result: ToolResult = okResult({ accepted: true }),
  params: Record<string, unknown> = {},
  status: 'PASS' | 'FAIL' = 'PASS',
): ProofObservation {
  harness.clock.value = atMs;
  harness.monitor.record({ tool, params, status, latencyMs: 5, result });
  return harness.monitor.observations().at(-1)!;
}

async function cleanRehearsal(
  harness: Harness,
  wrongAction = false,
  args = beginArgs(),
): Promise<void> {
  const started = harness.clock.value;
  assert.equal(envelope(await harness.handler(args)).ok, true);
  observe(
    harness,
    'cdp_run_action',
    started + 100,
    okResult({ replayed: true }),
    wrongAction ? { ...actionRunArgs(), actionId: 'unrelated-action' } : actionRunArgs(),
  );
  harness.clock.value = started + 16_000;
  const result = await harness.handler({ action: 'finish_rehearsal' });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
}

function observeFreshStart(
  harness: Harness,
  args = beginArgs(),
  result: ToolResult = assertionResult(args.storyboard.steps[0]!.screenshotPath),
): ProofObservation {
  return observe(
    harness,
    args.storyboard.steps[0]!.assertionTool,
    harness.clock.value + 100,
    result,
    assertionArgs(args.storyboard.steps[0]!),
  );
}

async function arm(harness: Harness, args = beginArgs()): Promise<void> {
  observeFreshStart(harness, args);
  const result = await harness.handler({ action: 'arm' });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
}

async function startRecording(harness: Harness, args = beginArgs()): Promise<number> {
  observeFreshStart(harness, args);
  const result = await harness.handler({ action: 'start_recording' });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
  return harness.clock.value;
}

function recordEvidence(
  harness: Harness,
  recordingStart: number,
  options: {
    order?: number[];
    failedStep?: number;
    extraTool?: string;
    timestampOverrides?: number[];
    resultPathOverrides?: Array<string | undefined>;
    operationArgsOverrides?: Array<Record<string, unknown> | undefined>;
    assertionArgsOverrides?: Array<Record<string, unknown> | undefined>;
  } = {},
  args = beginArgs(),
): Array<{
  stepId: string;
  screenshotPath: string;
  timestampMs: number;
  assertion: { stepId: string; tool: string; ok: true; resultHash: string };
}> {
  const timestamps = options.timestampOverrides ?? [1_000, 5_000, 9_000, 13_000];
  const evidence = args.storyboard.steps.map((step, index) => {
    const assertion = assertionResult(options.resultPathOverrides?.[index] ?? step.screenshotPath);
    return {
      stepId: step.id,
      screenshotPath: step.screenshotPath,
      timestampMs: timestamps[index]!,
      assertion: {
        stepId: step.id,
        tool: step.assertionTool,
        ok: true as const,
        resultHash: resultHash(assertion),
      },
      assertionResult: assertion,
    };
  });
  for (const index of options.order ?? args.storyboard.steps.map((_, index) => index)) {
    const step = args.storyboard.steps[index]!;
    const item = evidence[index]!;
    observe(
      harness,
      step.expectedTool,
      recordingStart + item.timestampMs - 100,
      okResult({ replayed: true }),
      options.operationArgsOverrides?.[index] ?? operationArgs(index),
    );
    observe(
      harness,
      step.assertionTool,
      recordingStart + item.timestampMs,
      item.assertionResult,
      options.assertionArgsOverrides?.[index] ?? assertionArgs(step),
      options.failedStep === index ? 'FAIL' : 'PASS',
    );
  }
  if (options.extraTool) {
    observe(harness, options.extraTool, recordingStart + 9_500, okResult({ done: true }));
  }
  return evidence.map(({ assertionResult: _ignored, ...item }) => item);
}

function markProofOutputs(harness: Harness, args = beginArgs()): void {
  harness.git.dirty = true;
  harness.git.changes = [
    args.videoPath,
    args.contactSheetPath,
    ...args.storyboard.steps.map((step) => step.screenshotPath),
  ].map((path) => ({
    path: path.slice(args.projectRoot.length + 1),
    indexStatus: '?',
    worktreeStatus: '?',
  }));
}

async function stoppedCapture(
  harness: Harness,
  options?: Parameters<typeof recordEvidence>[2],
  args = beginArgs(),
): Promise<ReturnType<typeof recordEvidence>> {
  await cleanRehearsal(harness, false, args);
  await arm(harness, args);
  const recordingStart = await startRecording(harness, args);
  const evidence = recordEvidence(harness, recordingStart, options, args);
  const stopped = await harness.handler({ action: 'stop_recording' });
  assert.equal(envelope(stopped).ok, true, stopped.content[0]!.text);
  markProofOutputs(harness, args);
  return evidence;
}

function validReview(overrides: Partial<EvidenceReview> = {}): EvidenceReview {
  return {
    provider: 'claude-fable',
    writerProvider: 'codex',
    independent: true,
    exactFeature: true,
    irrelevantScreens: false,
    debuggingFriction: false,
    personalData: false,
    resultHash: HASH('vision-review'),
    ...overrides,
  };
}

test('strict action schemas reject unknown and cross-action fields', () => {
  assert.equal(proofCaptureInputSchema.safeParse({ action: 'status', extra: true }).success, false);
  assert.equal(
    proofCaptureInputSchema.safeParse({ action: 'arm', videoPath: '/tmp/not-allowed.mp4' }).success,
    false,
  );
  assert.equal(
    proofCaptureInputSchema.safeParse({ action: 'contract', projectRoot: '/tmp/untrusted' })
      .success,
    false,
  );
  assert.equal(proofCaptureInputSchema.safeParse(beginArgs()).success, true);
});

test('trackedTool preserves raw-shape registration and uses full-schema registration for proof', async () => {
  const source = await readFile(resolve(CORE_ROOT, 'src/index.ts'), 'utf8');
  const start = source.indexOf('function trackedTool(');
  const end = source.indexOf('\n}\n\ntrackedTool(', start) + 2;
  const trackedToolSource = source.slice(start, end);
  assert.match(trackedToolSource, /schema instanceof z\.ZodType/);
  assert.match(trackedToolSource, /server\.tool\(/);
  assert.match(trackedToolSource, /server\.registerTool\(/);
  assert.match(source, /proofCaptureInputSchema,\s*proofCaptureHandler/);
});

test('begin rejects root and artifact path attacks before monitor, recording, or file IO', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (args: ReturnType<typeof beginArgs>) => void;
  }> = [
    {
      name: 'root mismatch',
      mutate: (args) => {
        args.projectRoot = '/tmp/other-project';
      },
    },
    { name: 'outside root', mutate: (args) => void (args.videoPath = '/tmp/outside.mp4') },
    {
      name: 'non-normalized path',
      mutate: (args) => void (args.videoPath = `${args.projectRoot}/nested/../proof.mp4`),
    },
    {
      name: 'wrong video extension',
      mutate: (args) => void (args.videoPath = join(args.projectRoot, 'proof.mov')),
    },
    {
      name: 'wrong contact extension',
      mutate: (args) => void (args.contactSheetPath = join(args.projectRoot, 'contact.png')),
    },
    {
      name: 'wrong screenshot extension',
      mutate: (args) =>
        void (args.storyboard.steps[1]!.screenshotPath = join(args.projectRoot, 'two.txt')),
    },
    {
      name: 'wrong receipt name',
      mutate: (args) => void (args.receiptPath = join(args.projectRoot, 'accepted.json')),
    },
    {
      name: 'duplicate destinations',
      mutate: (args) =>
        void (args.storyboard.steps[1]!.screenshotPath = args.storyboard.steps[0]!.screenshotPath),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      const args = beginArgs();
      scenario.mutate(args);
      const result = await harness.handler(args);
      assert.ok(reasons(result).includes('INVALID_PROOF_CONTEXT'), result.content[0]!.text);
      harness.monitor.record({
        tool: 'proof_step',
        params: {},
        status: 'PASS',
        latencyMs: 1,
        result: assertionResult('/tmp/untrusted.png'),
      });
      assert.deepEqual(harness.monitor.snapshot(), []);
      assert.deepEqual(harness.recordCalls, []);
      assert.deepEqual(harness.removed, []);
      assert.deepEqual(harness.written, []);
    });
  }
});

test('begin accepts normalized distinct descendants of the injected project root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = createHarness(t, root);
  const result = await harness.handler(beginArgs(root));
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
  assert.equal(
    (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
    'rehearsing',
  );
});

test('begin binds each declared assertion wait to its canonical argument hash', async (t) => {
  const harness = createHarness(t);
  const args = beginArgs();
  args.storyboard.steps[1]!.assertionWaitMs = 801;

  const result = await harness.handler(args);

  assert.ok(reasons(result).includes('INVALID_PROOF_CONTEXT'), result.content[0]!.text);
  assert.deepEqual(harness.recordCalls, []);
});

test('begin refuses an existing symlink parent below the project root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-symlink-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'strict-proof-outside-'));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  await mkdir(join(root, 'proof'), { recursive: true });
  await symlink(outside, join(root, 'proof', 'linked'));
  const harness = createHarness(t, root);
  const args = beginArgs(root);
  args.videoPath = join(root, 'proof', 'linked', 'proof.mp4');

  const result = await harness.handler(args);

  assert.ok(reasons(result).includes('INVALID_PROOF_CONTEXT'), result.content[0]!.text);
  assert.deepEqual(harness.recordCalls, []);
  assert.deepEqual(harness.removed, []);
});

test('canonical nested fixture resolves proof ownership to the Git worktree root', async () => {
  const module = await import('../../dist/tools/proof-capture.js');
  assert.equal(typeof module.resolveProofWorktreeRoot, 'function');
  const repositoryRoot = resolve(CORE_ROOT, '../..');
  const fixtureRoot = join(repositoryRoot, 'apps/proof-fixture');
  assert.equal(module.resolveProofWorktreeRoot(fixtureRoot), repositoryRoot);
  assert.ok(join(repositoryRoot, 'docs/proof/strict-factory-proof').startsWith(repositoryRoot));
});

test('later symlink swaps are rejected at every filesystem boundary', async (t) => {
  const makeRoots = async (st: TestContext) => {
    const root = await mkdtemp(join(tmpdir(), 'strict-proof-race-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'strict-proof-race-outside-'));
    st.after(() =>
      Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]),
    );
    return { root, outside };
  };

  await t.test('before recording start', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const proofRoot = dirname(args.receiptPath);
    args.videoPath = join(proofRoot, 'late-video', 'proof.mp4');
    await cleanRehearsal(harness, false, args);
    await arm(harness, args);
    await mkdir(proofRoot, { recursive: true });
    await symlink(outside, join(proofRoot, 'late-video'));

    const result = await harness.handler({ action: 'start_recording' });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
    assert.deepEqual(harness.removed, []);
  });

  await t.test('during pre-record cleanup', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const proofRoot = dirname(args.receiptPath);
    const videoDirectory = join(proofRoot, 'late-cleanup');
    args.videoPath = join(videoDirectory, 'proof.mp4');
    await cleanRehearsal(harness, false, args);
    await arm(harness, args);
    let removalCount = 0;
    harness.setRemove(async () => {
      removalCount += 1;
      if (removalCount === 1) {
        await mkdir(proofRoot, { recursive: true });
        await symlink(outside, videoDirectory);
      }
    });
    observeFreshStart(harness, args);

    const result = await harness.handler({ action: 'start_recording' });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.equal(harness.removed.includes(args.videoPath), false);
    assert.deepEqual(harness.recordCalls, []);
  });

  await t.test('before non-recording discard', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const proofRoot = dirname(args.receiptPath);
    args.videoPath = join(proofRoot, 'late-discard', 'proof.mp4');
    assert.equal(envelope(await harness.handler(args)).ok, true);
    await mkdir(proofRoot, { recursive: true });
    await symlink(outside, join(proofRoot, 'late-discard'));

    const result = await harness.handler({ action: 'discard' });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
    assert.deepEqual(harness.removed, []);
  });

  await t.test(
    'active discard stops the owned recorder but touches no artifact path',
    async (st) => {
      const { root, outside } = await makeRoots(st);
      const harness = createHarness(st, root);
      const args = beginArgs(root);
      const videoDirectory = join(dirname(args.receiptPath), 'active-video');
      args.videoPath = join(videoDirectory, 'proof.mp4');
      await cleanRehearsal(harness, false, args);
      await arm(harness, args);
      await startRecording(harness, args);
      const removalsBeforeDrift = harness.removed.length;
      await mkdir(videoDirectory, { recursive: true });
      await rm(videoDirectory, { recursive: true, force: true });
      await symlink(outside, videoDirectory);
      const callsBefore = harness.recordCalls.length;

      const result = await harness.handler({ action: 'discard' });

      assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
      assert.deepEqual(
        harness.recordCalls.slice(callsBefore).map((call) => call.action),
        ['stop', 'status'],
      );
      assert.deepEqual(harness.removed.slice(removalsBeforeDrift), []);
    },
  );

  await t.test('before media validation', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const proofRoot = dirname(args.receiptPath);
    args.contactSheetPath = join(proofRoot, 'late-media', 'contact-sheet.jpg');
    harness.setMedia(successfulMedia(args));
    await stoppedCapture(harness, undefined, args);
    const removalsBeforeDrift = harness.removed.length;
    await mkdir(proofRoot, { recursive: true });
    await symlink(outside, join(proofRoot, 'late-media'));

    const result = await harness.handler({ action: 'validate' });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.equal(harness.mediaCalls.length, 0);
    assert.deepEqual(harness.removed.slice(removalsBeforeDrift), []);
  });

  await t.test('before final receipt write', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const receiptDirectory = join(dirname(args.receiptPath), 'late-receipt');
    args.receiptPath = join(receiptDirectory, 'proof-receipt.json');
    await stoppedCapture(harness, undefined, args);
    assert.equal(envelope(await harness.handler({ action: 'validate' })).ok, true);
    const removalsBeforeDrift = harness.removed.length;
    await mkdir(receiptDirectory, { recursive: true });
    await rm(receiptDirectory, { recursive: true, force: true });
    await symlink(outside, receiptDirectory);
    const recordCalls = harness.recordCalls.length;
    const mediaCalls = harness.mediaCalls.length;

    const result = await harness.handler({ action: 'finalize', evidenceReview: validReview() });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.equal(harness.recordCalls.length, recordCalls);
    assert.equal(harness.mediaCalls.length, mediaCalls);
    assert.deepEqual(harness.removed.slice(removalsBeforeDrift), []);
    assert.deepEqual(harness.written, []);
  });
});

test('contract is sessionless and returns the exact package schema bytes and digest', async () => {
  const bytes = await readFile(SCHEMA_PATH, 'utf8');
  const monitor = new StrictProofMonitor();
  const handler = createProofCaptureHandler({
    monitor,
    projectRoot: () => {
      throw new Error('contract must not resolve a project');
    },
    readActionIdentity: () => {
      throw new Error('contract must not read an action');
    },
    getGitInfo: () => {
      throw new Error('contract must not read Git');
    },
    readiness: async () => {
      throw new Error('contract must not inspect a device');
    },
    record: async () => {
      throw new Error('contract must not record');
    },
    validateMedia: async () => {
      throw new Error('contract must not validate media');
    },
    mediaProcess: { run: async () => ({ stdout: '', stderr: '' }) },
    now: () => new Date(0),
    writeReceipt: () => {
      throw new Error('contract must not write');
    },
    removeArtifact: () => {
      throw new Error('contract must not remove');
    },
    readContract: () => ({ schema: JSON.parse(bytes), bytes, sha256: HASH(bytes) }),
  });

  const result = envelope(await handler({ action: 'contract' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { schema: JSON.parse(bytes), sha256: HASH(bytes) });
});

test('recording cannot start before a clean rehearsal and arm', async (t) => {
  const harness = createHarness(t);
  const result = await harness.handler({ action: 'start_recording' });
  assert.equal(envelope(result).ok, false);
  assert.deepEqual(reasons(result), ['INVALID_PROOF_STAGE']);
  assert.equal(harness.recordCalls.length, 0);
});

test('arm refuses every untrusted readiness condition and a wrong observed start assertion', async (t) => {
  const cases: Array<{
    name: string;
    expected: string;
    mutate: (harness: Harness) => void;
    wrongAssertion?: boolean;
  }> = [
    {
      name: 'dirty Git',
      expected: 'GIT_DIRTY',
      mutate: (h) =>
        void h.git.changes.push({
          path: 'packages/core/src/index.ts',
          indexStatus: '?',
          worktreeStatus: '?',
        }),
    },
    {
      name: 'wrong source SHA',
      expected: 'SOURCE_SHA_MISMATCH',
      mutate: (h) => void (h.git.sha = 'b'.repeat(40)),
    },
    {
      name: 'detached CDP',
      expected: 'CDP_DETACHED',
      mutate: (h) => void (h.readiness.cdpAttached = false),
    },
    {
      name: 'detached helpers',
      expected: 'HELPERS_DETACHED',
      mutate: (h) => void (h.readiness.helpersAttached = false),
    },
    {
      name: 'Metro not ready',
      expected: 'METRO_NOT_READY',
      mutate: (h) => void (h.readiness.metroReady = false),
    },
    {
      name: 'pending Metro build',
      expected: 'METRO_BUILD_PENDING',
      mutate: (h) => void (h.readiness.metroBuildPending = true),
    },
    {
      name: 'failed Metro build',
      expected: 'METRO_BUILD_FAILED',
      mutate: (h) => void (h.readiness.metroBuildFailed = true),
    },
    {
      name: 'dirty error baseline',
      expected: 'ERROR_BASELINE_DIRTY',
      mutate: (h) => void (h.readiness.errorCount = 1),
    },
    {
      name: 'wrong start assertion',
      expected: 'START_ASSERTION_FAILED',
      mutate: () => undefined,
      wrongAssertion: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      await cleanRehearsal(harness);
      observeFreshStart(
        harness,
        beginArgs(),
        assertionResult(beginArgs().storyboard.steps[0]!.screenshotPath, !scenario.wrongAssertion),
      );
      scenario.mutate(harness);
      const result = await harness.handler({ action: 'arm' });
      assert.equal(envelope(result).ok, false);
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(
        (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
        'rehearsed',
      );
    });
  }
});

test('start refuses a pre-existing recording without claiming or stopping it', async (t) => {
  const harness = createHarness(t);
  await cleanRehearsal(harness);
  await arm(harness);
  harness.setRecord(async (args) =>
    args.action === 'status'
      ? okResult({ active: [{ platform: 'ios', deviceId: 'OTHER', output: '/tmp/other.mp4' }] })
      : failResult('must not be called'),
  );
  observeFreshStart(harness);

  const result = await harness.handler({ action: 'start_recording' });
  assert.deepEqual(reasons(result), ['RECORDING_ALREADY_ACTIVE']);
  assert.deepEqual(
    harness.recordCalls.map((call) => call.action),
    ['status'],
  );
  assert.equal(
    (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
    'armed',
  );
});

test('a thrown recording status probe fails closed without attempting start', async (t) => {
  const harness = createHarness(t);
  await cleanRehearsal(harness);
  await arm(harness);
  harness.setRecord(async () => {
    throw new Error('status transport failed');
  });
  observeFreshStart(harness);

  const result = await harness.handler({ action: 'start_recording' });
  assert.deepEqual(reasons(result), ['RECORDING_STATUS_FAILED']);
  assert.deepEqual(
    harness.recordCalls.map((call) => call.action),
    ['status'],
  );
});

test('wrong recording device or output path is discarded and starts a fresh rehearsal', async (t) => {
  for (const mismatch of ['device', 'path'] as const) {
    await t.test(mismatch, async (st) => {
      const harness = createHarness(st);
      await cleanRehearsal(harness);
      await arm(harness);
      harness.setRecord(async (args) => {
        if (args.action === 'status') return okResult({ active: [] });
        if (args.action === 'start') {
          return okResult({
            deviceId: mismatch === 'device' ? 'OTHER' : args.deviceId,
            output: mismatch === 'path' ? '/tmp/wrong.mp4' : args.outputPath,
          });
        }
        return okResult({ saved: [] });
      });
      observeFreshStart(harness);
      const result = await harness.handler({ action: 'start_recording' });
      assert.ok(
        reasons(result).includes(
          mismatch === 'device' ? 'RECORDING_DEVICE_MISMATCH' : 'RECORDING_PATH_MISMATCH',
        ),
      );
      assert.ok(harness.recordCalls.some((call) => call.action === 'stop'));
      assert.ok(harness.removed.includes(beginArgs().videoPath));
      assert.equal(
        (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
        'rehearsing',
      );
    });
  }
});

test('record start and stop failures discard the clip and restart rehearsal', async (t) => {
  for (const phase of ['start', 'stop'] as const) {
    await t.test(phase, async (st) => {
      const harness = createHarness(st);
      await cleanRehearsal(harness);
      await arm(harness);
      harness.setRecord(async (args) => {
        if (args.action === 'status') return okResult({ active: [] });
        if (args.action === phase) return failResult(`${phase} failed`);
        if (args.action === 'start')
          return okResult({ deviceId: 'SIM-1', output: beginArgs().videoPath });
        return okResult({ saved: [] });
      });
      if (phase === 'stop') {
        const recordingStart = await startRecording(harness);
        recordEvidence(harness, recordingStart);
      } else {
        observeFreshStart(harness);
      }
      const result = await harness.handler({
        action: phase === 'start' ? 'start_recording' : 'stop_recording',
      });
      assert.ok(
        reasons(result).includes(
          phase === 'start' ? 'RECORDING_START_FAILED' : 'RECORDING_STOP_FAILED',
        ),
      );
      assert.ok(harness.removed.includes(beginArgs().videoPath));
      assert.equal(
        (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
        'rehearsing',
      );
    });
  }
});

test('recorded evidence timestamps include recorder startup latency', async (t) => {
  const harness = createHarness(t);
  await cleanRehearsal(harness);
  await arm(harness);
  harness.setRecord(async (args) => {
    if (args.action === 'status') return okResult({ active: [] });
    if (args.action === 'start') {
      harness.clock.value += 8_000;
      return okResult({ deviceId: 'SIM-1', output: beginArgs().videoPath });
    }
    return okResult({ saved: [{ path: beginArgs().videoPath, sizeBytes: 4_096 }] });
  });

  const operationsStartedAt = await startRecording(harness);
  recordEvidence(harness, operationsStartedAt);
  const result = await harness.handler({ action: 'stop_recording' });
  const evidence = (envelope(result).data as { evidenceDraft: Array<{ timestampMs: number }> })
    .evidenceDraft;

  assert.equal(evidence[0]!.timestampMs, 9_000);
});

test('trace repair, reload, failed tools, and wrong order fail closed', async (t) => {
  const cases = [
    {
      name: 'repair',
      options: { extraTool: 'cdp_repair_action' },
      expected: 'ACTION_REPAIR_DURING_RECORDING',
    },
    { name: 'reload', options: { extraTool: 'cdp_reload' }, expected: 'RELOAD_DURING_RECORDING' },
    { name: 'failed', options: { failedStep: 1 }, expected: 'OBSERVED_TOOL_FAILED' },
    {
      name: 'wrong order',
      options: { order: [1, 0, 2, 3] },
      expected: 'STORYBOARD_ORDER_VIOLATION',
    },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      const args = beginArgs();
      if (scenario.name === 'wrong order') {
        args.storyboard.allowedTools = [
          'cdp_action_one',
          'cdp_action_two',
          'cdp_action_three',
          'cdp_action_four',
          'proof_step',
        ];
        args.storyboard.steps.forEach((step, index) => {
          step.expectedTool = `cdp_action_${['one', 'two', 'three', 'four'][index]}`;
        });
      }
      await stoppedCapture(harness, scenario.options, args);
      const result = await harness.handler({ action: 'validate' });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
      assert.ok(harness.removed.includes(args.videoPath));
    });
  }
});

test('result-bound screenshot evidence rejects a missing or different successful result path', async (t) => {
  for (const [name, resultPath] of [
    ['missing', ''],
    ['different', '/tmp/other-state.png'],
  ] as const) {
    await t.test(name, async (st) => {
      const harness = createHarness(st);
      await stoppedCapture(harness, {
        resultPathOverrides: [undefined, resultPath, undefined],
      });
      const result = await harness.handler({ action: 'validate' });
      assert.ok(reasons(result).includes('SCREENSHOT_PATH_MISMATCH'), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('stop accepts exactly one saved clip matching the armed output path', async (t) => {
  const cases = [
    { name: 'zero', saved: [], expected: 'RECORDING_AMBIGUOUS' },
    {
      name: 'multiple',
      saved: [
        { path: beginArgs().videoPath, sizeBytes: 1 },
        { path: '/tmp/other.mp4', sizeBytes: 1 },
      ],
      expected: 'RECORDING_AMBIGUOUS',
    },
    {
      name: 'wrong path',
      saved: [{ path: '/tmp/other.mp4', sizeBytes: 1 }],
      expected: 'RECORDING_PATH_MISMATCH',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      await cleanRehearsal(harness);
      await arm(harness);
      const start = await startRecording(harness);
      recordEvidence(harness, start);
      harness.setRecord(async (args) =>
        args.action === 'stop'
          ? okResult({ action: 'stop', saved: scenario.saved })
          : okResult({ active: [] }),
      );
      const result = await harness.handler({ action: 'stop_recording' });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.ok(harness.removed.includes(beginArgs().videoPath));
    });
  }
});

test('screenshot timestamp and per-state dwell constraints are enforced', async (t) => {
  const cases = [
    {
      name: 'not increasing',
      timestamps: [1_000, 1_000, 9_000, 13_000],
      expected: 'SCREENSHOT_TIMESTAMPS_INVALID',
    },
    {
      name: 'outside video',
      timestamps: [1_000, 5_000, 9_000, 16_001],
      expected: 'SCREENSHOT_TIMESTAMPS_INVALID',
    },
    {
      name: 'dwell below',
      timestamps: [1_000, 3_000, 9_000, 13_000],
      expected: 'STEP_DWELL_OUT_OF_BOUNDS',
    },
    {
      name: 'dwell above',
      timestamps: [1_000, 7_000, 9_000, 13_000],
      expected: 'STEP_DWELL_OUT_OF_BOUNDS',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      await stoppedCapture(harness, { timestampOverrides: scenario.timestamps });
      const media = successfulMedia();
      media.video.durationMs = 16_000;
      media.screenshots.forEach(
        (shot, index) => void (shot.timestampMs = scenario.timestamps[index]!),
      );
      harness.setMedia(media);
      const result = await harness.handler({ action: 'validate' });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('media, post-readiness, and final-state failures write no final receipt', async (t) => {
  const cases: Array<{
    name: string;
    expected: string;
    mutate: (h: Harness) => void;
  }> = [
    {
      name: 'media',
      expected: 'FRAME_MISMATCH',
      mutate: (h) => h.setMedia({ ok: false, reasons: ['FRAME_MISMATCH'] }),
    },
    {
      name: 'error baseline',
      expected: 'ERROR_BASELINE_CHANGED',
      mutate: (h) => void (h.readiness.errorCount = 1),
    },
    {
      name: 'device identity',
      expected: 'DEVICE_IDENTITY_CHANGED',
      mutate: (h) => void (h.readiness.device.id = 'OTHER'),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      await stoppedCapture(harness);
      scenario.mutate(harness);
      const result = await harness.handler({ action: 'validate' });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
  await t.test('final state', async (st) => {
    const harness = createHarness(st);
    await stoppedCapture(harness, { failedStep: 3 });
    const result = await harness.handler({ action: 'validate' });
    assert.ok(reasons(result).includes('FINAL_ASSERTION_FAILED'), result.content[0]!.text);
    assert.equal(harness.written.length, 0);
  });
});

test('validate invokes Task 4 with the injected process and bound capture input', async (t) => {
  const harness = createHarness(t);
  const evidence = await stoppedCapture(harness);
  const result = await harness.handler({ action: 'validate' });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
  assert.equal(harness.mediaCalls.length, 1);
  assert.equal(typeof harness.mediaCalls[0]!.process.run, 'function');
  assert.deepEqual(harness.mediaCalls[0]!.input, {
    videoPath: beginArgs().videoPath,
    rehearsalDurationMs: 16_000,
    screenshots: evidence.map((item) => ({
      stepId: item.stepId,
      path: item.screenshotPath,
      timestampMs: item.timestampMs,
    })),
    contactSheetPath: beginArgs().contactSheetPath,
  });
});

test('validate rechecks Git, CDP, helpers, and Metro after recording', async (t) => {
  const cases: Array<{ name: string; expected: string; mutate: (h: Harness) => void }> = [
    {
      name: 'dirty Git',
      expected: 'GIT_DIRTY',
      mutate: (h) =>
        void h.git.changes.push({
          path: 'packages/core/src/index.ts',
          indexStatus: '?',
          worktreeStatus: '?',
        }),
    },
    {
      name: 'source changed',
      expected: 'SOURCE_SHA_MISMATCH',
      mutate: (h) => void (h.git.sha = 'c'.repeat(40)),
    },
    {
      name: 'CDP detached',
      expected: 'CDP_DETACHED',
      mutate: (h) => void (h.readiness.cdpAttached = false),
    },
    {
      name: 'helpers detached',
      expected: 'HELPERS_DETACHED',
      mutate: (h) => void (h.readiness.helpersAttached = false),
    },
    {
      name: 'Metro pending',
      expected: 'METRO_BUILD_PENDING',
      mutate: (h) => void (h.readiness.metroBuildPending = true),
    },
    {
      name: 'Metro failed',
      expected: 'METRO_BUILD_FAILED',
      mutate: (h) => void (h.readiness.metroBuildFailed = true),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      await stoppedCapture(harness);
      scenario.mutate(harness);
      const result = await harness.handler({ action: 'validate' });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('finalize rejects the writer as reviewer and every invalid vision boolean', async (t) => {
  const cases: Array<{ name: string; review: EvidenceReview; expected: string }> = [
    {
      name: 'same provider',
      review: validReview({ provider: 'codex' }),
      expected: 'REVIEWER_NOT_INDEPENDENT',
    },
    {
      name: 'spoofed writer',
      review: validReview({ writerProvider: 'other-writer' }),
      expected: 'REVIEWER_NOT_INDEPENDENT',
    },
    {
      name: 'not independent',
      review: { ...validReview(), independent: false } as EvidenceReview,
      expected: 'EVIDENCE_REVIEW_INVALID',
    },
    {
      name: 'wrong feature',
      review: { ...validReview(), exactFeature: false } as EvidenceReview,
      expected: 'EVIDENCE_REVIEW_INVALID',
    },
    {
      name: 'irrelevant screens',
      review: { ...validReview(), irrelevantScreens: true } as EvidenceReview,
      expected: 'EVIDENCE_REVIEW_INVALID',
    },
    {
      name: 'debug friction',
      review: { ...validReview(), debuggingFriction: true } as EvidenceReview,
      expected: 'EVIDENCE_REVIEW_INVALID',
    },
    {
      name: 'personal data',
      review: { ...validReview(), personalData: true } as EvidenceReview,
      expected: 'EVIDENCE_REVIEW_INVALID',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      await stoppedCapture(harness);
      assert.equal(envelope(await harness.handler({ action: 'validate' })).ok, true);
      const result = await harness.handler({ action: 'finalize', evidenceReview: scenario.review });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('accepted receipt is strict, uses real observed hashes, and is written exactly once', async (t) => {
  const harness = createHarness(t);
  const evidence = await stoppedCapture(harness);
  const validation = await harness.handler({ action: 'validate' });
  assert.equal(envelope(validation).ok, true, validation.content[0]!.text);

  const finalized = await harness.handler({ action: 'finalize', evidenceReview: validReview() });
  assert.equal(envelope(finalized).ok, true, finalized.content[0]!.text);
  assert.equal(harness.written.length, 1);
  const receipt = finalProofReceiptSchema.parse(harness.written[0]);
  assert.equal(receipt.verdict, 'accepted');
  assert.equal(receipt.assertions[0]!.resultHash, evidence[0]!.assertion.resultHash);
  assert.equal(receipt.storyboard.sha256, HASH(JSON.stringify(beginArgs().storyboard)));
  assert.equal(receipt.video.sha256, HASH('video'));
  const committedSchema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as object;
  const validateSchema = new Ajv({ strict: false }).compile(committedSchema);
  assert.equal(validateSchema(receipt), true, JSON.stringify(validateSchema.errors));

  const second = await harness.handler({ action: 'finalize', evidenceReview: validReview() });
  assert.equal(envelope(second).ok, false);
  assert.equal(harness.written.length, 1);
});

test('finalize requires the receipt to be the only additional owned Git output', async (t) => {
  const harness = createHarness(t);
  const args = beginArgs();
  await stoppedCapture(harness, undefined, args);
  assert.equal(envelope(await harness.handler({ action: 'validate' })).ok, true);
  harness.setWrite((path) => {
    harness.git.dirty = true;
    harness.git.changes.push(
      {
        path: path.slice(args.projectRoot.length + 1),
        indexStatus: '?',
        worktreeStatus: '?',
      },
      {
        path: 'unrelated-after-receipt.txt',
        indexStatus: '?',
        worktreeStatus: '?',
      },
    );
  });

  const result = await harness.handler({ action: 'finalize', evidenceReview: validReview() });

  assert.ok(reasons(result).includes('GIT_DIRTY'), result.content[0]!.text);
  assert.ok(harness.removed.includes(args.receiptPath));
});

test('production receipt writer atomically persists accepted JSON with mode 0600', async (t) => {
  const harness = createHarness(t);
  await stoppedCapture(harness);
  assert.equal(envelope(await harness.handler({ action: 'validate' })).ok, true);
  assert.equal(
    envelope(await harness.handler({ action: 'finalize', evidenceReview: validReview() })).ok,
    true,
  );
  const receipt = harness.written[0]!;
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'proof-receipt.json');

  writeProofReceiptAtomic(path, receipt);

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), receipt);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('status, discard, and separate handler instances keep session ownership isolated', async (t) => {
  const first = createHarness(t);
  const second = createHarness(t);
  await cleanRehearsal(first);
  await arm(first);
  await startRecording(first);

  assert.equal(
    (envelope(await first.handler({ action: 'status' })).data as { stage: string }).stage,
    'recording',
  );
  assert.equal(
    (envelope(await second.handler({ action: 'status' })).data as { stage: string }).stage,
    'idle',
  );
  const discarded = await first.handler({ action: 'discard' });
  assert.equal(envelope(discarded).ok, true);
  assert.ok(first.recordCalls.some((call) => call.action === 'stop'));
  assert.ok(first.removed.includes(beginArgs().videoPath));
  assert.equal(
    (envelope(await first.handler({ action: 'status' })).data as { stage: string }).stage,
    'idle',
  );
});

test('rehearsal accepts exactly one clean pinned learned-action replay', async (t) => {
  for (const scenario of [
    'wrong action',
    'writable mode',
    'failed action',
    'extra activity',
    'extra replay',
  ] as const) {
    await t.test(scenario, async (st) => {
      const harness = createHarness(st);
      const args = beginArgs();
      const started = harness.clock.value;
      assert.equal(envelope(await harness.handler(args)).ok, true);
      observe(
        harness,
        'cdp_run_action',
        started + 100,
        okResult({ replayed: true }),
        scenario === 'wrong action'
          ? { ...actionRunArgs(), actionId: 'unrelated-action' }
          : scenario === 'writable mode'
            ? { actionId: 'canonical-proof', autoRepair: false, forceReload: false }
            : actionRunArgs(),
        scenario === 'failed action' ? 'FAIL' : 'PASS',
      );
      if (scenario === 'extra activity') {
        observe(harness, 'device_press', started + 200, okResult({ pressed: true }));
      } else if (scenario === 'extra replay') {
        observe(
          harness,
          'cdp_run_action',
          started + 200,
          okResult({ replayed: true }),
          actionRunArgs(),
        );
      }
      harness.clock.value = started + 16_000;

      const result = await harness.handler({ action: 'finish_rehearsal' });

      assert.ok(
        reasons(result).includes(
          scenario === 'wrong action' || scenario === 'writable mode'
            ? 'ACTION_ARGUMENT_MISMATCH'
            : scenario === 'failed action'
              ? 'OBSERVED_TOOL_FAILED'
              : scenario === 'extra activity'
                ? 'UNDECLARED_MUTATING_TOOL'
                : 'ACTION_REHEARSAL_SEQUENCE_INVALID',
        ),
        result.content[0]!.text,
      );
    });
  }
});

test('trusted action identity rejects caller fiction and drift at every authority boundary', async (t) => {
  for (const scenario of ['missing', 'wrong hash', 'wrong revision'] as const) {
    await t.test(`begin: ${scenario}`, async (st) => {
      const harness = createHarness(st);
      const args = beginArgs();
      if (scenario === 'missing') harness.setActionIdentity(null);
      if (scenario === 'wrong hash') args.proofAction.sha256 = HASH('caller-fiction');
      if (scenario === 'wrong revision') args.proofAction.version = '999';

      const result = await harness.handler(args);

      assert.ok(
        reasons(result).includes(
          scenario === 'missing' ? 'PROOF_ACTION_MISSING' : 'PROOF_ACTION_IDENTITY_MISMATCH',
        ),
        result.content[0]!.text,
      );
    });
  }

  for (const phase of ['arm', 'start', 'validate'] as const) {
    await t.test(`mutation before ${phase}`, async (st) => {
      const harness = createHarness(st);
      const args = beginArgs();
      if (phase === 'arm') {
        await cleanRehearsal(harness, false, args);
        observeFreshStart(harness, args);
      } else if (phase === 'start') {
        await cleanRehearsal(harness, false, args);
        await arm(harness, args);
        observeFreshStart(harness, args);
      } else {
        await stoppedCapture(harness, undefined, args);
      }
      harness.setActionIdentity(trustedActionIdentity({ sha256: HASH('mutated-yaml') }));

      const result = await harness.handler({
        action: phase === 'start' ? 'start_recording' : phase,
      });

      assert.ok(reasons(result).includes('PROOF_ACTION_IDENTITY_CHANGED'), result.content[0]!.text);
    });
  }
});

test('live contract rehearses the canonical action once and records distinct typed operations', async (t) => {
  const harness = createHarness(t);
  const args = beginArgs();
  const started = harness.clock.value;
  assert.equal(envelope(await harness.handler(args)).ok, true);
  observe(harness, 'cdp_run_action', started + 100, okResult({ replayed: true }), actionRunArgs());
  assert.deepEqual(
    harness.monitor.observations().map((observation) => observation.tool),
    ['cdp_run_action'],
  );
  harness.clock.value = started + 16_000;
  assert.equal(envelope(await harness.handler({ action: 'finish_rehearsal' })).ok, true);
  await arm(harness, args);
  const recordingStart = await startRecording(harness, args);
  recordEvidence(harness, recordingStart, {}, args);
  assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
  markProofOutputs(harness, args);

  const validated = envelope(await harness.handler({ action: 'validate' }));

  assert.equal(validated.ok, true, JSON.stringify(validated));
  const receipt = (validated.data as { receipt: FinalProofReceipt }).receipt;
  assert.deepEqual(
    receipt.eventTrace.observed.map((event) => event.tool),
    args.storyboard.steps.flatMap((step) => [step.expectedTool, step.assertionTool]),
  );
  assert.equal(
    receipt.eventTrace.observed.some((event) => event.tool === 'cdp_run_action'),
    false,
  );
});

test('production action identity reads exact app-root YAML bytes and runtime revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-action-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.rn-agent', 'actions'), { recursive: true });
  await mkdir(join(root, '.rn-agent', 'state'), { recursive: true });
  await writeFile(join(root, '.rn-agent', 'actions', 'canonical-proof.yaml'), ACTION_YAML_BYTES);
  await writeFile(
    join(root, '.rn-agent', 'state', 'canonical-proof.state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 7,
      updatedAt: '2026-07-13T00:00:00.000Z',
      lastSeenMtimeMs: 0,
      runHistory: [],
      repairHistory: [],
      stats: { totalRuns: 0, successCount: 0, failureCount: 0, avgDurationMs: 0 },
    })}\n`,
  );
  const module = await import('../../dist/tools/proof-capture.js');

  assert.deepEqual(module.readProofActionIdentity(root, 'canonical-proof'), {
    id: 'canonical-proof',
    version: '7',
    sha256: HASH(ACTION_YAML_BYTES),
  });
  assert.equal(module.readProofActionIdentity(root, 'missing'), null);
});

test('real canonical action proof replay is read-only while normal replay persists', async (t) => {
  const proofModule = await import('../../dist/tools/proof-capture.js');
  const { createRunActionHandler } = await import('../../dist/tools/run-action.js');
  const { addToolObserver, instrumentTool } =
    await import('../../dist/observability/instrumentation.js');
  const { resetActionStore } = await import('../../dist/domain/action-state-store.js');
  const canonicalBytes = await readFile(
    resolve(CORE_ROOT, '../../apps/proof-fixture/actions/canonical-proof.yaml'),
    'utf8',
  );

  const createProject = async (st: TestContext) => {
    const root = await mkdtemp(join(tmpdir(), 'strict-proof-real-action-'));
    st.after(() => {
      resetActionStore(root);
      return rm(root, { recursive: true, force: true });
    });
    const actionPath = join(root, '.rn-agent', 'actions', 'canonical-proof.yaml');
    await mkdir(dirname(actionPath), { recursive: true });
    await writeFile(join(root, 'README.md'), 'base\n');
    await writeFile(actionPath, canonicalBytes);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'proof@example.invalid']);
    git(root, ['config', 'user.name', 'Proof Test']);
    git(root, ['add', 'README.md', '.rn-agent/actions/canonical-proof.yaml']);
    git(root, ['commit', '-qm', 'canonical proof action']);
    return { root, actionPath };
  };

  const passingMaestro = async () =>
    okResult({ passed: true, output: 'PASS', flowFile: 'canonical-proof.yaml', platform: 'ios' });

  await t.test(
    'normal replay keeps its RunRecord, promotion, sidecar, and DB mirror',
    async (st) => {
      const { root } = await createProject(st);
      const runAction = createRunActionHandler({ maestroRun: passingMaestro });

      const result = await runAction({
        actionId: 'canonical-proof',
        projectRoot: root,
        autoRepair: false,
        forceReload: false,
      });

      assert.equal(envelope(result).ok, true, result.content[0]!.text);
      assert.deepEqual(proofModule.readProofGitInfo(root).changes, [
        {
          path: '.rn-agent/actions/canonical-proof.yaml',
          indexStatus: ' ',
          worktreeStatus: 'M',
        },
        { path: '.rn-agent/state/actions.db', indexStatus: '?', worktreeStatus: '?' },
        { path: '.rn-agent/state/actions.db-shm', indexStatus: '?', worktreeStatus: '?' },
        { path: '.rn-agent/state/actions.db-wal', indexStatus: '?', worktreeStatus: '?' },
        {
          path: '.rn-agent/state/canonical-proof.state.json',
          indexStatus: '?',
          worktreeStatus: '?',
        },
      ]);
    },
  );

  await t.test('proof replay reaches arm without mutating action or Git authority', async (st) => {
    const { root } = await createProject(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    args.pullRequest.headSha = head;
    args.storyboard.sourceTreeSha = head;
    args.proofAction = proofModule.readProofActionIdentity(root, 'canonical-proof')!;
    harness.setActionIdentityReader((actionId) =>
      proofModule.readProofActionIdentity(root, actionId),
    );
    harness.setGitInfo(() => proofModule.readProofGitInfo(root));
    harness.setRemove(async (path) => rm(path, { force: true }));
    assert.equal(envelope(await harness.handler(args)).ok, true);
    const realRunAction = createRunActionHandler({ maestroRun: passingMaestro });
    const observedRunAction = instrumentTool(
      'cdp_run_action',
      async (params: Record<string, unknown>) =>
        realRunAction({ ...params, projectRoot: root, platform: 'android' }),
    );
    const stopObserving = addToolObserver((observation) => harness.monitor.record(observation));
    const result = await observedRunAction(actionRunArgs());
    stopObserving();

    assert.equal(envelope(result as ToolResult).ok, true, (result as ToolResult).content[0]!.text);
    assert.deepEqual(
      proofModule.readProofGitInfo(root).changes,
      [],
      'proof replay must not create action runtime persistence',
    );
    harness.clock.value += 16_000;
    assert.equal(envelope(await harness.handler({ action: 'finish_rehearsal' })).ok, true);
    await mkdir(dirname(args.storyboard.steps[0]!.screenshotPath), { recursive: true });
    await writeFile(args.storyboard.steps[0]!.screenshotPath, 'verified start');
    observeFreshStart(harness, args);
    const armed = await harness.handler({ action: 'arm' });
    assert.equal(envelope(armed).ok, true, armed.content[0]!.text);
  });

  await t.test('proof replay refuses mutating flags before execution', async (st) => {
    const { root } = await createProject(st);
    let calls = 0;
    const runAction = createRunActionHandler({
      maestroRun: async () => {
        calls += 1;
        return passingMaestro();
      },
    });
    for (const args of [
      { actionId: 'canonical-proof', proofReplay: true, autoRepair: true, forceReload: false },
      { actionId: 'canonical-proof', proofReplay: true, autoRepair: false, forceReload: true },
    ]) {
      const result = await runAction({ ...args, projectRoot: root });
      assert.equal(envelope(result).ok, false, result.content[0]!.text);
    }
    assert.equal(calls, 0);
    assert.deepEqual(proofModule.readProofGitInfo(root).changes, []);
  });

  await t.test('failed and throwing proof replays create no sidecar or DB state', async (st) => {
    for (const scenario of ['failed', 'throwing'] as const) {
      const { root } = await createProject(st);
      const runAction = createRunActionHandler({
        maestroRun: async () => {
          if (scenario === 'throwing') throw new Error('Maestro transport failed');
          return failResult('Maestro failed', { output: 'Assertion failed' });
        },
      });

      const result = await runAction({ ...actionRunArgs(), projectRoot: root });

      assert.equal(envelope(result).ok, false, `${scenario}: ${result.content[0]!.text}`);
      assert.deepEqual(
        proofModule.readProofGitInfo(root).changes,
        [],
        `${scenario} proof replay persisted runtime state`,
      );
    }
  });

  await t.test('proof replay cannot hide an action edit during execution', async (st) => {
    const { root, actionPath } = await createProject(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    args.pullRequest.headSha = head;
    args.storyboard.sourceTreeSha = head;
    args.proofAction = proofModule.readProofActionIdentity(root, 'canonical-proof')!;
    harness.setActionIdentityReader((actionId) =>
      proofModule.readProofActionIdentity(root, actionId),
    );
    harness.setGitInfo(() => proofModule.readProofGitInfo(root));
    assert.equal(envelope(await harness.handler(args)).ok, true);
    const realRunAction = createRunActionHandler({
      maestroRun: async () => {
        await writeFile(actionPath, canonicalBytes.replace('proof-submit', 'proof-submit-raced'));
        return passingMaestro();
      },
    });
    const observedRunAction = instrumentTool(
      'cdp_run_action',
      async (params: Record<string, unknown>) =>
        realRunAction({ ...params, projectRoot: root, platform: 'android' }),
    );
    const stopObserving = addToolObserver((observation) => harness.monitor.record(observation));
    await observedRunAction(actionRunArgs());
    stopObserving();
    harness.clock.value += 16_000;

    const result = await harness.handler({ action: 'finish_rehearsal' });

    assert.ok(reasons(result).includes('PROOF_ACTION_IDENTITY_CHANGED'), result.content[0]!.text);
    assert.ok(reasons(result).includes('GIT_DIRTY'), result.content[0]!.text);
  });
});

test('arm consumes a fresh verified start assertion after rehearsal', async (t) => {
  await t.test('missing fresh assertion', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    const result = await harness.handler({ action: 'arm' });
    assert.ok(reasons(result).includes('START_ASSERTION_MISSING'), result.content[0]!.text);
  });

  await t.test('proof_step without requested verification', async (st) => {
    const harness = createHarness(st);
    const args = beginArgs();
    await cleanRehearsal(harness);
    observeFreshStart(
      harness,
      args,
      okResult({ screenshotPath: args.storyboard.steps[0]!.screenshotPath }),
    );
    const result = await harness.handler({ action: 'arm' });
    assert.ok(reasons(result).includes('START_ASSERTION_FAILED'), result.content[0]!.text);
  });

  await t.test('tool drift after arm blocks recorder start', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    observe(harness, 'device_press', harness.clock.value + 10, okResult({ pressed: true }));
    const result = await harness.handler({ action: 'start_recording' });
    assert.ok(reasons(result).includes('START_STATE_DRIFT'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
  });

  await t.test('Git and readiness are rechecked immediately before start', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    harness.git.sha = 'b'.repeat(40);
    harness.readiness.errorCount = 1;
    observeFreshStart(harness);
    const result = await harness.handler({ action: 'start_recording' });
    assert.ok(reasons(result).includes('SOURCE_SHA_MISMATCH'), result.content[0]!.text);
    assert.ok(reasons(result).includes('ERROR_BASELINE_CHANGED'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
  });

  await t.test('owned stale artifacts are removed before recorder start', async (st) => {
    const harness = createHarness(st);
    const args = beginArgs();
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    await startRecording(harness);
    assert.deepEqual(
      new Set(harness.removed),
      new Set([
        args.receiptPath,
        args.videoPath,
        args.contactSheetPath,
        ...args.storyboard.steps.map((step) => step.screenshotPath),
      ]),
    );
    assert.equal(harness.recordCalls.at(-1)?.action, 'start');
  });
});

test('cleanup failures preserve a rejected session and discard retries them', async (t) => {
  await t.test('artifact deletion failure prevents recorder start', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    harness.setRemove(async (path) => {
      if (path.endsWith('proof.mp4')) throw new Error('unlink failed');
    });
    observeFreshStart(harness);

    const result = await harness.handler({ action: 'start_recording' });

    assert.ok(reasons(result).includes('ARTIFACT_CLEANUP_FAILED'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
    assert.equal(
      (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
      'rejected',
    );
    harness.setRemove(async () => undefined);
    assert.equal(envelope(await harness.handler({ action: 'discard' })).ok, true);
  });

  await t.test('uncertain start plus failed shutdown never reports rehearsing', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    let statusCalls = 0;
    harness.setRecord(async (args) => {
      if (args.action === 'status') {
        statusCalls += 1;
        return okResult({
          active:
            statusCalls === 1
              ? []
              : [{ platform: 'ios', pid: 99, status: 'running', output: beginArgs().videoPath }],
        });
      }
      if (args.action === 'start') return failResult('start response lost');
      return failResult('stop failed');
    });
    observeFreshStart(harness);

    const result = await harness.handler({ action: 'start_recording' });

    assert.ok(reasons(result).includes('RECORDING_SHUTDOWN_FAILED'), result.content[0]!.text);
    assert.equal(
      (envelope(await harness.handler({ action: 'status' })).data as { stage: string }).stage,
      'rejected',
    );
    harness.setRecord(async (args) =>
      args.action === 'status' ? okResult({ active: [] }) : okResult({ action: 'stop', saved: [] }),
    );
    assert.equal(envelope(await harness.handler({ action: 'discard' })).ok, true);
  });
});

test('validate is action-only and derives evidence from recorded results', async (t) => {
  const harness = createHarness(t);
  await cleanRehearsal(harness);
  observeFreshStart(harness);
  await arm(harness);
  const recordingStart = await startRecording(harness);
  const observed = recordEvidence(harness, recordingStart);
  const stopped = envelope(await harness.handler({ action: 'stop_recording' }));
  assert.equal(stopped.ok, true);
  markProofOutputs(harness);
  const draft = (stopped.data as { evidenceDraft: typeof observed }).evidenceDraft;
  assert.deepEqual(draft, observed);
  assert.equal(proofCaptureInputSchema.safeParse({ action: 'validate' }).success, true);
  assert.equal(
    proofCaptureInputSchema.safeParse({ action: 'validate', evidence: observed }).success,
    false,
  );

  const result = await harness.handler({ action: 'validate' } as ProofCaptureArgs);

  assert.equal(envelope(result).ok, true, result.content[0]!.text);
});

test('proof artifacts are allowed Git changes but any unrelated change is dirty', async (t) => {
  const harness = createHarness(t);
  const args = beginArgs();
  await cleanRehearsal(harness);
  observeFreshStart(harness);
  await arm(harness);
  const recordingStart = await startRecording(harness);
  recordEvidence(harness, recordingStart);
  assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
  const ownedPaths = [
    args.videoPath,
    args.contactSheetPath,
    ...args.storyboard.steps.map((step) => step.screenshotPath),
  ].map((path) => path.slice(args.projectRoot.length + 1));
  harness.git.dirty = true;
  harness.git.changes = ownedPaths.map((path) => ({
    path,
    indexStatus: '?',
    worktreeStatus: '?',
  }));
  assert.equal(
    envelope(await harness.handler({ action: 'validate' } as ProofCaptureArgs)).ok,
    true,
  );

  const second = createHarness(t);
  await cleanRehearsal(second);
  observeFreshStart(second);
  await arm(second);
  const secondStart = await startRecording(second);
  recordEvidence(second, secondStart);
  assert.equal(envelope(await second.handler({ action: 'stop_recording' })).ok, true);
  second.git.dirty = true;
  second.git.changes = [...ownedPaths, 'packages/rn-dev-agent-core/src/index.ts'].map((path) => ({
    path,
    indexStatus: '?',
    worktreeStatus: '?',
  }));
  const rejected = await second.handler({ action: 'validate' } as ProofCaptureArgs);
  assert.ok(reasons(rejected).includes('GIT_DIRTY'), rejected.content[0]!.text);
});

test('production Git porcelain parser returns normalized tracked, untracked, and rename paths', async () => {
  const module = await import('../../dist/tools/proof-capture.js');
  assert.deepEqual(
    module.parseProofGitChangedPaths(
      '?? docs/proof/run-42/proof.mp4\0 M packages/core/src/index.ts\0R  new-name.ts\0old-name.ts\0',
    ),
    ['docs/proof/run-42/proof.mp4', 'packages/core/src/index.ts', 'new-name.ts', 'old-name.ts'],
  );
});

test('proof root must be fresh, dedicated, and confined to docs/proof/run slug', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-owned-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const existing = beginArgs(root);
  await mkdir(dirname(existing.videoPath), { recursive: true });
  await writeFile(existing.videoPath, 'pre-existing');
  const existingHarness = createHarness(t, root);
  const existingResult = await existingHarness.handler(existing);
  assert.ok(
    reasons(existingResult).includes('PROOF_ROOT_NOT_FRESH'),
    existingResult.content[0]!.text,
  );
  assert.deepEqual(existingHarness.removed, []);

  await rm(join(root, 'docs'), { recursive: true, force: true });
  const outsideRun = beginArgs(root);
  outsideRun.videoPath = join(root, 'docs', 'proof', 'another-run', 'proof.mp4');
  const outsideHarness = createHarness(t, root);
  const outsideResult = await outsideHarness.handler(outsideRun);
  assert.ok(
    reasons(outsideResult).includes('INVALID_PROOF_CONTEXT'),
    outsideResult.content[0]!.text,
  );
});

test('production identity canonically binds iOS and Android target presentation', async () => {
  const module = await import('../../dist/tools/proof-capture.js');
  const ios = {
    session: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.fixture' },
    target: { platform: 'ios', description: 'dev.fixture', deviceName: ' iPhone   16 Pro ' },
    nativeDevice: { id: 'SIM-1', name: 'iPhone 16 Pro', osVersion: '18.5' },
    metroPort: 8081,
    pluginVersion: '0.69.0',
    metroReady: true,
  };
  assert.equal(module.resolveProofIdentity(ios)?.device.id, 'SIM-1');
  assert.equal(
    module.resolveProofIdentity({
      ...ios,
      target: {
        ...ios.target,
        title: 'dev.fixture (iPhone 16 Pro)',
        description: 'React Native Bridgeless [C++ connection]',
      },
    })?.device.id,
    'SIM-1',
  );
  assert.equal(
    module.resolveProofIdentity({
      ...ios,
      target: {
        ...ios.target,
        title: 'dev.fixture.other (iPhone 16 Pro)',
        description: 'React Native Bridgeless [C++ connection]',
      },
    }),
    null,
  );
  assert.equal(module.resolveProofIdentity({ ...ios, session: null }), null);
  assert.equal(
    module.resolveProofIdentity({ ...ios, session: { ...ios.session, deviceId: undefined } }),
    null,
  );
  assert.equal(
    module.resolveProofIdentity({
      ...ios,
      target: { ...ios.target, deviceName: 'iPhone 15' },
    }),
    null,
  );
  assert.equal(
    module.resolveProofIdentity({
      ...ios,
      session: { ...ios.session, appId: 'dev.other' },
    }),
    null,
  );
  assert.equal(
    module.resolveProofIdentity({
      ...ios,
      target: { ...ios.target, platform: 'android' },
    }),
    null,
  );

  const android = {
    ...ios,
    session: { platform: 'android', deviceId: 'emulator-5554', appId: 'dev.fixture' },
    target: {
      platform: 'android',
      description: 'dev.fixture',
      deviceName: 'sdk_gphone16k_arm64 - 17 - API 37',
    },
    nativeDevice: {
      id: 'emulator-5554',
      name: 'sdk_gphone16k_arm64',
      osVersion: '17',
    },
  };
  assert.equal(module.resolveProofIdentity(android)?.device.model, 'sdk_gphone16k_arm64');
  for (const deviceName of [
    'sdk_gphone16k_arm6 - 17 - API 37',
    'sdk_gphone16k_arm64 - 16 - API 37',
    'sdk_gphone16k_arm64 - 17',
  ]) {
    assert.equal(
      module.resolveProofIdentity({ ...android, target: { ...android.target, deviceName } }),
      null,
      deviceName,
    );
  }
});

test('bundled contract lookup and host builder use the package-owned schema', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-bundle-shape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await readFile(SCHEMA_PATH, 'utf8');
  await mkdir(join(root, 'schemas'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'schemas', 'proof-receipt.schema.json'), bytes);
  const module = await import('../../dist/tools/proof-capture.js');
  const bundled = module.readProofContractAt(
    pathToFileURL(join(root, 'dist', 'supervisor.js')).href,
  );
  assert.deepEqual(bundled, { schema: JSON.parse(bytes), bytes, sha256: HASH(bytes) });

  const builder = await readFile(
    resolve(CORE_ROOT, '../../scripts/build-host-runtimes.ts'),
    'utf8',
  );
  assert.match(builder, /proof-receipt\.schema\.json/);
  assert.match(builder, /schemas/);
});

test('Git, readiness, media, and receipt construction exceptions fail closed', async (t) => {
  await t.test('arm Git exception', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    harness.setGitInfo(() => {
      throw new Error('git unavailable');
    });
    const result = await harness.handler({ action: 'arm' });
    assert.ok(reasons(result).includes('GIT_READ_FAILED'), result.content[0]!.text);
  });

  await t.test('arm readiness exception', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    harness.setReadiness(async () => {
      throw new Error('CDP unavailable');
    });
    const result = await harness.handler({ action: 'arm' });
    assert.ok(reasons(result).includes('READINESS_FAILED'), result.content[0]!.text);
  });

  await t.test('media exception cleans capture without accepting it', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    const recordingStart = await startRecording(harness);
    recordEvidence(harness, recordingStart);
    assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
    harness.setMediaImpl(async () => {
      throw new Error('ffprobe spawn failed');
    });
    const result = await harness.handler({ action: 'validate' } as ProofCaptureArgs);
    assert.ok(reasons(result).includes('MEDIA_VALIDATION_FAILED'), result.content[0]!.text);
    assert.equal(harness.written.length, 0);
  });

  await t.test('invalid media receipt shape becomes a stable construction failure', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    await arm(harness);
    const recordingStart = await startRecording(harness);
    recordEvidence(harness, recordingStart);
    assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
    markProofOutputs(harness);
    const malformed = successfulMedia();
    malformed.video.sha256 = 'not-a-hash';
    harness.setMedia(malformed);
    const result = await harness.handler({ action: 'validate' } as ProofCaptureArgs);
    assert.ok(reasons(result).includes('RECEIPT_CONSTRUCTION_FAILED'), result.content[0]!.text);
    assert.equal(harness.written.length, 0);
  });
});

test('storyboard argument hashes use the monitor canonicalizer and are required', async () => {
  const module = await import('../../dist/domain/proof-capture.js');
  assert.equal(typeof module.hashProofArgs, 'function');
  assert.equal(module.hashProofArgs(actionRunArgs()), argsHash(actionRunArgs()));
  assert.equal(
    module.hashProofArgs(actionRunArgs()),
    module.hashProofArgs({
      proofReplay: true,
      forceReload: false,
      autoRepair: false,
      actionId: 'canonical-proof',
    }),
  );

  const args = beginArgs();
  assert.equal(proofCaptureInputSchema.safeParse(args).success, true);
  const missing = structuredClone(args) as unknown as {
    storyboard: { steps: Array<{ expectedArgsSha256?: string }> };
  };
  delete missing.storyboard.steps[0]!.expectedArgsSha256;
  assert.equal(proofCaptureInputSchema.safeParse(missing).success, false);
});

test('strict proof observations bind the canonical semantic argument hash', async () => {
  const monitor = new StrictProofMonitor(() => 123);
  monitor.begin();
  monitor.record({
    tool: 'cdp_run_action',
    params: actionRunArgs(),
    status: 'PASS',
    latencyMs: 1,
    result: okResult({ replayed: true }),
  });
  assert.equal(monitor.observations()[0]?.argsHash, argsHash(actionRunArgs()));
});

test('recording rejects semantically different operation and assertion arguments', async (t) => {
  for (const scenario of ['wrong operation', 'wrong assertion target'] as const) {
    await t.test(scenario, async (st) => {
      const harness = createHarness(st);
      const args = beginArgs();
      await cleanRehearsal(harness);
      await arm(harness);
      const recordingStart = await startRecording(harness);
      recordEvidence(harness, recordingStart, {
        operationArgsOverrides:
          scenario === 'wrong operation' ? [{ interactiveOnly: false }] : undefined,
        assertionArgsOverrides:
          scenario === 'wrong assertion target'
            ? [assertionArgs(args.storyboard.steps[0]!, 'unrelated-but-visible')]
            : undefined,
      });
      assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
      markProofOutputs(harness);

      const result = await harness.handler({ action: 'validate' });

      assert.ok(
        reasons(result).includes(
          scenario === 'wrong operation'
            ? 'OPERATION_ARGUMENT_MISMATCH'
            : 'ASSERTION_ARGUMENT_MISMATCH',
        ),
        result.content[0]!.text,
      );
    });
  }
});

test('start consumes one post-arm zero-wait typed assertion and rejects drift', async (t) => {
  await t.test('missing post-arm assertion', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    await arm(harness);
    const result = await harness.handler({ action: 'start_recording' });
    assert.ok(reasons(result).includes('START_ASSERTION_MISSING'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
  });

  await t.test('unrelated verified target', async (st) => {
    const harness = createHarness(st);
    const args = beginArgs();
    await cleanRehearsal(harness);
    await arm(harness, args);
    const first = args.storyboard.steps[0]!;
    observe(
      harness,
      first.assertionTool,
      harness.clock.value + 1,
      assertionResult(first.screenshotPath),
      assertionArgs(first, 'unrelated-but-visible'),
    );
    const result = await harness.handler({ action: 'start_recording' });
    assert.ok(
      reasons(result).includes('START_ASSERTION_ARGUMENT_MISMATCH'),
      result.content[0]!.text,
    );
    assert.deepEqual(harness.recordCalls, []);
  });

  await t.test('activity after the post-arm assertion', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    await arm(harness);
    observeFreshStart(harness);
    observe(harness, 'device_press', harness.clock.value + 1, okResult({ pressed: true }));
    const result = await harness.handler({ action: 'start_recording' });
    assert.ok(reasons(result).includes('START_STATE_DRIFT'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
  });
});

test('tracked proof roots are rejected even when their indexed files are deleted', async (t) => {
  const harness = createHarness(t);
  harness.setProofRootTracked(true);

  const result = await harness.handler(beginArgs());

  assert.ok(reasons(result).includes('PROOF_ROOT_TRACKED'), result.content[0]!.text);
  assert.deepEqual(harness.removed, []);
});

test('production Git authority preserves index/worktree status and deleted tracked roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-git-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'proof@example.invalid']);
  git(root, ['config', 'user.name', 'Proof Test']);
  await writeFile(join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'base']);

  const trackedRoot = join(root, 'docs', 'proof', 'tracked-run');
  await mkdir(trackedRoot, { recursive: true });
  await writeFile(join(trackedRoot, 'proof.mp4'), 'tracked');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'tracked proof']);
  await rm(trackedRoot, { recursive: true, force: true });

  const module = await import('../../dist/tools/proof-capture.js');
  assert.equal(typeof module.proofRootHasTrackedEntries, 'function');
  assert.equal(module.proofRootHasTrackedEntries(root, trackedRoot), true);
  assert.deepEqual(module.readProofGitInfo(root).changes, [
    {
      path: 'docs/proof/tracked-run/proof.mp4',
      indexStatus: ' ',
      worktreeStatus: 'D',
    },
  ]);

  await mkdir(trackedRoot, { recursive: true });
  await writeFile(join(trackedRoot, 'proof.mp4'), 'tracked');
  const stagedPath = join(root, 'docs', 'proof', 'staged-run', 'proof.mp4');
  await mkdir(dirname(stagedPath), { recursive: true });
  await writeFile(stagedPath, 'staged');
  git(root, ['add', 'docs/proof/staged-run/proof.mp4']);
  assert.deepEqual(
    module
      .readProofGitInfo(root)
      .changes.find((change: TestGitChange) => change.path === 'docs/proof/staged-run/proof.mp4'),
    {
      path: 'docs/proof/staged-run/proof.mp4',
      indexStatus: 'A',
      worktreeStatus: ' ',
    },
  );

  git(root, ['commit', '-qm', 'staged fixture']);
  const untrackedPath = join(root, 'docs', 'proof', 'new-run', 'proof.mp4');
  await mkdir(dirname(untrackedPath), { recursive: true });
  await writeFile(untrackedPath, 'untracked');
  await writeFile(join(root, 'unrelated.txt'), 'unrelated');
  assert.deepEqual(module.readProofGitInfo(root).changes, [
    { path: 'docs/proof/new-run/proof.mp4', indexStatus: '?', worktreeStatus: '?' },
    { path: 'unrelated.txt', indexStatus: '?', worktreeStatus: '?' },
  ]);
});

test('validation allows only the complete exact untracked proof output set', async (t) => {
  const args = beginArgs();
  const expectedPaths = [
    args.videoPath,
    args.contactSheetPath,
    ...args.storyboard.steps.map((step) => step.screenshotPath),
  ].map((path) => path.slice(args.projectRoot.length + 1));
  const untracked = (path: string): TestGitChange => ({
    path,
    indexStatus: '?',
    worktreeStatus: '?',
  });

  for (const scenario of ['complete', 'staged', 'missing', 'unrelated'] as const) {
    await t.test(scenario, async (st) => {
      const harness = createHarness(st);
      await stoppedCapture(harness);
      harness.git.dirty = true;
      harness.git.changes = expectedPaths.map(untracked);
      if (scenario === 'staged') {
        harness.git.changes[0] = {
          path: expectedPaths[0]!,
          indexStatus: 'A',
          worktreeStatus: ' ',
        };
      } else if (scenario === 'missing') {
        harness.git.changes.pop();
      } else if (scenario === 'unrelated') {
        harness.git.changes.push(untracked('packages/core/src/index.ts'));
      }

      const result = await harness.handler({ action: 'validate' });

      if (scenario === 'complete') {
        assert.equal(envelope(result).ok, true, result.content[0]!.text);
      } else {
        assert.ok(
          reasons(result).includes(scenario === 'missing' ? 'PROOF_OUTPUT_MISSING' : 'GIT_DIRTY'),
          result.content[0]!.text,
        );
      }
    });
  }
});

test('real Git allows observed setup screenshots, cleans before recording, and validates full outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'strict-proof-live-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'proof@example.invalid']);
  git(root, ['config', 'user.name', 'Proof Test']);
  await writeFile(join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'base']);
  const sourceSha = git(root, ['rev-parse', 'HEAD']).trim();
  const module = await import('../../dist/tools/proof-capture.js');
  const harness = createHarness(t, root);
  const args = beginArgs(root);
  args.pullRequest.headSha = sourceSha;
  args.storyboard.sourceTreeSha = sourceSha;
  harness.setGitInfo(() => module.readProofGitInfo(root));
  harness.setRemove(async (path) => rm(path, { force: true }));

  await cleanRehearsal(harness, false, args);
  await mkdir(dirname(args.storyboard.steps[0]!.screenshotPath), { recursive: true });
  await writeFile(args.storyboard.steps[0]!.screenshotPath, 'pre-arm start state');
  await arm(harness, args);
  assert.deepEqual(module.readProofGitInfo(root).changes, [
    {
      path: `docs/proof/${args.runId}/start-state.png`,
      indexStatus: '?',
      worktreeStatus: '?',
    },
  ]);

  const recordingStart = await startRecording(harness, args);
  assert.deepEqual(module.readProofGitInfo(root).changes, []);
  recordEvidence(harness, recordingStart, {}, args);
  assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
  await mkdir(dirname(args.videoPath), { recursive: true });
  await Promise.all([
    writeFile(args.videoPath, 'video'),
    writeFile(args.contactSheetPath, 'contact'),
    ...args.storyboard.steps.map((step) => writeFile(step.screenshotPath, step.id)),
  ]);

  const validated = await harness.handler({ action: 'validate' });

  assert.equal(envelope(validated).ok, true, validated.content[0]!.text);
  assert.deepEqual(
    module.readProofGitInfo(root).changes.map((change: TestGitChange) => change.path),
    [
      `docs/proof/${args.runId}/fill-form.png`,
      `docs/proof/${args.runId}/open-form.png`,
      `docs/proof/${args.runId}/proof-contact-sheet.jpg`,
      `docs/proof/${args.runId}/proof.mp4`,
      `docs/proof/${args.runId}/start-state.png`,
      `docs/proof/${args.runId}/submit-form.png`,
    ],
  );
});

test('real Git rejects tracked, staged, unrelated, early, and missing proof outputs', async (t) => {
  const module = await import('../../dist/tools/proof-capture.js');
  const createRealHarness = async (st: TestContext) => {
    const root = await mkdtemp(join(tmpdir(), 'strict-proof-live-git-negative-'));
    st.after(() => rm(root, { recursive: true, force: true }));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'proof@example.invalid']);
    git(root, ['config', 'user.name', 'Proof Test']);
    await writeFile(join(root, 'README.md'), 'base\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'base']);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    const sourceSha = git(root, ['rev-parse', 'HEAD']).trim();
    args.pullRequest.headSha = sourceSha;
    args.storyboard.sourceTreeSha = sourceSha;
    harness.setGitInfo(() => module.readProofGitInfo(root));
    harness.setRemove(async (path) => rm(path, { force: true }));
    return { root, harness, args };
  };

  await t.test('tracked root', async (st) => {
    const { root, harness, args } = await createRealHarness(st);
    await mkdir(dirname(args.storyboard.steps[0]!.screenshotPath), { recursive: true });
    await writeFile(args.storyboard.steps[0]!.screenshotPath, 'tracked');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'tracked proof root']);
    await rm(dirname(args.storyboard.steps[0]!.screenshotPath), { recursive: true, force: true });
    harness.setProofRootTracked(
      module.proofRootHasTrackedEntries(root, dirname(args.storyboard.steps[0]!.screenshotPath)),
    );

    const result = await harness.handler(args);

    assert.ok(reasons(result).includes('PROOF_ROOT_TRACKED'), result.content[0]!.text);
  });

  for (const scenario of ['staged screenshot', 'unrelated path', 'early video'] as const) {
    await t.test(scenario, async (st) => {
      const { root, harness, args } = await createRealHarness(st);
      await cleanRehearsal(harness, false, args);
      await mkdir(dirname(args.storyboard.steps[0]!.screenshotPath), { recursive: true });
      await writeFile(args.storyboard.steps[0]!.screenshotPath, 'observed start');
      observeFreshStart(harness, args);
      if (scenario === 'staged screenshot') {
        git(root, ['add', args.storyboard.steps[0]!.screenshotPath]);
      } else if (scenario === 'unrelated path') {
        await writeFile(join(root, 'unrelated.txt'), 'unrelated');
      } else {
        await writeFile(args.videoPath, 'too early');
      }

      const result = await harness.handler({ action: 'arm' });

      assert.ok(reasons(result).includes('GIT_DIRTY'), result.content[0]!.text);
    });
  }

  await t.test('missing validation output', async (st) => {
    const { harness, args } = await createRealHarness(st);
    await cleanRehearsal(harness, false, args);
    await mkdir(dirname(args.storyboard.steps[0]!.screenshotPath), { recursive: true });
    await writeFile(args.storyboard.steps[0]!.screenshotPath, 'observed start');
    await arm(harness, args);
    const recordingStart = await startRecording(harness, args);
    recordEvidence(harness, recordingStart, {}, args);
    assert.equal(envelope(await harness.handler({ action: 'stop_recording' })).ok, true);
    await mkdir(dirname(args.videoPath), { recursive: true });
    await Promise.all([
      writeFile(args.videoPath, 'video'),
      writeFile(args.contactSheetPath, 'contact'),
      ...args.storyboard.steps.slice(0, -1).map((step) => writeFile(step.screenshotPath, step.id)),
    ]);

    const result = await harness.handler({ action: 'validate' });

    assert.ok(reasons(result).includes('PROOF_OUTPUT_MISSING'), result.content[0]!.text);
  });
});

test('Metro reporter authority must stay connected and event-stable through capture', async (t) => {
  await t.test('absent at arm', async (st) => {
    const harness = createHarness(st);
    await cleanRehearsal(harness);
    observeFreshStart(harness);
    harness.readiness.metroEventsConnected = false;
    const result = await harness.handler({ action: 'arm' });
    assert.ok(reasons(result).includes('METRO_EVENTS_UNAVAILABLE'), result.content[0]!.text);
  });

  for (const phase of ['start', 'validate'] as const) {
    for (const change of ['reconnected', 'build-start-done', 'reload'] as const) {
      await t.test(`${phase}: ${change}`, async (st) => {
        const harness = createHarness(st);
        if (phase === 'start') {
          await cleanRehearsal(harness);
          await arm(harness);
        } else {
          await stoppedCapture(harness);
        }
        harness.readiness.metroEventMarker =
          change === 'reconnected'
            ? 'connection-2:event-0'
            : change === 'build-start-done'
              ? 'connection-1:event-2'
              : 'connection-1:event-1';
        if (phase === 'start') observeFreshStart(harness);

        const result = await harness.handler({
          action: phase === 'start' ? 'start_recording' : 'validate',
        });

        assert.ok(reasons(result).includes('METRO_ACTIVITY_CHANGED'), result.content[0]!.text);
      });
    }
  }
});

test('tool registry contains proof_capture exactly once', async () => {
  const registry = JSON.parse(
    await readFile(resolve(CORE_ROOT, 'test/fixtures/tool-registry.json'), 'utf8'),
  ) as string[];
  assert.equal(registry.filter((name) => name === 'proof_capture').length, 1);
});
