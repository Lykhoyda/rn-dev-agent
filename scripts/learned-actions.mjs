#!/usr/bin/env node
// learned-actions.mjs — Inventory of reusable actions for the rn-dev-agent plugin.
//
// Scans, in this order:
//   A. Per-project auto-memory feedback files
//      (~/.claude/projects/<encoded-cwd>/memory/feedback_*.md)
//   B. Reusable Maestro flows
//      (./.maestro/flows/*.yaml AND ../<sibling>/test-app/.maestro/flows/*.yaml)
//   C. UI skeletons
//      (./.ui-skeleton.yaml AND ../<sibling>/test-app/.ui-skeleton.yaml)
//   D. Plugin commands available in this session
//      (./commands/*.md when running inside the plugin repo)
//
// Designed to be invoked from a slash command via Bash, OR from another
// command's prelude as Step 0 of the artifact-first protocol.
//
// Flags:
//   --json                      Emit machine-readable JSON (default human table)
//   --filter <kw>               Case-insensitive keyword match against name/desc/path
//   --appId <id>                Restrict flows to those matching this appId
//   --memory-cwd <path>         Override project for memory lookup (default: $PWD)
//   --workspace-root <path>     Workspace search root (default: $PWD plus ../*/test-app)
//   --section <a|b|c|d|all>     Restrict output to one section (default: all)
//   --max <n>                   Limit rows per section (default: 50)
//
// Exit codes: 0 ok / 2 invalid args / 3 nothing found.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const flags = {
  json: false,
  filter: '',
  appId: '',
  memoryCwd: process.cwd(),
  workspaceRoot: process.cwd(),
  section: 'all',
  max: 50,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a === '--filter') flags.filter = (argv[++i] || '').toLowerCase();
  else if (a === '--appId') flags.appId = argv[++i] || '';
  else if (a === '--memory-cwd') flags.memoryCwd = argv[++i] || process.cwd();
  else if (a === '--workspace-root') flags.workspaceRoot = argv[++i] || process.cwd();
  else if (a === '--section') flags.section = (argv[++i] || 'all').toLowerCase();
  else if (a === '--max') flags.max = parseInt(argv[++i] || '50', 10);
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: learned-actions.mjs [--json] [--filter KW] [--appId ID]
                                [--memory-cwd PATH] [--workspace-root PATH]
                                [--section a|b|c|d|all] [--max N]`);
    process.exit(0);
  } else {
    process.stderr.write(`unknown flag: ${a}\n`);
    process.exit(2);
  }
}

const matchKw = (...fields) =>
  !flags.filter ||
  fields.some((f) => (f || '').toString().toLowerCase().includes(flags.filter));

// ─────────────────────────────────────────────────────────────────────────────
// A. Feedback memories
// ─────────────────────────────────────────────────────────────────────────────
function scanMemories() {
  // Claude Code encodes the project cwd by replacing both `/` and `_` with `-`
  // (verified: /Users/anton_personal/GitHub/foo → -Users-anton-personal-GitHub-foo).
  const encoded = flags.memoryCwd.replace(/[\/_]/g, '-');
  const memDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
  if (!fs.existsSync(memDir)) return { exists: false, dir: memDir, items: [] };

  const items = [];
  for (const f of fs.readdirSync(memDir)) {
    if (!f.startsWith('feedback_') || !f.endsWith('.md')) continue;
    const fp = path.join(memDir, f);
    const text = fs.readFileSync(fp, 'utf8');
    const fm = parseFrontmatter(text);
    if (!matchKw(fm.name, fm.description, f)) continue;
    items.push({
      file: f,
      path: fp,
      name: fm.name || f.replace(/\.md$/, ''),
      description: truncate(fm.description || firstParagraph(stripFrontmatter(text)), 160),
      type: fm.type || 'feedback',
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, dir: memDir, items: items.slice(0, flags.max) };
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Maestro flows
// ─────────────────────────────────────────────────────────────────────────────
function scanFlows() {
  const roots = collectFlowRoots(flags.workspaceRoot);
  const items = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const fp = path.join(root, f);
      const text = fs.readFileSync(fp, 'utf8');
      const meta = parseFlowMeta(text);
      if (flags.appId && meta.appId !== flags.appId) continue;
      if (!matchKw(meta.purpose, meta.appId, f, fp)) continue;
      const params = (text.match(/\$\{([A-Z_]+)\}/g) || []).map((s) => s.slice(2, -1));
      const uniqParams = Array.from(new Set(params));
      const replay = uniqParams.length
        ? `maestro-runner --platform ios test ${uniqParams.map((p) => `-e ${p}=...`).join(' ')} ${fp}`
        : `maestro-runner --platform ios test ${fp}`;
      items.push({
        flow: f.replace(/\.ya?ml$/, ''),
        path: fp,
        appId: meta.appId,
        purpose: truncate(meta.purpose, 140),
        params: uniqParams,
        replay,
      });
    }
  }
  items.sort((a, b) => a.flow.localeCompare(b.flow));
  return { items: items.slice(0, flags.max), roots };
}

function collectFlowRoots(start) {
  const candidates = new Set();
  const own = path.join(start, '.maestro', 'flows');
  candidates.add(own);
  // Sibling test-app convention
  const parent = path.dirname(start);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      const ta = path.join(parent, sib, 'test-app', '.maestro', 'flows');
      if (fs.existsSync(ta)) candidates.add(ta);
    }
  }
  // Direct test-app under cwd
  const ta2 = path.join(start, 'test-app', '.maestro', 'flows');
  if (fs.existsSync(ta2)) candidates.add(ta2);
  return Array.from(candidates);
}

function parseFlowMeta(text) {
  // Maestro YAML has a top section before the `---` separator with appId etc.
  // Grab `appId:` and the first non-blank comment block as purpose.
  const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
  const lines = text.split('\n');
  const purposeLines = [];
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      inComment = true;
      const stripped = line.replace(/^#\s?/, '').trim();
      if (stripped) purposeLines.push(stripped);
    } else if (inComment && line.trim() === '') {
      if (purposeLines.length) break; // first comment block
    } else if (inComment) {
      break;
    }
  }
  const purpose = purposeLines.length ? purposeLines.join(' ') : '(no description comment)';
  return { appId: appIdMatch ? appIdMatch[1] : null, purpose };
}

// ─────────────────────────────────────────────────────────────────────────────
// C. UI skeletons
// ─────────────────────────────────────────────────────────────────────────────
function scanSkeletons() {
  const candidates = [
    path.join(flags.workspaceRoot, '.ui-skeleton.yaml'),
    path.join(flags.workspaceRoot, 'test-app', '.ui-skeleton.yaml'),
  ];
  // Sibling test-app
  const parent = path.dirname(flags.workspaceRoot);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      candidates.push(path.join(parent, sib, 'test-app', '.ui-skeleton.yaml'));
    }
  }
  const items = [];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    const text = fs.readFileSync(fp, 'utf8');
    const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
    const screenKeys = (text.match(/^  [a-z][^:]*:\s*$/gm) || [])
      .map((s) => s.trim().replace(/:$/, ''))
      .filter((k) => !['screens', 'navigation'].includes(k));
    const testIdCount = (text.match(/^[ \t]+[a-z][^:]*:\s+[a-z][^\s#]+/gim) || []).length;
    if (!matchKw(fp, appIdMatch ? appIdMatch[1] : '')) continue;
    items.push({
      path: fp,
      appId: appIdMatch ? appIdMatch[1] : null,
      screens: screenKeys.length,
      testIds: testIdCount,
    });
  }
  return { items };
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Plugin commands (only if scanning the plugin repo itself)
// ─────────────────────────────────────────────────────────────────────────────
function scanPluginCommands() {
  const dir = path.join(flags.workspaceRoot, 'commands');
  if (!fs.existsSync(dir)) return { items: [] };
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(dir, f);
    const text = fs.readFileSync(fp, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm.command && !fm.description) continue;
    const name = fm.command || f.replace(/\.md$/, '');
    if (!matchKw(name, fm.description, f)) continue;
    items.push({
      command: `/rn-dev-agent:${name}`,
      description: truncate(fm.description || '(no description)', 160),
      path: fp,
    });
  }
  items.sort((a, b) => a.command.localeCompare(b.command));
  return { items: items.slice(0, flags.max) };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (km) {
      let v = km[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[km[1]] = v;
    }
  }
  return out;
}
function stripFrontmatter(text) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\n?/, '');
}
function firstParagraph(text) {
  const trimmed = text.trim();
  const idx = trimmed.indexOf('\n\n');
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).replace(/\s+/g, ' ').trim();
}
function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────
const want = (s) => flags.section === 'all' || flags.section === s;
const memories = want('a') ? scanMemories() : { items: [], exists: false };
const flows = want('b') ? scanFlows() : { items: [], roots: [] };
const skeletons = want('c') ? scanSkeletons() : { items: [] };
const commands = want('d') ? scanPluginCommands() : { items: [] };

const total = memories.items.length + flows.items.length + skeletons.items.length + commands.items.length;

if (flags.json) {
  process.stdout.write(JSON.stringify({
    cwd: process.cwd(),
    memoryCwd: flags.memoryCwd,
    filter: flags.filter || null,
    sections: {
      memories: { count: memories.items.length, dir: memories.dir, items: memories.items },
      flows: { count: flows.items.length, roots: flows.roots, items: flows.items },
      skeletons: { count: skeletons.items.length, items: skeletons.items },
      commands: { count: commands.items.length, items: commands.items },
    },
    total,
  }, null, 2) + '\n');
  process.exit(total === 0 ? 3 : 0);
}

const parts = [];
parts.push(`# Learned actions${flags.filter ? ` (filter: "${flags.filter}")` : ''}`);
parts.push('');

