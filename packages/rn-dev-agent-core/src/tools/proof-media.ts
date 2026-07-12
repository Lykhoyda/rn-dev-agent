import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { durationBounds } from '../domain/proof-capture.js';
import type {
  ProofContactSheet,
  ProofFrameMatch,
  ProofScreenshot,
  ProofVideo,
} from '../domain/proof-receipt.js';

export interface MediaProcess {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export const mediaReasonCodes = [
  'INVALID_MEDIA_INPUT',
  'INSUFFICIENT_SCREENSHOTS',
  'VIDEO_MISSING',
  'VIDEO_EMPTY',
  'VIDEO_PROBE_FAILED',
  'VIDEO_METADATA_INVALID',
  'VIDEO_TOO_SHORT',
  'VIDEO_TOO_LONG',
  'SCREENSHOT_MISSING',
  'SCREENSHOT_EMPTY',
  'FRAME_PROCESS_FAILED',
  'FRAME_MISMATCH',
  'CONTACT_SHEET_PROCESS_FAILED',
  'CONTACT_SHEET_MISSING',
  'CONTACT_SHEET_EMPTY',
  'HASH_FAILED',
  'MEDIA_IO_FAILED',
] as const;

export type MediaReasonCode = (typeof mediaReasonCodes)[number];

export interface MediaMilestoneScreenshot {
  stepId: string;
  path: string;
  timestampMs: number;
}

export interface MediaValidationInput {
  videoPath: string;
  rehearsalDurationMs: number;
  screenshots: readonly MediaMilestoneScreenshot[];
  contactSheetPath: string;
  threshold?: number;
  scratchRoot?: string;
}

export type MediaValidationResult =
  | {
      ok: true;
      video: ProofVideo;
      screenshots: ProofScreenshot[];
      frameMatches: ProofFrameMatch[];
      contactSheet: ProofContactSheet;
    }
  | {
      ok: false;
      reasons: MediaReasonCode[];
    };

export interface MatchScreenshotInput {
  videoPath: string;
  screenshot: ProofScreenshot;
  threshold?: number;
  scratchDir: string;
  index?: number;
}

export interface ScreenshotMatchResult {
  frameMatch: ProofFrameMatch;
  selectedFramePath: string;
}

class MediaFailure extends Error {
  readonly reason: MediaReasonCode;

  constructor(reason: MediaReasonCode) {
    super(reason);
    this.name = 'MediaFailure';
    this.reason = reason;
  }
}

function fail(reason: MediaReasonCode): never {
  throw new MediaFailure(reason);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function requireNonEmptyFile(
  path: string,
  missingReason: MediaReasonCode,
  emptyReason: MediaReasonCode,
): Promise<{ size: number }> {
  try {
    const details = await stat(path);
    if (!details.isFile()) fail(missingReason);
    if (details.size <= 0) fail(emptyReason);
    return { size: details.size };
  } catch (error) {
    if (error instanceof MediaFailure) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') fail(missingReason);
    fail('MEDIA_IO_FAILED');
  }
}

async function hashAcceptedFile(path: string): Promise<string> {
  try {
    return await sha256File(path);
  } catch {
    fail('HASH_FAILED');
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function readVideoMetadata(metadata: unknown): {
  durationMs: number;
  codec: string;
  width: number;
  height: number;
} {
  if (!metadata || typeof metadata !== 'object') fail('VIDEO_METADATA_INVALID');
  const format = 'format' in metadata ? metadata.format : null;
  const streams = 'streams' in metadata ? metadata.streams : null;
  if (!format || typeof format !== 'object' || !Array.isArray(streams)) {
    fail('VIDEO_METADATA_INVALID');
  }

  const rawDuration = 'duration' in format ? format.duration : undefined;
  const durationSeconds =
    typeof rawDuration === 'string' || typeof rawDuration === 'number'
      ? Number(rawDuration)
      : Number.NaN;
  const videoStream = streams.find(
    (stream) =>
      stream !== null &&
      typeof stream === 'object' &&
      'codec_name' in stream &&
      typeof stream.codec_name === 'string' &&
      stream.codec_name.length > 0 &&
      'width' in stream &&
      Number.isInteger(stream.width) &&
      Number(stream.width) > 0 &&
      'height' in stream &&
      Number.isInteger(stream.height) &&
      Number(stream.height) > 0,
  );

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !videoStream) {
    fail('VIDEO_METADATA_INVALID');
  }

  return {
    durationMs: Math.round(durationSeconds * 1000),
    codec: String(videoStream.codec_name),
    width: Number(videoStream.width),
    height: Number(videoStream.height),
  };
}

export async function probeVideo(process: MediaProcess, videoPath: string): Promise<ProofVideo> {
  const file = await requireNonEmptyFile(videoPath, 'VIDEO_MISSING', 'VIDEO_EMPTY');
  let stdout: string;
  try {
    ({ stdout } = await process.run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=codec_name,width,height',
      '-of',
      'json',
      videoPath,
    ]));
  } catch {
    fail('VIDEO_PROBE_FAILED');
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(stdout);
  } catch {
    fail('VIDEO_METADATA_INVALID');
  }
  const decoded = readVideoMetadata(metadata);

  return {
    path: videoPath,
    sha256: await hashAcceptedFile(videoPath),
    durationMs: decoded.durationMs,
    sizeBytes: file.size,
    codec: decoded.codec,
    width: decoded.width,
    height: decoded.height,
  };
}

function validateThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    fail('INVALID_MEDIA_INPUT');
  }
}

