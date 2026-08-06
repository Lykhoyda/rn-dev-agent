// Contract guard for the rn-workflow skill surface: the three host copies
// stay synchronized, the reconciled Step 2a recovery vocabulary is present,
// replay is orchestrated (never raw maestro_run for learned actions), and the
// Claude plugin manifest lists every shipped skill directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const SHARED_SKILL = join(
  REPO_ROOT,
  'packages',
  'shared-agent-knowledge',
  'skills',
  'rn-workflow',
  'SKILL.md',
);
const CLAUDE_SKILL = join(
  REPO_ROOT,
  'packages',
  'claude-plugin',
  'skills',
  'rn-workflow',
  'SKILL.md',
);
const CODEX_SKILL = join(
  REPO_ROOT,
  'packages',
  'codex-plugin',
  'skills',
  'rn-workflow',
  'SKILL.md',
);
const SHARED_COMMAND = join(
  REPO_ROOT,
  'packages',
  'shared-agent-knowledge',
  'commands',
  'run-workflow.md',
);
const CODEX_COMMAND = join(REPO_ROOT, 'packages', 'codex-plugin', 'commands', 'run-workflow.md');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function frontmatterDescription(markdown: string): string {
  const match = markdown.match(/^description:\s*(.+)$/m);
  assert.ok(match, 'frontmatter description missing');
  return match[1].trim();
}

test('claude skill copy is byte-identical to the canonical shared source', () => {
  assert.equal(read(CLAUDE_SKILL), read(SHARED_SKILL));
  assert.equal(
    read(join(REPO_ROOT, 'packages', 'claude-plugin', 'commands', 'run-workflow.md')),
    read(SHARED_COMMAND),
  );
});

test('shared and codex command descriptions agree so the generated wrapper stays consistent', () => {
  assert.equal(
    frontmatterDescription(read(SHARED_COMMAND)),
    frontmatterDescription(read(CODEX_COMMAND)),
  );
});

test('every host copy carries the reconciled Step 2a recovery contract', () => {
  for (const path of [SHARED_SKILL, CODEX_SKILL]) {
    const skill = read(path);
    assert.ok(
      skill.includes('recoveryRequirement'),
      `${path}: recoveryRequirement vocabulary missing`,
    );
    assert.ok(
      skill.includes('sole reachable\nclassifier') || skill.includes('sole reachable classifier'),
    );
    assert.ok(skill.includes('transport-restart'));
    assert.ok(skill.includes('Discovery is read-only'));
    assert.ok(/at most ONE transport restart per\s+identical blocked projection/.test(skill));
    assert.ok(skill.includes('SESSION_AUTHORITY_REQUIRED'));
    assert.ok(skill.includes('re-read `rn_session status`'));
  }
});

test('replay authority is orchestrated: cdp_run_action only, after binding, never raw maestro_run', () => {
  for (const path of [SHARED_SKILL, CODEX_SKILL]) {
    const skill = read(path);
    assert.ok(skill.includes('only via `cdp_run_action`'));
    assert.ok(skill.includes('never raw `maestro_run`'));
    assert.ok(
      !/replay .*via `maestro_run`/.test(skill),
      `${path}: instructs raw maestro_run replay`,
    );
    const bindIndex = skill.indexOf('bind_device');
    const authorizeIndex = skill.indexOf('Only now is replay');
    assert.ok(
      bindIndex > 0 && authorizeIndex > bindIndex,
      `${path}: replay authorized before device binding`,
    );
  }
});

test('the seven contract steps appear in order in both skill bodies', () => {
  for (const path of [SHARED_SKILL, CODEX_SKILL]) {
    const skill = read(path);
    const headings = [
      '### Step 0',
      '### Step 1',
      '### Step 2 ',
      '### Step 2a',
      '### Step 3',
      '### Step 4',
      '### Step 5',
      '### Step 6',
      '### Step 7',
    ];
    let cursor = -1;
    for (const heading of headings) {
      const index = skill.indexOf(heading);
      assert.ok(index > cursor, `${path}: ${heading} missing or out of order`);
      cursor = index;
    }
  }
});

test('reverse cleanup order is stated exactly', () => {
  for (const path of [SHARED_SKILL, CODEX_SKILL]) {
    const skill = read(path);
    const close = skill.indexOf('device_snapshot action=close');
    const stopMetro = skill.indexOf('stop_metro');
    const restore = skill.indexOf('restore_integration');
    const release = skill.lastIndexOf('"release"');
    assert.ok(close > 0 && stopMetro > close && restore > stopMetro && release > restore, path);
  }
});

test('claude plugin manifest lists exactly the shipped skill directories', () => {
  const manifest = JSON.parse(
    read(join(REPO_ROOT, 'packages', 'claude-plugin', '.claude-plugin', 'plugin.json')),
  ) as { skills: string[] };
  const listed = new Set(manifest.skills.map((entry) => entry.replace('./skills/', '')));
  const shipped = readdirSync(join(REPO_ROOT, 'packages', 'claude-plugin', 'skills'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(new Set(shipped), listed);
});
