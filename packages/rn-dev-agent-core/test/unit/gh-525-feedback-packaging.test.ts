// GH#525 finding 4: plugin versions 0.66.0–0.66.2 shipped a send-feedback
// skill that instructed running rn-collect-feedback / collect-feedback.sh
// while the script was absent from the package (dropped in the #500 workspace
// split, restored in #605). Pin the contract per host: the collector ships
// executable at the path each packaged workflow resolves, relative collector
// references resolve to real files, bare rn-collect-feedback invocations stay
// inside the command -v guarded fallback, and the Claude-packaged skill
// describes the Claude resolution surface (no Codex cache/env concepts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
            .replace(/^\$\{?(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|RN_DEV_AGENT_CODEX_PLUGIN_ROOT|CODEX_PLUGIN_ROOT)\}?\//, '')
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

test('#525 the Claude workflow invokes the collector via the resolved plugin root', () => {
  const command = join(CLAUDE_PKG, 'commands', 'send-feedback.md');
  const text = fs.readFileSync(command, 'utf8');
  assert.match(
    text,
    /"\$PLUGIN_ROOT\/scripts\/collect-feedback\.sh"/,
    `${command} must invoke the collector via the resolved plugin root`,
  );
  assert.match(
    text,
    /PLUGIN_ROOT="\$\{[^"\n]*CLAUDE_PLUGIN_ROOT[^"\n]*\}"/,
    `${command} must derive PLUGIN_ROOT from CLAUDE_PLUGIN_ROOT in its resolution chain`,
  );
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
      const blocks = text.match(/```(?:bash|sh)?\n[\s\S]*?```/g) ?? [];
      for (const block of blocks) {
        const lines = block.split('\n');
        // The only supported shape is the guarded fallback branch:
        //   elif command -v rn-collect-feedback …; then
        //     … rn-collect-feedback …
        //   else|fi
        // Every rn-collect-feedback occurrence that is not the guard itself
        // must sit strictly inside that branch.
        const guardIdx = lines.findIndex((l) =>
          /elif command -v rn-collect-feedback/.test(l),
        );
        let branchEnd = -1;
        if (guardIdx !== -1) {
          branchEnd = lines.findIndex(
            (l, i) => i > guardIdx && /^\s*(else\b|elif\b|fi\b)/.test(l),
          );
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

test('#525 the Claude-packaged sending-feedback skill describes the Claude surface, not the Codex cache', () => {
  for (const skill of [
    join(CANONICAL_SKILLS, 'sending-feedback', 'SKILL.md'),
    join(CLAUDE_PKG, 'skills', 'sending-feedback', 'SKILL.md'),
  ]) {
    const text = fs.readFileSync(skill, 'utf8');
    assert.match(text, /CLAUDE_PLUGIN_ROOT/, `${skill} must name the Claude plugin-root surface`);
    assert.match(
      text,
      /scripts\/collect-feedback\.sh/,
      `${skill} must point at the packaged collector`,
    );
    assert.doesNotMatch(
      text,
      /CODEX_PLUGIN_ROOT|CODEX_HOME|Codex plugin cache|\.codex\/plugins|In Codex, slash commands are playbooks/,
      `${skill} must not carry Codex-only resolution concepts`,
    );
  }
});
