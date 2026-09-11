import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

test('qa-pr workflow is registered and parent-session-only', () => {
  const sourceMap = JSON.parse(
    readFileSync(join(root, 'packages/shared-agent-knowledge/source-map.json'), 'utf8'),
  ) as {
    hostAdaptations: { codex: { commandSkills: string[]; adaptedCommands: string[] } };
  };
  assert.equal(sourceMap.hostAdaptations.codex.commandSkills.includes('qa-pr'), true);
  assert.equal(sourceMap.hostAdaptations.codex.adaptedCommands.includes('qa-pr'), true);

  const agent = readFileSync(
    join(root, 'packages/shared-agent-knowledge/agents/rn-pr-qa.md'),
    'utf8',
  );
  assert.match(agent, /PARENT-SESSION-ONLY/);
  assert.match(agent, /gh pr view/);
  assert.match(agent, /bind_device/);
  assert.match(agent, /isolated/);
  assert.match(agent, /gh pr comment/);
  assert.match(agent, /--attach/);
  assert.match(agent, /width="720"/);
  assert.match(agent, /!\[\]\(/);

  const sharedCommand = readFileSync(
    join(root, 'packages/shared-agent-knowledge/commands/qa-pr.md'),
    'utf8',
  );
  assert.match(sharedCommand, /--attach/);
  assert.match(sharedCommand, /width="720"/);

  for (const host of ['shared-agent-knowledge', 'claude-plugin', 'codex-plugin'] as const) {
    const command = join(root, 'packages', host, 'commands/qa-pr.md');
    const agentPath = join(
      root,
      'packages',
      host === 'shared-agent-knowledge' ? 'shared-agent-knowledge' : host,
      'agents/rn-pr-qa.md',
    );
    assert.equal(existsSync(command), true, command);
    assert.equal(existsSync(agentPath), true, agentPath);
    assert.match(readFileSync(command, 'utf8'), /--attach/);
  }

  const claudeManifest = JSON.parse(
    readFileSync(join(root, 'packages/claude-plugin/.claude-plugin/plugin.json'), 'utf8'),
  ) as { agents: string[]; commands: string[] };
  assert.equal(claudeManifest.agents.includes('./agents/rn-pr-qa.md'), true);
  assert.equal(claudeManifest.commands.includes('./commands/qa-pr.md'), true);
});
