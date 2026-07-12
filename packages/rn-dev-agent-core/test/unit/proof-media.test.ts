import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { validateTrace } from '../../dist/domain/proof-capture.js';
import {
  buildContactSheet,
  matchScreenshotAt,
  probeVideo,
  sha256File,
  validateMedia,
  type MediaProcess,
  type MediaValidationResult,
} from '../../dist/tools/proof-media.js';

interface ProcessCall {
  command: string;
  args: string[];
}

interface FakeMediaProcessOptions {
  metadata?: unknown;
  durationSeconds?: number;
  fail?: (call: ProcessCall) => boolean;
  ssimOutputs?: string[];
  contactSheetOutput?: 'non-empty' | 'missing' | 'empty';
}

class FakeMediaProcess implements MediaProcess {
  readonly calls: ProcessCall[] = [];
  private readonly options: FakeMediaProcessOptions;
  private ssimIndex = 0;

  constructor(options: FakeMediaProcessOptions = {}) {
    this.options = options;
  }

  async run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const call = { command, args: [...args] };
    this.calls.push(call);
    if (this.options.fail?.(call)) throw new Error(`${command} exited non-zero`);

    if (command === 'ffprobe') {
      const metadata = this.options.metadata ?? {
        format: {
          duration: String(this.options.durationSeconds ?? 20),
          size: '999999',
        },
        streams: [{ codec_name: 'h264', width: 1080, height: 1920 }],
      };
      return { stdout: JSON.stringify(metadata), stderr: '' };
    }

    if (args.some((arg) => arg.includes('ssim'))) {
      const output =
        this.options.ssimOutputs?.[this.ssimIndex] ??
        `SSIM Y:0.95 U:0.95 V:0.95 All:${[0.91, 0.96, 0.93][this.ssimIndex % 3]} (13.0)`;
      this.ssimIndex += 1;
      return { stdout: '', stderr: output };
    }

    const outputPath = args.at(-1);
    assert.ok(outputPath && outputPath !== '-', 'ffmpeg command must name an output file');
    await mkdir(dirname(outputPath), { recursive: true });
    if (args.some((arg) => arg.includes('xstack'))) {
      if (this.options.contactSheetOutput === 'missing') {
        return { stdout: '', stderr: '' };
      }
      await writeFile(
        outputPath,
        this.options.contactSheetOutput === 'empty' ? Buffer.alloc(0) : 'contact-sheet',
      );
      return { stdout: '', stderr: '' };
    }

    await writeFile(outputPath, `generated:${outputPath}`);
    return { stdout: '', stderr: '' };
  }
}

interface MediaFixture {
  root: string;
  videoPath: string;
  screenshots: Array<{ stepId: string; path: string; timestampMs: number }>;
  contactSheetPath: string;
}

