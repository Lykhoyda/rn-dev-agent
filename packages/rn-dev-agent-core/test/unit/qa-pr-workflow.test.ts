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
  assert.match(agent, /width="390"/);
  assert.doesNotMatch(agent, /width="720"/);
  assert.match(agent, /device_record\(action="start"/);
  assert.doesNotMatch(agent, /maestro_run\(flowPath=/);
  assert.match(agent, /proofReplay=true/);
  assert.match(agent, /never call `cdp_reload` or `cdp_restart`/);
  assert.doesNotMatch(agent, /Reset to the start screen/);
  assert.match(agent, /must not begin with `launchApp`/);
  assert.doesNotMatch(agent, /cdp_navigate\(screen=/);
  assert.match(agent, /else the start state\s+from the Step 6 plan/);
  assert.match(agent, /If neither names a route/);
  assert.match(agent, /RUNNER_OWNERSHIP_MISMATCH/);
  assert.match(agent, /A reused action's first\s+rehearsal starts from its first route/);
  assert.match(agent, /walk there as a\s+user, or FAIL the target at the step that cannot/);
  assert.doesNotMatch(agent, /Do not move the app before\s+that first rehearsal/);
  assert.doesNotMatch(agent, /dismissRedBox/);
  assert.doesNotMatch(agent, /before every rehearsal and/);
  assert.doesNotMatch(agent, /is the reset and happens on camera/);
  assert.match(agent, /User path only/);
  assert.match(agent, /disableDevMenu/);
  assert.match(agent, /EXDevMenuShowFloatingActionButton/);
  assert.match(agent, /one `device_back` for that/);
  assert.doesNotMatch(agent, /at most PARTIAL/);
  assert.match(agent, /NSCocoaErrorDomain 513/);
  assert.match(agent, /this step wins/);
  assert.match(agent, /proofDomain/);
  assert.doesNotMatch(agent, /A clean pass freezes the action bytes/);
  assert.match(agent, /!\[\]\(/);
  assert.match(agent, /\[HOST\]/);
  assert.match(agent, /\[MACHINE_ID\]/);
  assert.match(agent, /\[HOME\]/);
  assert.match(agent, /Public identity/);
  assert.match(agent, /before posting/);
  assert.match(agent, /Exempt only the exact Markdown/);
  assert.match(agent, /first public comment/);
  assert.match(agent, /--remove-label needs-qa/);
  assert.match(agent, /A missing label is not FAIL/);
  assert.match(agent, /human reviewer/);
  assert.match(agent, /feature that was built/);
  const step9a = agent.slice(agent.indexOf('#### 9a.'), agent.indexOf('#### 9b.'));
  assert.match(step9a, /Tested: commit/);
  assert.match(step9a, /What I tested:/);
  assert.doesNotMatch(step9a, /cdp_|proofReplay|transport/);
  assert.match(agent, /--json labels --jq '\.labels\[\]\.name'/);
  assert.match(agent, /for the session copy \(Step 9\), never the public comment/);
  assert.doesNotMatch(agent, /Report `transport`/);
  assert.match(agent, /Wherever an earlier step says to report or\s+disclose/);
  assert.doesNotMatch(agent, /Wherever Step 7 says to report/);
  const step9bTo9d = agent.slice(
    agent.indexOf('#### 9b.'),
    agent.indexOf('#### Session copy'),
  );
  const postedAt = step9bTo9d.indexOf('gh pr comment');
  const removeAt = step9bTo9d.indexOf('--remove-label needs-qa');
  assert.ok(postedAt !== -1 && removeAt !== -1 && postedAt < removeAt);
  assert.match(step9bTo9d, /never posted[\s\S]*leaves the label/);
  assert.match(step9bTo9d, /If 9c was required and\s+failed, still run 9d/);
  assert.doesNotMatch(step9a, /proofDomain/);
  assert.doesNotMatch(step9a, /cleanupProven/);
  assert.doesNotMatch(agent, /if the draft has a slash-started absolute path/);
  assert.doesNotMatch(agent, /Self-check the rewritten GitHub body after `--attach` rewrites, not/);

  const sharedCommand = readFileSync(
    join(root, 'packages/shared-agent-knowledge/commands/qa-pr.md'),
    'utf8',
  );
  assert.match(sharedCommand, /--attach/);
  assert.match(sharedCommand, /width="390"/);
  assert.doesNotMatch(sharedCommand, /width="720"/);
  assert.doesNotMatch(sharedCommand, /maestro_run/);
  assert.match(sharedCommand, /never `cdp_reload`/);
  assert.match(sharedCommand, /`launchApp` on camera/);
  assert.match(sharedCommand, /as a user/);
  assert.match(sharedCommand, /disableDevMenu/);
  assert.doesNotMatch(sharedCommand, /\(`cdp_navigate`\)/);
  assert.match(sharedCommand, /gh pr view "<pr-url>" --json headRefOid/);
  assert.match(sharedCommand, /\[HOST\]/);
  assert.match(sharedCommand, /before posting/);
  assert.match(sharedCommand, /rewritten GitHub body/);
  assert.doesNotMatch(sharedCommand, /before every `cdp_run_action` rehearsal/);
  assert.match(sharedCommand, /--remove-label needs-qa/);
  assert.match(sharedCommand, /A missing label is not FAIL/);
  assert.match(sharedCommand, /human reviewer/);
  assert.match(sharedCommand, /feature that was built/);

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
    const commandText = readFileSync(command, 'utf8');
    const agentText = readFileSync(agentPath, 'utf8');
    assert.match(commandText, /--attach/);
    assert.doesNotMatch(commandText, /maestro_run/);
    assert.match(commandText, /never `cdp_reload`/);
    assert.match(commandText, /launchApp/);
    assert.match(commandText, /width="390"/);
    assert.match(commandText, /headRefOid/);
    assert.doesNotMatch(commandText, /before every `cdp_run_action` rehearsal/);
    assert.match(commandText, /as a user/);
    assert.match(commandText, /from its first route/);
    assert.doesNotMatch(commandText, /from the screen the app is on/);
    assert.match(commandText, /disableDevMenu/);
    assert.match(commandText, /--remove-label needs-qa/);
    assert.match(commandText, /A missing label is not FAIL/);
    assert.match(commandText, /human reviewer/);
    assert.match(commandText, /feature that was built/);
    assert.match(agentText, /device_record\(action="start"/);
    assert.doesNotMatch(agentText, /maestro_run\(flowPath=/);
    assert.match(agentText, /width="390"/);
    assert.match(agentText, /gh pr view "<pr-url>" --json headRefOid/);
    assert.match(agentText, /Stop if that lookup fails/);
    assert.match(agentText, /proofReplay=true/);
    assert.match(agentText, /User path only/);
    assert.match(agentText, /--remove-label needs-qa/);
    assert.match(agentText, /A missing label is not FAIL/);
    assert.match(agentText, /human reviewer/);
    assert.match(agentText, /feature that was built/);
    const hostStep9a = agentText.slice(
      agentText.indexOf('#### 9a.'),
      agentText.indexOf('#### 9b.'),
    );
    assert.match(hostStep9a, /Tested: commit/);
    assert.doesNotMatch(hostStep9a, /cdp_|proofReplay|transport/);
    assert.doesNotMatch(hostStep9a, /proofDomain/);
    assert.doesNotMatch(hostStep9a, /cleanupProven/);
  }

  const claudeManifest = JSON.parse(
    readFileSync(join(root, 'packages/claude-plugin/.claude-plugin/plugin.json'), 'utf8'),
  ) as { agents: string[]; commands: string[] };
  assert.equal(claudeManifest.agents.includes('./agents/rn-pr-qa.md'), true);
  assert.equal(claudeManifest.commands.includes('./commands/qa-pr.md'), true);
});
