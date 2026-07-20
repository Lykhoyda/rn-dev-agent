import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function text(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

test('Codex launcher bypasses the process-wide bridge lock without changing app cwd', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rn-gh590-'));
  const probe = join(temp, 'probe.json');
  const supervisor = join(temp, 'supervisor.mjs');
  await writeFile(
    supervisor,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PROBE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'packages/codex-plugin/bin/cdp-supervisor.js'), '--probe'],
      {
        cwd: temp,
        env: {
          ...process.env,
          PROBE: probe,
          RN_DEV_AGENT_CORE_SUPERVISOR: supervisor,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(await readFile(probe, 'utf8')) as {
      argv: string[];
      cwd: string;
    };
    assert.deepEqual(observed.argv, ['--no-lock', '--probe']);
    assert.equal(observed.cwd, realpathSync(temp));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Codex ships a discoverable feedback skill and package-local collector', async () => {
  const [
    canonicalSkill,
    codexSkill,
    canonicalCollector,
    codexCollector,
    claudeCollector,
    command,
  ] = await Promise.all([
    text('packages/shared-agent-knowledge/skills/sending-feedback/SKILL.md'),
    text('packages/codex-plugin/skills/sending-feedback/SKILL.md'),
    text('scripts/collect-feedback.sh'),
    text('packages/codex-plugin/scripts/collect-feedback.sh'),
    text('packages/claude-plugin/scripts/collect-feedback.sh'),
    text('packages/codex-plugin/commands/send-feedback.md'),
  ]);

  assert.equal(codexSkill, canonicalSkill);
  assert.equal(codexCollector, canonicalCollector);
  assert.equal(claudeCollector, canonicalCollector);
  assert.match(codexSkill, /^name: sending-feedback$/m);
  assert.match(
    command,
    /\$\{RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-\$\{CODEX_PLUGIN_ROOT:-\$\{CLAUDE_PLUGIN_ROOT:-\}\}\}/,
  );
  assert.match(command, /plugins\/cache/);
  assert.match(command, /\| sort -V \| tail -n 1/);
  assert.doesNotMatch(command, /-print -quit/);
  assert.match(command, /scripts\/collect-feedback\.sh/);
});
