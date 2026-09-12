import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function finalize(input: string, output: string) {
  await run('bash', [
    '-c',
    'source "$1"; normalize_capture_video "$2" "$3"',
    '_',
    script,
    input,
    output,
  ]);
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

test('proof re-encode caps the short edge at 720 px and never upscales', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-scale-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [width, height] of [
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
    const scaled = await probeSize(output);
    const shortEdge = Math.min(scaled.width, scaled.height);
    assert.equal(shortEdge, Math.min(720, Math.min(width, height)));
    assert.equal(scaled.width % 2, 0);
    assert.equal(scaled.height % 2, 0);
    assert.ok(Math.abs(scaled.width / scaled.height - width / height) < 0.01);
  }
});

test('invalid native video refuses cadence normalization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'invalid.mp4');
  await writeFile(input, 'not a recording');
  await assert.rejects(finalize(input, join(root, 'proof.mp4')));
});