async function runFrameProcess(
  process: MediaProcess,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await process.run('ffmpeg', args);
  } catch {
    fail('FRAME_PROCESS_FAILED');
  }
}

function parseSsim(output: string): number {
  const tokens = [...output.matchAll(/\bAll:([^\s]+)/g)];
  const token = tokens.at(-1)?.[1];
  if (!token || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(token)) fail('FRAME_MISMATCH');
  return Number(token);
}

export async function matchScreenshotAt(
  process: MediaProcess,
  input: MatchScreenshotInput,
): Promise<ScreenshotMatchResult> {
  const threshold = input.threshold ?? 0.9;
  validateThreshold(threshold);
  await requireNonEmptyFile(input.screenshot.path, 'SCREENSHOT_MISSING', 'SCREENSHOT_EMPTY');
  try {
    await mkdir(input.scratchDir, { recursive: true });
  } catch {
    fail('MEDIA_IO_FAILED');
  }

  const index = input.index ?? 0;
  if (!Number.isInteger(index) || index < 0) fail('INVALID_MEDIA_INPUT');
  const normalizedScreenshotPath = join(input.scratchDir, `screenshot-${index}.png`);
  await rm(normalizedScreenshotPath, { force: true });
  await runFrameProcess(process, [
    '-y',
    '-i',
    input.screenshot.path,
    '-vf',
    'scale=800:-2:flags=lanczos',
    '-frames:v',
    '1',
    normalizedScreenshotPath,
  ]);
  await requireNonEmptyFile(
    normalizedScreenshotPath,
    'FRAME_PROCESS_FAILED',
    'FRAME_PROCESS_FAILED',
  );

  const sampleTimestamps = [
    Math.max(0, input.screenshot.timestampMs - 500),
    input.screenshot.timestampMs,
    input.screenshot.timestampMs + 500,
  ];
  let best: { score: number; timestampMs: number; framePath: string } | null = null;

  for (const [sampleIndex, timestampMs] of sampleTimestamps.entries()) {
    const framePath = join(input.scratchDir, `frame-${index}-${sampleIndex}.jpg`);
    await rm(framePath, { force: true });
    await runFrameProcess(process, [
      '-y',
      '-ss',
      (timestampMs / 1000).toFixed(3),
      '-i',
      input.videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=800:-2:flags=lanczos',
      '-q:v',
      '2',
      framePath,
    ]);
    await requireNonEmptyFile(framePath, 'FRAME_PROCESS_FAILED', 'FRAME_PROCESS_FAILED');

    const comparison = await runFrameProcess(process, [
      '-i',
      normalizedScreenshotPath,
      '-i',
      framePath,
      '-lavfi',
      'ssim',
      '-f',
      'null',
      '-',
    ]);
    const score = parseSsim(`${comparison.stdout}\n${comparison.stderr}`);
    if (!best || score > best.score) best = { score, timestampMs, framePath };
  }

  if (!best || best.score < threshold) fail('FRAME_MISMATCH');
  return {
    frameMatch: {
      stepId: input.screenshot.stepId,
      screenshotSha256: input.screenshot.sha256,
      videoTimestampMs: best.timestampMs,
      score: best.score,
    },
    selectedFramePath: best.framePath,
  };
}

