import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
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

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-body-security-')));
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
    '# Proof\n\nA recorded journey.\n\n## Deviations\nCadence normalization skipped.\n',
  );
  const generate = (path = proof) =>
    run('bash', [script, path], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return { root, bin, proof, generate, output: join(proof, 'PR-BODY.md') };
}

test('PR body publication preserves ordinary absolute and relative directory usage', async (t) => {
  const { proof, output, generate } = await fixture(t);
  await generate(`${proof}/`);
  const body = await readFile(output, 'utf8');
  assert.match(body, /A recorded journey\./);
  assert.match(body, /### Recording Notes\n\nCadence normalization skipped\./);
  await writeFile(output, 'old output');
  await generate('./proof with spaces/../proof with spaces/');
  assert.equal(await readFile(output, 'utf8'), body);
  assert.deepEqual((await readdir(proof)).sort(), ['PR-BODY.md', 'PROOF.md']);
});

test('PR body publication refuses existing and dangling destination symlinks', async (t) => {
  const { root, proof, output, generate } = await fixture(t);
  const victim = join(root, 'victim');
  for (const exists of [true, false]) {
    if (exists) await writeFile(victim, 'unchanged');
    await symlink(victim, output);
    await assert.rejects(generate(), /cannot safely publish PR body/);
    if (exists) assert.equal(await readFile(victim, 'utf8'), 'unchanged');
    else await assert.rejects(readFile(victim), { code: 'ENOENT' });
    assert.deepEqual((await readdir(proof)).sort(), ['PR-BODY.md', 'PROOF.md']);
    await rm(output);
    await rm(victim, { force: true });
  }
});

test('PR body publication refuses symlinked path components without normalizing them away', async (t) => {
  const { root, proof, output, generate } = await fixture(t);
  await symlink(proof, join(root, 'alias'));
  await symlink(root, join(root, 'ancestor'));
  for (const path of [
    'alias',
    'alias/',
    'ancestor/proof with spaces',
    'alias/../proof with spaces',
  ]) {
    await assert.rejects(generate(path), /cannot safely publish PR body/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('PR body publication replaces a hardlink without changing its other file', async (t) => {
  const { root, output, generate } = await fixture(t);
  const victim = join(root, 'victim');
  await writeFile(victim, 'unchanged');
  await link(victim, output);
  await generate();
  assert.equal(await readFile(victim, 'utf8'), 'unchanged');
  assert.match(await readFile(output, 'utf8'), /A recorded journey\./);
});

test('PR body publication refuses an ancestor swapped to a symlink while rendering', async (t) => {
  const { root, bin, proof, generate } = await fixture(t);
  const moved = join(root, 'moved');
  await writeFile(
    join(bin, 'xcrun'),
    `#!/bin/sh\nmv 'proof with spaces' moved\nln -s moved 'proof with spaces'\nexit 1\n`,
  );
  await assert.rejects(generate(), /cannot safely publish PR body/);
  await assert.rejects(readFile(join(moved, 'PR-BODY.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(proof, 'PR-BODY.md')), { code: 'ENOENT' });
});

test('PR body generation failure leaves the existing output intact', async (t) => {
  const { bin, output, generate } = await fixture(t);
  await writeFile(output, 'old output');
  await writeFile(join(bin, 'awk'), '#!/bin/sh\nexit 1\n');
  await chmod(join(bin, 'awk'), 0o755);
  await assert.rejects(generate());
  assert.equal(await readFile(output, 'utf8'), 'old output');
});