async function createFixture(t: TestContext, screenshotCount = 3): Promise<MediaFixture> {
  const root = await mkdtemp(join(tmpdir(), 'proof-media-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = join(root, 'proof.mp4');
  const contactSheetPath = join(root, 'contact-sheet.jpg');
  await writeFile(videoPath, 'decoded-video-file');

  const timestamps = [4_000, 10_000, 16_000];
  const screenshots = [];
  for (let index = 0; index < screenshotCount; index += 1) {
    const path = join(root, `milestone-${index + 1}.png`);
    await writeFile(path, `screenshot-${index + 1}`);
    screenshots.push({
      stepId: `step-${index + 1}`,
      path,
      timestampMs: timestamps[index] ?? 18_000,
    });
  }

  return { root, videoPath, screenshots, contactSheetPath };
}

function inputFor(fixture: MediaFixture) {
  return {
    videoPath: fixture.videoPath,
    rehearsalDurationMs: 20_000,
    screenshots: fixture.screenshots,
    contactSheetPath: fixture.contactSheetPath,
    scratchRoot: fixture.root,
  };
}

function assertFailure(result: MediaValidationResult, reason: string): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('expected media validation to fail');
  assert.deepEqual(result.reasons, [reason]);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reasons']);
}

test('probeVideo trusts decoded semantics but records the actual file size and hash', async (t) => {
  const fixture = await createFixture(t);
  const process = new FakeMediaProcess({ durationSeconds: 21.25 });

  const video = await probeVideo(process, fixture.videoPath);

  assert.deepEqual(video, {
    path: fixture.videoPath,
    sha256: createHash('sha256').update('decoded-video-file').digest('hex'),
    durationMs: 21_250,
    sizeBytes: Buffer.byteLength('decoded-video-file'),
    codec: 'h264',
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(process.calls[0], {
    command: 'ffprobe',
    args: [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=codec_name,width,height',
      '-of',
      'json',
      fixture.videoPath,
    ],
  });
});

test('matchScreenshotAt samples three normalized frames and selects the highest SSIM', async (t) => {
  const fixture = await createFixture(t);
  const scratchDir = join(fixture.root, 'match');
  await mkdir(scratchDir);
  const process = new FakeMediaProcess({
    ssimOutputs: [
      'SSIM Y:0.91 All:0.910000 (10.0)',
      'SSIM Y:0.97 All:0.970000 (15.2)',
      'SSIM Y:0.94 All:0.940000 (12.2)',
    ],
  });
  const screenshotSha256 = await sha256File(fixture.screenshots[0]!.path);

  const result = await matchScreenshotAt(process, {
    videoPath: fixture.videoPath,
    screenshot: { ...fixture.screenshots[0]!, sha256: screenshotSha256 },
    threshold: 0.9,
    scratchDir,
    index: 0,
  });

  assert.deepEqual(result.frameMatch, {
    stepId: 'step-1',
    screenshotSha256,
    videoTimestampMs: 4_000,
    score: 0.97,
  });
  assert.equal(
    await readFile(result.selectedFramePath, 'utf8'),
    `generated:${result.selectedFramePath}`,
  );
  const sampleTimes = process.calls
    .filter((call) => call.command === 'ffmpeg' && call.args.includes('-ss'))
    .map((call) => call.args[call.args.indexOf('-ss') + 1]);
  assert.deepEqual(sampleTimes, ['3.500', '4.000', '4.500']);
  const imageCommands = process.calls.filter(
    (call) => call.command === 'ffmpeg' && !call.args.some((arg) => arg.includes('ssim')),
  );
  assert.equal(imageCommands.length, 4);
  assert.ok(imageCommands.every((call) => call.args.some((arg) => /scale=800/.test(arg))));
});

test('buildContactSheet creates and hashes a tiled JPEG', async (t) => {
  const fixture = await createFixture(t);
  const process = new FakeMediaProcess();

  const contactSheet = await buildContactSheet(
    process,
    fixture.screenshots.map((screenshot) => screenshot.path),
    fixture.contactSheetPath,
  );

  assert.deepEqual(contactSheet, {
    path: fixture.contactSheetPath,
    sha256: createHash('sha256').update('contact-sheet').digest('hex'),
  });
  const command = process.calls.at(-1);
  assert.equal(command?.command, 'ffmpeg');
  assert.ok(command?.args.some((arg) => arg.includes('xstack')));
  assert.ok(command?.args.includes('mjpeg'));
});

test('validateMedia rejects video below 80 percent of rehearsal duration', async (t) => {
  const fixture = await createFixture(t);
  const result = await validateMedia(
    new FakeMediaProcess({ durationSeconds: 15.999 }),
    inputFor(fixture),
  );

  assertFailure(result, 'VIDEO_TOO_SHORT');
});

test('validateMedia rejects video above the adaptive maximum', async (t) => {
  const fixture = await createFixture(t);
  const result = await validateMedia(
    new FakeMediaProcess({ durationSeconds: 30.001 }),
    inputFor(fixture),
  );

  assertFailure(result, 'VIDEO_TOO_LONG');
});

test('validateMedia enforces the absolute 60 second ceiling', async (t) => {
  const fixture = await createFixture(t);
  const result = await validateMedia(new FakeMediaProcess({ durationSeconds: 60.001 }), {
    ...inputFor(fixture),
    rehearsalDurationMs: 50_000,
  });

  assertFailure(result, 'VIDEO_TOO_LONG');
});

test('validateMedia requires at least three milestone screenshots', async (t) => {
  const fixture = await createFixture(t, 2);
  const result = await validateMedia(new FakeMediaProcess(), inputFor(fixture));

  assertFailure(result, 'INSUFFICIENT_SCREENSHOTS');
});

test('validateMedia returns no partial artifacts when final-frame SSIM is missing', async (t) => {
  const fixture = await createFixture(t);
  const result = await validateMedia(
    new FakeMediaProcess({
      ssimOutputs: [
        'SSIM All:0.95 (12)',
        'SSIM All:0.96 (14)',
        'SSIM All:0.94 (11)',
        'SSIM All:0.95 (12)',
        'SSIM All:0.96 (14)',
        'SSIM All:0.94 (11)',
        'frame comparison unavailable',
      ],
    }),
    inputFor(fixture),
  );

  assertFailure(result, 'FRAME_MISMATCH');
});

test('validateMedia hashes every accepted artifact with SHA-256', async (t) => {
  const fixture = await createFixture(t);
  const process = new FakeMediaProcess({
    ssimOutputs: [
      'SSIM All:0.91 (10)',
      'SSIM All:0.96 (14)',
      'SSIM All:0.93 (11)',
      'SSIM All:0.94 (12)',
      'SSIM All:0.92 (10)',
      'SSIM All:0.91 (9)',
      'SSIM All:0.91 (9)',
      'SSIM All:0.92 (10)',
      'SSIM All:0.97 (16)',
    ],
  });

  const result = await validateMedia(process, inputFor(fixture));

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail(`expected success, received ${result.reasons.join(',')}`);
  assert.equal(
    result.video.sha256,
    createHash('sha256').update('decoded-video-file').digest('hex'),
  );
  assert.deepEqual(
    result.screenshots.map((screenshot) => screenshot.sha256),
    ['screenshot-1', 'screenshot-2', 'screenshot-3'].map((contents) =>
      createHash('sha256').update(contents).digest('hex'),
    ),
  );
  assert.ok(
    [result.video.sha256, ...result.screenshots.map((screenshot) => screenshot.sha256)].every(
      (hash) => /^[0-9a-f]{64}$/.test(hash),
    ),
  );
  assert.deepEqual(
    result.frameMatches.map(({ videoTimestampMs, score }) => ({ videoTimestampMs, score })),
    [
      { videoTimestampMs: 4_000, score: 0.96 },
      { videoTimestampMs: 9_500, score: 0.94 },
      { videoTimestampMs: 16_500, score: 0.97 },
    ],
  );
  assert.equal(
    result.contactSheet.sha256,
    createHash('sha256').update('contact-sheet').digest('hex'),
  );
});

test('validateMedia fails closed on ffprobe and ffmpeg rejection', async (t) => {
  await t.test('ffprobe', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({ fail: ({ command }) => command === 'ffprobe' }),
      inputFor(fixture),
    );
    assertFailure(result, 'VIDEO_PROBE_FAILED');
  });

  await t.test('ffmpeg', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({
        fail: ({ command, args }) =>
          command === 'ffmpeg' && args.some((arg) => arg.includes('ssim')),
      }),
      inputFor(fixture),
    );
    assertFailure(result, 'FRAME_PROCESS_FAILED');
  });
});

