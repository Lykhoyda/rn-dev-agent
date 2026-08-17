// GH#525 finding 4: plugin versions 0.66.0–0.66.2 shipped a send-feedback
// skill that instructed running rn-collect-feedback / collect-feedback.sh
// while the script was absent from the package (dropped in the #500 workspace
// split, restored in #605). Pin the contract per host: the collector ships
// executable at the path each packaged workflow resolves, relative collector
// and workflow references resolve to real files inside their own package,
// bare rn-collect-feedback invocations stay inside the command -v guarded
// fallback, and the shipped resolution snippet — executed with bash — runs the
// packaged collector when only the Claude plugin root is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

const CLAUDE_PKG = join(REPO_ROOT, 'packages', 'claude-plugin');
const CODEX_PKG = join(REPO_ROOT, 'packages', 'codex-plugin');
const CANONICAL_SKILLS = join(REPO_ROOT, 'packages', 'shared-agent-knowledge', 'skills');

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

test('#525 each host package ships an executable scripts/collect-feedback.sh', () => {
  for (const pkg of [CLAUDE_PKG, CODEX_PKG]) {
    const script = join(pkg, 'scripts', 'collect-feedback.sh');
    assert.ok(fs.existsSync(script), `${script} must exist`);
    const mode = fs.statSync(script).mode;
    assert.ok(mode & 0o111, `${script} must be executable`);
  }
});

test('#525 relative collector references in packaged docs resolve to files in the same package', () => {
  for (const pkg of [CLAUDE_PKG, CODEX_PKG]) {
    const docs = [...walkMarkdown(join(pkg, 'commands')), ...walkMarkdown(join(pkg, 'skills'))];
    let sawReference = false;
    for (const doc of docs) {
      const text = fs.readFileSync(doc, 'utf8');
      const refs = (text.match(/[\w$<>{}./-]*collect-feedback\.sh/g) ?? []).filter((r) =>
        r.includes('/'),
      );
      for (const ref of refs) {
        sawReference = true;
        let target: string;
        if (ref.startsWith('../') || ref.startsWith('./')) {
          target = resolve(dirname(doc), ref);
        } else {
          // Normalize every supported root placeholder to the package dir so
          // a reference like $PLUGIN_ROOT/wrong/collect-feedback.sh fails.
          const normalized = ref
            .replace(
              /^\$\{?(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|RN_DEV_AGENT_CODEX_PLUGIN_ROOT|CODEX_PLUGIN_ROOT)\}?\//,
              '',
            )
            .replace(/^<package-root>\//, '');
          target = resolve(pkg, normalized);
        }
        assert.ok(fs.existsSync(target), `${doc} references missing collector at ${ref}`);
        assert.ok(
          target.startsWith(pkg + '/'),
          `${doc} collector reference ${ref} escapes its package`,
        );
      }
    }
    assert.ok(sawReference, `expected at least one packaged collector reference in ${pkg}`);
  }
});

function collectorSnippet(command: string): string {
  const block = (fs.readFileSync(command, 'utf8').match(/```bash\n([\s\S]*?)```/g) ?? []).find(
    (b) => b.includes('collect-feedback.sh'),
  );
  assert.ok(block, `${command} must ship a bash collector-resolution snippet`);
  return block.replace(/^```bash\n/, '').replace(/```$/, '');
}

function runSnippet(
  snippet: string,
  opts: { cwd: string; env: Record<string, string> },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', snippet], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: opts.cwd, ...opts.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeFixture(prefix: string): { root: string; pluginRoot: string; projectRoot: string } {
  const root = fs.mkdtempSync(join(tmpdir(), prefix));
  const pluginRoot = join(root, 'plugin');
  const projectRoot = join(root, 'project');
  fs.mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    join(pluginRoot, 'scripts', 'collect-feedback.sh'),
    '#!/bin/sh\necho "PACKAGED_COLLECTOR cwd=$PWD"\n',
    { mode: 0o755 },
  );
  return { root, pluginRoot, projectRoot };
}

