import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { failResult, okResult, type ToolResult } from '../../dist/utils.js';

const CORE_ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_PATH = resolve(CORE_ROOT, 'schemas/proof-receipt.schema.json');
const SOURCE_SHA = 'a'.repeat(40);
const HASH = (value: string): string => createHash('sha256').update(value).digest('hex');

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
  return {
    action: 'begin_rehearsal',
    projectRoot,
    receiptPath: join(projectRoot, 'proof-receipt.json'),
    videoPath: join(projectRoot, 'proof.mp4'),
    contactSheetPath: join(projectRoot, 'proof-contact-sheet.jpg'),
    writerProvider: 'codex',
    runId: 'run-42',
    issue: { repository: 'Lykhoyda/rn-dev-agent', number: 42 },
    pullRequest: { number: 108, headSha: SOURCE_SHA },
    proofClass: 'feature',
    acceptanceMappings: [
      {
        criterion: 'Shows all three exact feature states',
        storyboardStepIds: ['one', 'two', 'three'],
      },
    ],
    fixture: { name: 'proof-fixture', version: '1' },
    proofAction: { id: 'M7', version: '1', sha256: HASH('M7') },
    storyboard: {
      schemaVersion: 1,
      id: 'strict-three-state-flow',
      proofClass: 'feature',
      actionId: 'M7',
      sourceTreeSha: SOURCE_SHA,
      allowedTools: ['cdp_run_action', 'proof_step'],
      steps: [
        {
          id: 'one',
          criterion: 'First state',
          expectedTool: 'cdp_run_action',
          assertionTool: 'proof_step',
          screenshotPath: join(projectRoot, 'one.png'),
          expectedDwellMs: 3_000,
          maximumDwellMs: 5_000,
        },
        {
          id: 'two',
          criterion: 'Second state',
          expectedTool: 'cdp_run_action',
          assertionTool: 'proof_step',
          screenshotPath: join(projectRoot, 'two.png'),
          expectedDwellMs: 3_000,
          maximumDwellMs: 5_000,
        },
        {
          id: 'three',
          criterion: 'Final state',
          expectedTool: 'cdp_run_action',
          assertionTool: 'proof_step',
          screenshotPath: join(projectRoot, 'three.png'),
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
  git: { sha: string | null; dirty: boolean };
  recordCalls: DeviceRecordArgs[];
  removed: string[];
  written: FinalProofReceipt[];
  mediaCalls: Array<{ process: MediaProcess; input: MediaValidationInput }>;
  setRecord: (fn: (args: DeviceRecordArgs) => Promise<ToolResult>) => void;
  setMedia: (result: MediaValidationResult) => void;
}

function successfulMedia(args = beginArgs()): Extract<MediaValidationResult, { ok: true }> {
  const timestamps = [1_000, 5_000, 9_000];
  return {
    ok: true,
    video: {
      path: args.videoPath,
      sha256: HASH('video'),
      durationMs: 12_000,
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
      videoTimestampMs: timestamps[index]!,
      score: 0.96,
    })),
    contactSheet: { path: args.contactSheetPath, sha256: HASH('contact-sheet') },
  };
}

function createHarness(t: TestContext, expectedProjectRoot = '/tmp/proof-project'): Harness {
  const clock = { value: 1_800_000_000_000 };
  const monitor = new StrictProofMonitor(() => clock.value);
  const readiness = baseReadiness();
  const git = { sha: SOURCE_SHA as string | null, dirty: false };
  const recordCalls: DeviceRecordArgs[] = [];
  const removed: string[] = [];
  const written: FinalProofReceipt[] = [];
  const mediaCalls: Array<{ process: MediaProcess; input: MediaValidationInput }> = [];
  const mediaProcess: MediaProcess = {
    run: async () => ({ stdout: '', stderr: '' }),
  };
  let mediaResult: MediaValidationResult = successfulMedia(beginArgs(expectedProjectRoot));
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
    getGitInfo: () => ({ ...git }),
    readiness: async () => structuredClone(readiness),
    record: async (args) => {
      recordCalls.push(structuredClone(args));
      return recordImpl(args);
    },
    mediaProcess,
    validateMedia: async (process, input) => {
      mediaCalls.push({ process, input: structuredClone(input) });
      return structuredClone(mediaResult);
    },
    now: () => new Date(clock.value),
    writeReceipt: (_path, receipt) => written.push(structuredClone(receipt)),
    removeArtifact: async (path) => {
      removed.push(path);
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
  wrongFirstAssertion = false,
  args = beginArgs(),
): Promise<void> {
  const started = harness.clock.value;
  assert.equal(envelope(await harness.handler(args)).ok, true);
  for (const [index, step] of args.storyboard.steps.entries()) {
    observe(harness, step.expectedTool, started + 100 + index * 100, okResult({ replayed: true }));
    observe(
      harness,
      step.assertionTool,
      started + 150 + index * 100,
      assertionResult(step.screenshotPath, !(wrongFirstAssertion && index === 0)),
      { screenshotPath: step.screenshotPath, label: step.id },
    );
  }
  harness.clock.value = started + 12_000;
  const result = await harness.handler({ action: 'finish_rehearsal' });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
}

async function arm(harness: Harness): Promise<void> {
  const result = await harness.handler({ action: 'arm' });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
}

async function startRecording(harness: Harness): Promise<number> {
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
  } = {},
  args = beginArgs(),
): Array<{
  stepId: string;
  screenshotPath: string;
  timestampMs: number;
  assertion: { stepId: string; tool: string; ok: true; resultHash: string };
}> {
  const timestamps = options.timestampOverrides ?? [1_000, 5_000, 9_000];
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
  for (const index of options.order ?? [0, 1, 2]) {
    const step = args.storyboard.steps[index]!;
    const item = evidence[index]!;
    observe(
      harness,
      step.expectedTool,
      recordingStart + item.timestampMs - 100,
      okResult({ replayed: true }),
    );
    observe(
      harness,
      step.assertionTool,
      recordingStart + item.timestampMs,
      item.assertionResult,
      { screenshotPath: step.screenshotPath, label: step.id },
      options.failedStep === index ? 'FAIL' : 'PASS',
    );
  }
  if (options.extraTool) {
    observe(harness, options.extraTool, recordingStart + 9_500, okResult({ done: true }));
  }
  return evidence.map(({ assertionResult: _ignored, ...item }) => item);
}

async function stoppedCapture(
  harness: Harness,
  options?: Parameters<typeof recordEvidence>[2],
  args = beginArgs(),
): Promise<ReturnType<typeof recordEvidence>> {
  await cleanRehearsal(harness, false, args);
  await arm(harness);
  const recordingStart = await startRecording(harness);
  const evidence = recordEvidence(harness, recordingStart, options, args);
  const stopped = await harness.handler({ action: 'stop_recording' });
  assert.equal(envelope(stopped).ok, true, stopped.content[0]!.text);
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
    args.videoPath = join(root, 'late-video', 'proof.mp4');
    await cleanRehearsal(harness, false, args);
    await arm(harness);
    await symlink(outside, join(root, 'late-video'));

    const result = await harness.handler({ action: 'start_recording' });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
    assert.deepEqual(harness.removed, []);
  });

  await t.test('before non-recording discard', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    args.videoPath = join(root, 'late-discard', 'proof.mp4');
    assert.equal(envelope(await harness.handler(args)).ok, true);
    await symlink(outside, join(root, 'late-discard'));

    const result = await harness.handler({ action: 'discard' });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.deepEqual(harness.recordCalls, []);
    assert.deepEqual(harness.removed, []);
  });

  await t.test(
    'active discard stops the owned recorder but touches no artifact path',
    async (st) => {
      const { root, outside } = await makeRoots(st);
      const videoDirectory = join(root, 'active-video');
      await mkdir(videoDirectory);
      const harness = createHarness(st, root);
      const args = beginArgs(root);
      args.videoPath = join(videoDirectory, 'proof.mp4');
      await cleanRehearsal(harness, false, args);
      await arm(harness);
      await startRecording(harness);
      await rm(videoDirectory, { recursive: true, force: true });
      await symlink(outside, videoDirectory);
      const callsBefore = harness.recordCalls.length;

      const result = await harness.handler({ action: 'discard' });

      assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
      assert.deepEqual(
        harness.recordCalls.slice(callsBefore).map((call) => call.action),
        ['stop'],
      );
      assert.deepEqual(harness.removed, []);
    },
  );

  await t.test('before media validation', async (st) => {
    const { root, outside } = await makeRoots(st);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    args.contactSheetPath = join(root, 'late-media', 'contact-sheet.jpg');
    harness.setMedia(successfulMedia(args));
    const evidence = await stoppedCapture(harness, undefined, args);
    await symlink(outside, join(root, 'late-media'));

    const result = await harness.handler({ action: 'validate', evidence });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.equal(harness.mediaCalls.length, 0);
    assert.deepEqual(harness.removed, []);
  });

  await t.test('before final receipt write', async (st) => {
    const { root, outside } = await makeRoots(st);
    const receiptDirectory = join(root, 'late-receipt');
    await mkdir(receiptDirectory);
    const harness = createHarness(st, root);
    const args = beginArgs(root);
    args.receiptPath = join(receiptDirectory, 'proof-receipt.json');
    const evidence = await stoppedCapture(harness, undefined, args);
    assert.equal(envelope(await harness.handler({ action: 'validate', evidence })).ok, true);
    await rm(receiptDirectory, { recursive: true, force: true });
    await symlink(outside, receiptDirectory);
    const recordCalls = harness.recordCalls.length;
    const mediaCalls = harness.mediaCalls.length;

    const result = await harness.handler({ action: 'finalize', evidenceReview: validReview() });

    assert.ok(reasons(result).includes('PROOF_PATH_DRIFT'), result.content[0]!.text);
    assert.equal(harness.recordCalls.length, recordCalls);
    assert.equal(harness.mediaCalls.length, mediaCalls);
    assert.deepEqual(harness.removed, []);
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
    { name: 'dirty Git', expected: 'GIT_DIRTY', mutate: (h) => void (h.git.dirty = true) },
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
      await cleanRehearsal(harness, scenario.wrongAssertion);
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

test('trace repair, reload, failed tools, and wrong order fail closed', async (t) => {
  const cases = [
    {
      name: 'repair',
      options: { extraTool: 'cdp_repair_action' },
      expected: 'ACTION_REPAIR_DURING_RECORDING',
    },
    { name: 'reload', options: { extraTool: 'cdp_reload' }, expected: 'RELOAD_DURING_RECORDING' },
    { name: 'failed', options: { failedStep: 1 }, expected: 'OBSERVED_TOOL_FAILED' },
    { name: 'wrong order', options: { order: [1, 0, 2] }, expected: 'STORYBOARD_ORDER_VIOLATION' },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      const evidence = await stoppedCapture(harness, scenario.options);
      const result = await harness.handler({ action: 'validate', evidence });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
      assert.ok(harness.removed.includes(beginArgs().videoPath));
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
      const evidence = await stoppedCapture(harness, {
        resultPathOverrides: [undefined, resultPath, undefined],
      });
      const result = await harness.handler({ action: 'validate', evidence });
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

test('missing, duplicate, reordered, path-mismatched, hash-mismatched, and failed evidence rejects', async (t) => {
  const mutations: Array<{
    name: string;
    expected: string;
    mutate: (evidence: Awaited<ReturnType<typeof stoppedCapture>>) => void;
  }> = [
    { name: 'missing', expected: 'STEP_EVIDENCE_MISSING', mutate: (e) => void e.pop() },
    {
      name: 'duplicate',
      expected: 'STEP_EVIDENCE_DUPLICATE',
      mutate: (e) => void e.splice(1, 1, structuredClone(e[0]!)),
    },
    { name: 'reordered', expected: 'STEP_EVIDENCE_ORDER', mutate: (e) => void e.reverse() },
    {
      name: 'path mismatch',
      expected: 'SCREENSHOT_PATH_MISMATCH',
      mutate: (e) => void (e[1]!.screenshotPath = '/tmp/wrong.png'),
    },
    {
      name: 'hash mismatch',
      expected: 'ASSERTION_RESULT_HASH_MISMATCH',
      mutate: (e) => void (e[1]!.assertion.resultHash = HASH('caller-lie')),
    },
    {
      name: 'failed assertion',
      expected: 'ASSERTION_FAILED',
      mutate: (e) => void ((e[1]!.assertion as { ok: boolean }).ok = false),
    },
  ];
  for (const scenario of mutations) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      const evidence = await stoppedCapture(harness);
      scenario.mutate(evidence);
      const result = await harness.handler({ action: 'validate', evidence } as ProofCaptureArgs);
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('screenshot timestamp and per-state dwell constraints are enforced', async (t) => {
  const cases = [
    {
      name: 'not increasing',
      timestamps: [1_000, 1_000, 9_000],
      expected: 'SCREENSHOT_TIMESTAMPS_INVALID',
    },
    {
      name: 'outside video',
      timestamps: [1_000, 5_000, 12_001],
      expected: 'SCREENSHOT_TIMESTAMPS_INVALID',
    },
    {
      name: 'dwell below',
      timestamps: [1_000, 3_000, 9_000],
      expected: 'STEP_DWELL_OUT_OF_BOUNDS',
    },
    {
      name: 'dwell above',
      timestamps: [1_000, 7_000, 9_000],
      expected: 'STEP_DWELL_OUT_OF_BOUNDS',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      const evidence = await stoppedCapture(harness, { timestampOverrides: scenario.timestamps });
      const media = successfulMedia();
      media.video.durationMs = 12_000;
      media.screenshots.forEach(
        (shot, index) => void (shot.timestampMs = scenario.timestamps[index]!),
      );
      harness.setMedia(media);
      const result = await harness.handler({ action: 'validate', evidence });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('media, post-readiness, and final-state failures write no final receipt', async (t) => {
  const cases: Array<{
    name: string;
    expected: string;
    mutate: (h: Harness, evidence: Awaited<ReturnType<typeof stoppedCapture>>) => void;
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
    {
      name: 'final state',
      expected: 'FINAL_ASSERTION_FAILED',
      mutate: (_h, evidence) => void (evidence[2]!.assertion.resultHash = HASH('wrong-final')),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = createHarness(st);
      const evidence = await stoppedCapture(harness);
      scenario.mutate(harness, evidence);
      const result = await harness.handler({ action: 'validate', evidence });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('validate invokes Task 4 with the injected process and bound capture input', async (t) => {
  const harness = createHarness(t);
  const evidence = await stoppedCapture(harness);
  const result = await harness.handler({ action: 'validate', evidence });
  assert.equal(envelope(result).ok, true, result.content[0]!.text);
  assert.equal(harness.mediaCalls.length, 1);
  assert.equal(typeof harness.mediaCalls[0]!.process.run, 'function');
  assert.deepEqual(harness.mediaCalls[0]!.input, {
    videoPath: beginArgs().videoPath,
    rehearsalDurationMs: 12_000,
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
    { name: 'dirty Git', expected: 'GIT_DIRTY', mutate: (h) => void (h.git.dirty = true) },
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
      const evidence = await stoppedCapture(harness);
      scenario.mutate(harness);
      const result = await harness.handler({ action: 'validate', evidence });
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
      const evidence = await stoppedCapture(harness);
      assert.equal(envelope(await harness.handler({ action: 'validate', evidence })).ok, true);
      const result = await harness.handler({ action: 'finalize', evidenceReview: scenario.review });
      assert.ok(reasons(result).includes(scenario.expected), result.content[0]!.text);
      assert.equal(harness.written.length, 0);
    });
  }
});

test('accepted receipt is strict, uses real observed hashes, and is written exactly once', async (t) => {
  const harness = createHarness(t);
  const evidence = await stoppedCapture(harness);
  const validation = await harness.handler({ action: 'validate', evidence });
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

test('production receipt writer atomically persists accepted JSON with mode 0600', async (t) => {
  const harness = createHarness(t);
  const evidence = await stoppedCapture(harness);
  assert.equal(envelope(await harness.handler({ action: 'validate', evidence })).ok, true);
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

test('tool registry contains proof_capture exactly once', async () => {
  const registry = JSON.parse(
    await readFile(resolve(CORE_ROOT, 'test/fixtures/tool-registry.json'), 'utf8'),
  ) as string[];
  assert.equal(registry.filter((name) => name === 'proof_capture').length, 1);
});
