import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/generate_pr_body.sh',
);

async function fixture(t: test.TestContext, deviations: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-body-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const proof = join(root, 'proof with spaces');
  await mkdir(bin);
  await mkdir(proof);
  for (const tool of ['xcrun', 'adb']) {
    await writeFile(join(bin, tool), '#!/bin/sh\nexit 1\n');
    await chmod(join(bin, tool), 0o755);
  }
  await writeFile(
    join(proof, 'PROOF.md'),
    `# Proof\n\nA recorded journey.\n\n## Deviations\n\n${deviations}\n`,
  );
  const generate = (path = proof) =>
    run('bash', [script, path], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return { root, bin, proof, generate, output: join(proof, 'PR-BODY.md') };
}

test('recording warnings under ## Deviations reach the PR body', async (t) => {
  const { proof, output, generate } = await fixture(t, '- Cadence normalization skipped.');
  await generate(`${proof}/`);
  const body = await readFile(output, 'utf8');
  assert.match(body, /A recorded journey\./);
  assert.match(body, /### Recording Notes\n\n- Cadence normalization skipped\./);
  await generate('./proof with spaces/../proof with spaces/');
  assert.equal(await readFile(output, 'utf8'), body);
  assert.deepEqual((await readdir(proof)).sort(), ['PR-BODY.md', 'PROOF.md']);
});

test('a none-only Deviations section emits no Recording Notes', async (t) => {
  const { output, generate } = await fixture(t, '- None');
  await generate();
  assert.doesNotMatch(await readFile(output, 'utf8'), /Recording Notes/);
});

test('a none line followed by a real warning still emits Recording Notes', async (t) => {
  const { output, generate } = await fixture(
    t,
    '- None\n- Proof video averages 0.22 fps and may play as a slideshow.',
  );
  await generate();
  assert.match(await readFile(output, 'utf8'), /### Recording Notes\n\n- None\n- Proof video/);
});

test('a none line carrying a real warning still emits Recording Notes', async (t) => {
  const { output, generate } = await fixture(
    t,
    'None for the flow itself; the proof video averages 0.22 fps and may play as a slideshow.',
  );
  await generate();
  assert.match(
    await readFile(output, 'utf8'),
    /### Recording Notes\n\nNone for the flow itself; the proof video averages 0\.22 fps/,
  );
});

test('PR body generation failure leaves the existing output intact', async (t) => {
  const { bin, output, generate } = await fixture(t, '- None');
  await writeFile(output, 'old output');
  await writeFile(join(bin, 'awk'), '#!/bin/sh\nexit 1\n');
  await chmod(join(bin, 'awk'), 0o755);
  await assert.rejects(generate());
  assert.equal(await readFile(output, 'utf8'), 'old output');
});