// The Step 2 snippet is executable shell shipped to the agent, so run it with
// bash and observe which collector it actually invokes.
test('#525 the Claude workflow snippet runs the packaged collector from the plugin root', () => {
  const snippet = collectorSnippet(join(CLAUDE_PKG, 'commands', 'send-feedback.md'));
  const { root, pluginRoot, projectRoot } = makeFixture('rn-agent-gh525-claude-');
  try {
    const run = runSnippet(snippet, {
      cwd: root,
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot, RN_PROJECT_ROOT: projectRoot },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      /PACKAGED_COLLECTOR/,
      'must run <plugin root>/scripts/collect-feedback.sh',
    );
    assert.ok(
      run.stdout.includes(`cwd=${projectRoot}\n`),
      `must run the collector from the project root, got: ${run.stdout}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#525 the workflow snippet falls back to rn-collect-feedback only when no packaged collector resolves', () => {
  const snippet = collectorSnippet(join(CLAUDE_PKG, 'commands', 'send-feedback.md'));
  const { root, projectRoot } = makeFixture('rn-agent-gh525-fallback-');
  try {
    const bin = join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(join(bin, 'rn-collect-feedback'), '#!/bin/sh\necho LEGACY_FALLBACK\n', {
      mode: 0o755,
    });
    const env = { CODEX_HOME: join(root, 'empty-codex') };
    const withFallback = runSnippet(snippet, {
      cwd: root,
      env: { ...env, RN_PROJECT_ROOT: projectRoot, PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(withFallback.status, 0, withFallback.stderr);
    assert.match(withFallback.stdout, /LEGACY_FALLBACK/);

    const withNothing = runSnippet(snippet, {
      cwd: root,
      env: { ...env, RN_PROJECT_ROOT: projectRoot },
    });
    assert.equal(withNothing.status, 1, 'a missing collector must fail closed');
    assert.match(withNothing.stderr, /collector is missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#525 the Codex workflow resolves the collector package-relative, as documented', () => {
  const command = join(CODEX_PKG, 'commands', 'send-feedback.md');
  assert.match(
    fs.readFileSync(command, 'utf8'),
    /<package-root>\/scripts\/collect-feedback\.sh/,
    `${command} must document the package-root collector`,
  );
  const skill = join(CODEX_PKG, 'skills', 'sending-feedback', 'SKILL.md');
  const skillText = fs.readFileSync(skill, 'utf8');
  assert.match(
    skillText,
    /\.\.\/\.\.\/scripts\/collect-feedback\.sh/,
    `${skill} must resolve the collector relative to the skill`,
  );
});

test('#525 bare rn-collect-feedback invocations appear only after a command -v guard in the same code block', () => {
  for (const pkg of [CLAUDE_PKG, CODEX_PKG]) {
    for (const doc of [
      ...walkMarkdown(join(pkg, 'commands')),
      ...walkMarkdown(join(pkg, 'skills')),
    ]) {
      const text = fs.readFileSync(doc, 'utf8');
      const blocks = text.match(/```[^\n]*\n[\s\S]*?```/g) ?? [];
      for (const block of blocks) {
        const lines = block.split('\n');
        // The only supported shape is the guarded fallback branch:
        //   elif command -v rn-collect-feedback …; then
        //     … rn-collect-feedback …
        //   else|fi
        // Every rn-collect-feedback occurrence that is not the guard itself
        // must sit strictly inside that branch.
        const guardIdx = lines.findIndex((l) => /elif command -v rn-collect-feedback/.test(l));
        let branchEnd = -1;
        if (guardIdx !== -1) {
          branchEnd = lines.findIndex((l, i) => i > guardIdx && /^\s*(else\b|elif\b|fi\b)/.test(l));
          if (branchEnd === -1) branchEnd = lines.length;
        }
        lines.forEach((line, idx) => {
          if (!line.includes('rn-collect-feedback')) return;
          if (/command -v rn-collect-feedback/.test(line)) return;
          const insideGuardedBranch = guardIdx !== -1 && idx > guardIdx && idx < branchEnd;
          assert.ok(
            insideGuardedBranch,
            `${doc}: rn-collect-feedback occurrence outside the guarded fallback branch: ${line.trim()}`,
          );
        });
      }
    }
  }
});

test('#525 each packaged sending-feedback skill points at a workflow inside its own package', () => {
  for (const pkg of [CLAUDE_PKG, CODEX_PKG]) {
    const skill = join(pkg, 'skills', 'sending-feedback', 'SKILL.md');
    const text = fs.readFileSync(skill, 'utf8');
    const refs = text.match(/\.\.[\w$<>{}./-]*send-feedback\.md/g) ?? [];
    assert.ok(refs.length > 0, `${skill} must reference its host workflow`);
    for (const ref of refs) {
      const target = resolve(dirname(skill), ref);
      assert.ok(fs.existsSync(target), `${skill} references a missing workflow at ${ref}`);
      assert.ok(
        target.startsWith(pkg + '/'),
        `${skill} workflow reference ${ref} escapes its package`,
      );
    }
  }
});

// The plugin-root vocabulary is a host-resolution contract: a skill copy may
// only name the roots its own host actually exports. Tokenize the shipped
// markdown into SCREAMING_CASE identifiers and compare against that vocabulary
// rather than matching sentences.
const HOST_ROOT_ENV_VARS = [
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'RN_DEV_AGENT_CODEX_PLUGIN_ROOT',
  'CODEX_HOME',
];

function namedHostRoots(file: string): string[] {
  const identifiers = new Set(fs.readFileSync(file, 'utf8').match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []);
  return HOST_ROOT_ENV_VARS.filter((name) => identifiers.has(name)).sort();
}

test('#525 the canonical and Claude-packaged sending-feedback skill name only the Claude plugin root', () => {
  for (const skill of [
    join(CANONICAL_SKILLS, 'sending-feedback', 'SKILL.md'),
    join(CLAUDE_PKG, 'skills', 'sending-feedback', 'SKILL.md'),
  ]) {
    assert.deepEqual(
      namedHostRoots(skill),
      ['CLAUDE_PLUGIN_ROOT'],
      `${skill} must describe the Claude resolution surface only`,
    );
  }
  const codexSkill = join(CODEX_PKG, 'skills', 'sending-feedback', 'SKILL.md');
  assert.ok(
    !namedHostRoots(codexSkill).includes('CLAUDE_PLUGIN_ROOT'),
    `${codexSkill} must not describe the Claude resolution surface`,
  );
});