function contactSheetLayout(frameCount: number): string {
  const columns = Math.ceil(Math.sqrt(frameCount));
  return Array.from({ length: frameCount }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column === 0 ? '0' : Array.from({ length: column }, (_, i) => `w${i}`).join('+');
    const y = row === 0 ? '0' : Array.from({ length: row }, (_, i) => `h${i * columns}`).join('+');
    return `${x}_${y}`;
  }).join('|');
}

export async function buildContactSheet(
  process: MediaProcess,
  selectedFramePaths: readonly string[],
  contactSheetPath: string,
): Promise<ProofContactSheet> {
  if (selectedFramePaths.length === 0 || contactSheetPath.length === 0) {
    fail('INVALID_MEDIA_INPUT');
  }
  for (const path of selectedFramePaths) {
    await requireNonEmptyFile(path, 'FRAME_PROCESS_FAILED', 'FRAME_PROCESS_FAILED');
  }

  try {
    await mkdir(dirname(contactSheetPath), { recursive: true });
    await rm(contactSheetPath, { force: true });
  } catch {
    fail('MEDIA_IO_FAILED');
  }

  const inputs = selectedFramePaths.flatMap((path) => ['-i', path]);
  const labels = selectedFramePaths.map((_, index) => `[${index}:v]`).join('');
  const filter = `${labels}xstack=inputs=${selectedFramePaths.length}:layout=${contactSheetLayout(selectedFramePaths.length)}:fill=black[out]`;
  try {
    await process.run('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      contactSheetPath,
    ]);
  } catch {
    fail('CONTACT_SHEET_PROCESS_FAILED');
  }

  await requireNonEmptyFile(contactSheetPath, 'CONTACT_SHEET_MISSING', 'CONTACT_SHEET_EMPTY');
  return { path: contactSheetPath, sha256: await hashAcceptedFile(contactSheetPath) };
}

function validateInput(input: MediaValidationInput, threshold: number): void {
  validateThreshold(threshold);
  if (
    input.videoPath.length === 0 ||
    input.contactSheetPath.length === 0 ||
    !Number.isFinite(input.rehearsalDurationMs) ||
    input.rehearsalDurationMs < 0 ||
    input.screenshots.some(
      (screenshot) =>
        screenshot.stepId.length === 0 ||
        screenshot.path.length === 0 ||
        !Number.isFinite(screenshot.timestampMs) ||
        screenshot.timestampMs < 0,
    )
  ) {
    fail('INVALID_MEDIA_INPUT');
  }
  if (input.screenshots.length < 3) fail('INSUFFICIENT_SCREENSHOTS');
}

export async function validateMedia(
  process: MediaProcess,
  input: MediaValidationInput,
): Promise<MediaValidationResult> {
  let scratchDir: string | null = null;
  try {
    const threshold = input.threshold ?? 0.9;
    validateInput(input, threshold);
    const video = await probeVideo(process, input.videoPath);
    const bounds = durationBounds(input.rehearsalDurationMs);
    if (video.durationMs < bounds.minimumMs) fail('VIDEO_TOO_SHORT');
    if (video.durationMs > bounds.maximumMs) fail('VIDEO_TOO_LONG');

    const scratchRoot = input.scratchRoot ?? tmpdir();
    try {
      await mkdir(scratchRoot, { recursive: true });
      scratchDir = await mkdtemp(join(scratchRoot, 'proof-media-'));
    } catch {
      fail('MEDIA_IO_FAILED');
    }

    const screenshots: ProofScreenshot[] = [];
    const frameMatches: ProofFrameMatch[] = [];
    const selectedFramePaths: string[] = [];
    for (const [index, milestone] of input.screenshots.entries()) {
      await requireNonEmptyFile(milestone.path, 'SCREENSHOT_MISSING', 'SCREENSHOT_EMPTY');
      const screenshot: ProofScreenshot = {
        ...milestone,
        sha256: await hashAcceptedFile(milestone.path),
      };
      const match = await matchScreenshotAt(process, {
        videoPath: input.videoPath,
        screenshot,
        threshold,
        scratchDir,
        index,
      });
      screenshots.push(screenshot);
      frameMatches.push(match.frameMatch);
      selectedFramePaths.push(match.selectedFramePath);
    }

    const contactSheet = await buildContactSheet(
      process,
      selectedFramePaths,
      input.contactSheetPath,
    );
    return { ok: true, video, screenshots, frameMatches, contactSheet };
  } catch (error) {
    const reason = error instanceof MediaFailure ? error.reason : 'MEDIA_IO_FAILED';
    return { ok: false, reasons: [reason] };
  } finally {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