test('validateMedia rejects malformed ffprobe metadata and SSIM output', async (t) => {
  await t.test('metadata', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({ metadata: { format: { duration: 'nope' }, streams: [] } }),
      inputFor(fixture),
    );
    assertFailure(result, 'VIDEO_METADATA_INVALID');
  });

  await t.test('SSIM', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({ ssimOutputs: ['not an SSIM report'] }),
      inputFor(fixture),
    );
    assertFailure(result, 'FRAME_MISMATCH');
  });

  await t.test('SSIM with trailing junk', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({ ssimOutputs: ['SSIM All:0.95garbage'] }),
      inputFor(fixture),
    );
    assertFailure(result, 'FRAME_MISMATCH');
  });
});

test('validateMedia rejects missing and empty input media', async (t) => {
  await t.test('missing video', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(new FakeMediaProcess(), {
      ...inputFor(fixture),
      videoPath: join(fixture.root, 'missing.mp4'),
    });
    assertFailure(result, 'VIDEO_MISSING');
  });

  await t.test('empty screenshot', async (t) => {
    const fixture = await createFixture(t);
    await writeFile(fixture.screenshots[1]!.path, Buffer.alloc(0));
    const result = await validateMedia(new FakeMediaProcess(), inputFor(fixture));
    assertFailure(result, 'SCREENSHOT_EMPTY');
  });
});

test('validateMedia requires a non-empty contact sheet output', async (t) => {
  await t.test('missing', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({ contactSheetOutput: 'missing' }),
      inputFor(fixture),
    );
    assertFailure(result, 'CONTACT_SHEET_MISSING');
  });

  await t.test('empty', async (t) => {
    const fixture = await createFixture(t);
    const result = await validateMedia(
      new FakeMediaProcess({ contactSheetOutput: 'empty' }),
      inputFor(fixture),
    );
    assertFailure(result, 'CONTACT_SHEET_EMPTY');
  });
});

test('proof trace fixtures represent clean, repair, reload, and wrong-order recordings', async () => {
  const fixtureRoot = resolve(import.meta.dirname, '../fixtures/proof-traces');
  const cases = [
    ['clean.json', { ok: true, reasons: [] }],
    ['repair-during-recording.json', { ok: false, reasons: ['ACTION_REPAIR_DURING_RECORDING'] }],
    ['reload-during-recording.json', { ok: false, reasons: ['RELOAD_DURING_RECORDING'] }],
    ['wrong-order.json', { ok: false, reasons: ['STORYBOARD_ORDER_VIOLATION'] }],
  ] as const;

  for (const [name, expected] of cases) {
    const fixture = JSON.parse(await readFile(join(fixtureRoot, name), 'utf8'));
    assert.deepEqual(validateTrace(fixture.allowedTools, fixture.observed), expected, name);
  }
});
