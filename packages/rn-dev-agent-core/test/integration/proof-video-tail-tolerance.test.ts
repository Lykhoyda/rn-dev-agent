import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { evidenceTimingReasons } from '../../dist/tools/proof-capture.js';
import { validateMedia, type MediaProcess } from '../../dist/tools/proof-media.js';

const execFileAsync = promisify(execFile);
const mediaFailures: string[] = [];

const mediaProcess: MediaProcess = {
  async run(command, args) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      mediaFailures.push(`${command} ${args.join(' ')}\n${stderr.slice(-2_000)}`);
      throw error;
    }
  },
};

test('accepts a visually matched final screenshot within the encoded video tail tolerance', async (t) => {
  mediaFailures.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'proof-tail-tolerance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = join(root, 'proof.mp4');
  const screenshotPath = join(root, 'screen.jpg');
  const contactSheetPath = join(root, 'contact-sheet.jpg');

  await mediaProcess.run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=320x640:d=6',
    '-pix_fmt',
    'yuv420p',
    videoPath,
  ]);
  await mediaProcess.run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=320x640',
    '-frames:v',
    '1',
    screenshotPath,
  ]);

  const probe = await mediaProcess.run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    videoPath,
  ]);
  const encodedDurationMs = Math.round(
    Number((JSON.parse(probe.stdout) as { format: { duration: string } }).format.duration) * 1_000,
  );
  const timestamps = [1_000, 3_000, encodedDurationMs + 325];
  const media = await validateMedia(mediaProcess, {
    videoPath,
    rehearsalDurationMs: 7_000,
    screenshots: timestamps.map((timestampMs, index) => ({
      stepId: `step-${index + 1}`,
      path: screenshotPath,
      timestampMs,
    })),
    contactSheetPath,
    scratchRoot: root,
  });

  if (!media.ok) assert.fail(`${media.reasons.join(', ')}\n${mediaFailures.join('\n---\n')}`);
  assert.equal(media.ok, true);
  assert.ok(timestamps.at(-1)! > media.video.durationMs);
  assert.deepEqual(
    evidenceTimingReasons(
      timestamps,
      media.video.durationMs,
      timestamps.map(() => ({ expectedDwellMs: 0, maximumDwellMs: 30_000 })),
    ),
    [],
  );
});
