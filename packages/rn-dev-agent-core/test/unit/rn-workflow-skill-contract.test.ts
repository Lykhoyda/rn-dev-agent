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
const CLAUDE_MANIFESTS = [
  join(REPO_ROOT, 'packages', 'claude-plugin', '.claude-plugin', 'plugin.json'),
  join(REPO_ROOT, 'packages', 'claude-plugin', 'plugin.json'),
];

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
    assert.match(skill, /fresh\s+non-blocked operational projection/);
    assert.ok(skill.includes('for example `source_bound`'));
    assert.ok(skill.includes('PROJECT_MANIFEST_INVALID'));
    assert.ok(skill.includes('PACKAGE_MANAGER_UNSUPPORTED'));
    assert.doesNotMatch(skill, /or any not-ready projection/);
    assert.doesNotMatch(skill, /require the\s+ready projection/);
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

test('claude manifests list exactly the shipped skills and commands', () => {
  const shipped = readdirSync(join(REPO_ROOT, 'packages', 'claude-plugin', 'skills'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `./skills/${entry.name}`);
  const commands = readdirSync(join(REPO_ROOT, 'packages', 'claude-plugin', 'commands'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `./commands/${entry.name}`);
  for (const path of CLAUDE_MANIFESTS) {
    const manifest = JSON.parse(read(path)) as { skills: string[]; commands: string[] };
    assert.deepEqual(new Set(manifest.skills), new Set(shipped), `${path}: skill inventory`);
    assert.deepEqual(new Set(manifest.commands), new Set(commands), `${path}: command inventory`);
  }
});
