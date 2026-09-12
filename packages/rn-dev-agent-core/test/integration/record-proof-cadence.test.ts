import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/record_proof.sh');

async function probe(path: string) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=duration,nb_read_frames,r_frame_rate,codec_name:format=size',
    '-of',
    'json',
    path,
  ]);
  const data = JSON.parse(stdout) as {
    streams: {
      duration: string;
      nb_read_frames: string;
      r_frame_rate: string;
      codec_name: string;
    }[];
    format: { size: string };
  };
  return { ...data.streams[0], size: Number(data.format.size) };
}

async function finalize(input: string, output: string, pathPrefix?: string) {
  return run(
    'bash',
    ['-c', 'source "$1"; normalize_capture_video "$2" "$3"', '_', script, input, output],
    pathPrefix ? { env: { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` } } : undefined,
  );
}

test('native sparse timestamps become bounded 30 fps video without losing motion or duration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'native.mp4');
  const output = join(root, 'proof.mp4');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x320:rate=30:duration=120',
    '-vf',
    "select='eq(n,0)+between(n,900,929)+eq(n,1800)+eq(n,3599)'",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-bf',
    '0',
    input,
  ]);
  const native = await probe(input);
  assert.equal(Number(native.nb_read_frames), 33);
  await finalize(input, output);
  const finalized = await probe(output);
  assert.equal(finalized.codec_name, 'h264');
  assert.equal(finalized.r_frame_rate, '30/1');
  assert.equal(Number(finalized.nb_read_frames), 3600);
  assert.ok(Math.abs(Number(finalized.duration) - Number(native.duration)) < 1 / 30);
  assert.ok(finalized.size < 5 * 1024 * 1024);

  const { stdout: frames } = await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    '30',
    '-i',
    output,
    '-t',
    '1',
    '-f',
    'framemd5',
    '-',
  ]);
  const hashes = frames.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(hashes.length, 30);
  assert.ok(new Set(hashes.map((line) => line.split(',').at(-1)?.trim())).size >= 25);

  const compressed = join(root, 'compressed.mp4');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    output,
    '-map_metadata',
    '-1',
    '-map',
    '0:v',
    '-vf',
    'scale=80:-2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '26',
    '-movflags',
    '+faststart',
    compressed,
  ]);
  const reprobed = await probe(compressed);
  assert.equal(Number(reprobed.nb_read_frames), 3600);
  assert.equal(Number(reprobed.duration), Number(finalized.duration));
});

async function probeSize(path: string) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    path,
  ]);
  const [width, height] = stdout.trim().split(',').map(Number);
  return { width, height };
}

async function normalizedFrameSize(root: string, source: string) {
  const frame = join(root, `normalized-${basename(source)}.png`);
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    'scale=800:-2',
    frame,
  ]);
  return probeSize(frame);
}

test('proof re-encode keeps the capture resolution so screenshot matching stays aligned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-scale-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [width, height] of [
    [1284, 2778],
    [1668, 2388],
    [1179, 2556],
    [2556, 1179],
    [160, 320],
  ]) {
    const input = join(root, `native-${width}x${height}.mp4`);
    const output = join(root, `proof-${width}x${height}.mp4`);
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=30:duration=1`,
      '-c:v',
      'libx264',
      input,
    ]);
    await finalize(input, output);

    assert.deepEqual(await probeSize(output), await probeSize(input));
    assert.deepEqual(
      await normalizedFrameSize(root, output),
      await normalizedFrameSize(root, input),
    );
  }
});

async function shimDir(root: string, shims: Record<string, string>) {
  const dir = join(root, 'shims');
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(shims)) {
    const file = join(dir, name);
    await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
    await chmod(file, 0o755);
  }
  return dir;
}

async function sparseCapture(path: string) {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x320:rate=30:duration=4',
    '-vf',
    "select='eq(n,0)+eq(n,60)+eq(n,119)'",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-bf',
    '0',
    path,
  ]);
}

test('a capture still becomes mp4 when cadence normalization cannot run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'native.mp4');
  await sparseCapture(input);
  const native = await probe(input);
  const realFfmpeg = (await run('bash', ['-c', 'command -v ffmpeg'])).stdout.trim();

  const scenarios = {
    'no-ffprobe': {
      dir: await shimDir(join(root, 'no-ffprobe'), { ffprobe: 'exit 127' }),
      reason: /duration unreadable/,
    },
    'no-libx264': {
      dir: await shimDir(join(root, 'no-libx264'), {
        ffmpeg: `for arg in "$@"; do [ "$arg" = libx264 ] && exit 1; done\nexec ${realFfmpeg} "$@"`,
      }),
      reason: /re-encode failed/,
    },
  };

  for (const [name, { dir, reason }] of Object.entries(scenarios)) {
    const output = join(root, `proof-${name}.mp4`);
    const { stdout, stderr } = await finalize(input, output, dir);

    assert.match(stdout, /^Cadence normalization skipped: .+$/m);
    assert.match(stdout, reason);
    assert.match(stderr, /cadence normalization unavailable/);
    const remuxed = await probe(output);
    assert.equal(remuxed.codec_name, 'h264');
    assert.equal(Number(remuxed.nb_read_frames), Number(native.nb_read_frames));
    assert.ok(Math.abs(Number(remuxed.duration) - Number(native.duration)) < 0.1);
  }
});

test('invalid native video refuses cadence normalization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'invalid.mp4');
  await writeFile(input, 'not a recording');
  await assert.rejects(finalize(input, join(root, 'proof.mp4')));
});