if (want('a')) {
  parts.push(`## A. Feedback memories (${memories.items.length})`);
  if (!memories.exists) {
    parts.push(`_No memory directory at ${memories.dir}_`);
  } else if (memories.items.length === 0) {
    parts.push('_None match._');
  } else {
    parts.push('| Name | Description | File |');
    parts.push('|---|---|---|');
    for (const m of memories.items) {
      parts.push(`| ${esc(m.name)} | ${esc(m.description)} | \`${m.file}\` |`);
    }
  }
  parts.push('');
}

if (want('b')) {
  parts.push(`## B. Reusable Maestro flows (${flows.items.length})`);
  if (flows.items.length === 0) {
    parts.push('_None match._');
    if (flows.roots.length) {
      parts.push(`_Searched: ${flows.roots.map((r) => '`' + r + '`').join(', ')}_`);
    }
  } else {
    parts.push('| Flow | Purpose | App ID | Replay |');
    parts.push('|---|---|---|---|');
    for (const f of flows.items) {
      parts.push(`| \`${f.flow}\` | ${esc(f.purpose)} | \`${f.appId || '?'}\` | \`${f.replay}\` |`);
    }
  }
  parts.push('');
}

if (want('c')) {
  parts.push(`## C. UI skeletons (${skeletons.items.length})`);
  if (skeletons.items.length === 0) {
    parts.push('_None found._');
  } else {
    parts.push('| Path | App ID | Screens | testIDs |');
    parts.push('|---|---|---|---|');
    for (const s of skeletons.items) {
      parts.push(`| \`${s.path}\` | \`${s.appId || '?'}\` | ${s.screens} | ${s.testIds} |`);
    }
  }
  parts.push('');
}

if (want('d')) {
  parts.push(`## D. Plugin commands (${commands.items.length})`);
  if (commands.items.length === 0) {
    parts.push('_Not running inside the plugin repo._');
  } else {
    for (const c of commands.items) {
      parts.push(`- \`${c.command}\` — ${esc(c.description)}`);
    }
  }
  parts.push('');
}

parts.push('---');
parts.push('**Reminder:** For any UI flow, replay a matching flow from section B BEFORE composing `device_*` primitives. Manual walks are a fallback. (See `feedback_execute_artifacts_before_manual.md`.)');
process.stdout.write(parts.join('\n') + '\n');
process.exit(total === 0 ? 3 : 0);

function esc(s) {
  return (s || '').toString().replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
