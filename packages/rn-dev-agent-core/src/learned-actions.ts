#!/usr/bin/env node
// learned-actions.ts — Inventory of reusable actions for the rn-dev-agent plugin.
//
// Scans, in this order:
//   A. Per-project auto-memory feedback files
//      (~/.claude/projects/<encoded-cwd>/memory/feedback_*.md)
//   B. Reusable Maestro flows
//      (./.rn-agent/actions/*.yaml AND ../<sibling>/test-app/.rn-agent/actions/*.yaml)
//   C. UI skeletons
//      (./.rn-agent/skeleton.yaml AND ../<sibling>/test-app/.rn-agent/skeleton.yaml)
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

interface Flags {
  json: boolean;
  filter: string;
  appId: string;
  memoryCwd: string;
  workspaceRoot: string;
  section: string;
  max: number;
}

const argv = process.argv.slice(2);
const flags: Flags = {
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
  else if (a === '--max') {
    const m = parseInt(argv[++i] || '50', 10);
    flags.max = Number.isNaN(m) ? 50 : m;
  } else if (a === '--help' || a === '-h') {
    console.log(`Usage: learned-actions [--json] [--filter KW] [--appId ID]
                               [--memory-cwd PATH] [--workspace-root PATH]
                               [--section a|b|c|d|all] [--max N]`);
    process.exit(0);
  } else {
    process.stderr.write(`unknown flag: ${a}\n`);
    process.exit(2);
  }
}

const matchKw = (...fields: Array<unknown>): boolean =>
  !flags.filter || fields.some((f) => (f || '').toString().toLowerCase().includes(flags.filter));

// ─────────────────────────────────────────────────────────────────────────────
// A. Feedback memories
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryItem {
  file: string;
  path: string;
  name: string;
  description: string;
  type: string;
}

interface MemoriesResult {
  exists: boolean;
  dir: string | undefined;
  items: MemoryItem[];
}

function scanMemories(): MemoriesResult {
  // Claude Code encodes the project cwd by replacing every non-alphanumeric
  // character with `-` — that includes `/`, `_`, AND `.` (verified:
  // /Users/x/.claude-mem → -Users-x--claude-mem). The previous `[\/_]` regex
  // left dots intact, so any cwd containing a dot (a dotted dir name, a dotfile
  // dir, or a dotted username) computed a memDir that did not exist on disk and
  // silently dropped the entire feedback-memory section.
  const encoded = flags.memoryCwd.replace(/[^a-zA-Z0-9]/g, '-');
  const memDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
  if (!fs.existsSync(memDir)) return { exists: false, dir: memDir, items: [] };

  const items: MemoryItem[] = [];
  for (const f of fs.readdirSync(memDir)) {
    if (!f.startsWith('feedback_') || !f.endsWith('.md')) continue;
    const fp = path.join(memDir, f);
    const text = fs.readFileSync(fp, 'utf8');
    const fm = parseFrontmatter(text);
    if (!matchKw(fm['name'], fm['description'], f)) continue;
    items.push({
      file: f,
      path: fp,
      name: (fm['name'] as string) || f.replace(/\.md$/, ''),
      description: truncate(
        (fm['description'] as string) || firstParagraph(stripFrontmatter(text)),
        160,
      ),
      type: (fm['type'] as string) || 'feedback',
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, dir: memDir, items: items.slice(0, flags.max) };
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Maestro flows
// ─────────────────────────────────────────────────────────────────────────────

type ProducesMap = Record<string, boolean | number | string>;

interface FlowItem {
  flow: string;
  path: string;
  appId: string | null;
  purpose: string;
  id: string | null;
  intent: string | null;
  tags: string[] | null;
  mutates: boolean | null;
  status: string | null;
  params: string[];
  produces: ProducesMap | null;
  replay: string;
}

interface FlowsResult {
  items: FlowItem[];
  roots: string[];
}

function scanFlows(): FlowsResult {
  const roots = collectFlowRoots(flags.workspaceRoot);
  const items: FlowItem[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const fp = path.join(root, f);
      const text = fs.readFileSync(fp, 'utf8');
      const meta = parseFlowMeta(text);
      if (flags.appId && meta.appId !== flags.appId) continue;
      const tagsStr = (meta.tags || []).join(',');
      if (!matchKw(meta.purpose, meta.appId, meta.intent, tagsStr, f, fp)) continue;
      const params = (text.match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []).map((s) => s.slice(2, -1));
      const uniqParams = Array.from(new Set(params));
      const replay = uniqParams.length
        ? `maestro-runner --platform ios test ${uniqParams.map((p) => `-e ${p}=...`).join(' ')} ${fp}`
        : `maestro-runner --platform ios test ${fp}`;
      items.push({
        flow: f.replace(/\.ya?ml$/, ''),
        path: fp,
        appId: meta.appId,
        purpose: truncate(meta.purpose, 140),
        id: meta.id,
        intent: meta.intent,
        tags: meta.tags,
        mutates: meta.mutates,
        status: meta.status,
        params: uniqParams,
        produces: meta.produces,
        replay,
      });
    }
  }
  items.sort((a, b) => a.flow.localeCompare(b.flow));
  return { items: items.slice(0, flags.max), roots };
}

function collectFlowRoots(start: string): string[] {
  // D1208: .rn-agent/actions/ is the single source of plugin-managed flows.
  const candidates = new Set<string>();
  const own = path.join(start, '.rn-agent', 'actions');
  candidates.add(own);
  // Sibling test-app convention
  const parent = path.dirname(start);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      const ta = path.join(parent, sib, 'test-app', '.rn-agent', 'actions');
      if (fs.existsSync(ta)) candidates.add(ta);
    }
  }
  // Direct test-app under cwd
  const ta2 = path.join(start, 'test-app', '.rn-agent', 'actions');
  if (fs.existsSync(ta2)) candidates.add(ta2);
  return Array.from(candidates);
}

interface FlowMeta {
  appId: string | null;
  purpose: string;
  id: string | null;
  intent: string | null;
  tags: string[] | null;
  mutates: boolean | null;
  status: string | null;
  produces: ProducesMap | null;
}

type MetaKey = 'id' | 'intent' | 'tags' | 'mutates' | 'status' | 'produces';

function parseFlowMeta(text: string): FlowMeta {
  // Maestro YAML has a top section before the `---` separator with appId etc.
  // Grab `appId:` and the first non-blank comment block as purpose.
  // Reusable Action Metadata (M7): also surface `# id|intent|tags|mutates|status: ...`
  // lines anywhere in the header so machine-readable filtering is possible
  // without parsing the full YAML body.
  const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
  const lines = text.split('\n');
  const purposeLines: string[] = [];
  const meta: Record<MetaKey, string[] | string | boolean | ProducesMap | null> = {
    id: null,
    intent: null,
    tags: null,
    mutates: null,
    status: null,
    produces: null,
  };
  const META_KEYS = new Set<string>(['id', 'intent', 'tags', 'mutates', 'status', 'produces']);
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      inComment = true;
      const stripped = line.replace(/^#\s?/, '').trim();
      if (!stripped) continue;
      const kv = stripped.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+)$/);
      if (kv && META_KEYS.has(kv[1])) {
        const key = kv[1] as MetaKey;
        const raw = kv[2].trim();
        if (key === 'tags') {
          meta.tags = raw
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
        } else if (key === 'mutates') {
          meta.mutates = /^true$/i.test(raw);
        } else if (key === 'produces') {
          meta.produces = parseProducesMap(raw);
        } else {
          meta[key] = raw;
        }
        continue;
      }
      purposeLines.push(stripped);
    } else if (inComment && line.trim() === '') {
      if (purposeLines.length) break; // first comment block
    } else if (inComment) {
      break;
    }
  }
  const fallbackPurpose = purposeLines.length ? purposeLines.join(' ') : '(no description comment)';
  // Prefer explicit intent over the heuristic purpose extraction.
  const purpose = (meta.intent as string | null) || fallbackPurpose;
  return {
    appId: appIdMatch ? appIdMatch[1] : null,
    purpose,
    id: meta.id as string | null,
    intent: meta.intent as string | null,
    tags: meta.tags as string[] | null,
    mutates: meta.mutates as boolean | null,
    status: meta.status as string | null,
    produces: meta.produces as ProducesMap | null,
  };
}

// D1209 — parse the inline `produces` map: `{ key: value, key: value }`.
// Values are typed as boolean (true/false), number, or string. Returns
// null when empty or unparseable so callers can omit the field. Mirrors
// parseProducesMap() in packages/rn-dev-agent-core/src/domain/reusable-action.ts.
function parseProducesMap(raw: string): ProducesMap | null {
  const inner = raw
    .trim()
    .replace(/^\{|\}$/g, '')
    .trim();
  if (!inner) return null;
  const result: ProducesMap = {};
  for (const part of inner.split(',')) {
    const kv = part.match(/^\s*([a-zA-Z_][\w.-]*)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    const valueRaw = kv[2].trim();
    if (/^(true|false)$/i.test(valueRaw)) {
      result[key] = /^true$/i.test(valueRaw);
    } else if (/^-?\d+(\.\d+)?$/.test(valueRaw)) {
      result[key] = Number(valueRaw);
    } else {
      result[key] = valueRaw.replace(/^['"]|['"]$/g, '');
    }
  }
  return Object.keys(result).length ? result : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// C. UI skeletons
// ─────────────────────────────────────────────────────────────────────────────

interface SkeletonItem {
  path: string;
  appId: string | null;
  screens: number;
  testIds: number;
}

interface SkeletonsResult {
  items: SkeletonItem[];
}

function scanSkeletons(): SkeletonsResult {
  // D1207 hard-cut: skeleton lives at .rn-agent/skeleton.yaml.
  // Old root-level .ui-skeleton.yaml is deprecated and no longer scanned.
  const candidates: string[] = [
    path.join(flags.workspaceRoot, '.rn-agent', 'skeleton.yaml'),
    path.join(flags.workspaceRoot, 'test-app', '.rn-agent', 'skeleton.yaml'),
  ];
  // Sibling test-app
  const parent = path.dirname(flags.workspaceRoot);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      candidates.push(path.join(parent, sib, 'test-app', '.rn-agent', 'skeleton.yaml'));
    }
  }
  const items: SkeletonItem[] = [];
  const seen = new Set<string>();
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    const real = fs.realpathSync(fp);
    if (seen.has(real)) continue;
    seen.add(real);
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

interface CommandItem {
  command: string;
  description: string;
  path: string;
}

interface CommandsResult {
  items: CommandItem[];
}

function scanPluginCommands(): CommandsResult {
  const dir = path.join(flags.workspaceRoot, 'commands');
  if (!fs.existsSync(dir)) return { items: [] };
  const items: CommandItem[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(dir, f);
    const text = fs.readFileSync(fp, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm['command'] && !fm['description']) continue;
    const name = (fm['command'] as string) || f.replace(/\.md$/, '');
    if (!matchKw(name, fm['description'], f)) continue;
    items.push({
      command: `/rn-dev-agent:${name}`,
      description: truncate((fm['description'] as string) || '(no description)', 160),
      path: fp,
    });
  }
  items.sort((a, b) => a.command.localeCompare(b.command));
  return { items: items.slice(0, flags.max) };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseFrontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
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

function stripFrontmatter(text: string): string {
  return text.replace(/^---\s*\n[\s\S]*?\n---\n?/, '');
}

function firstParagraph(text: string): string {
  const trimmed = text.trim();
  const idx = trimmed.indexOf('\n\n');
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).replace(/\s+/g, ' ').trim();
}

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────

const want = (s: string): boolean => flags.section === 'all' || flags.section === s;
const memories = want('a') ? scanMemories() : { items: [], exists: false, dir: undefined };
const flows = want('b') ? scanFlows() : { items: [], roots: [] };
const skeletons = want('c') ? scanSkeletons() : { items: [] };
const commands = want('d') ? scanPluginCommands() : { items: [] };

const total =
  memories.items.length + flows.items.length + skeletons.items.length + commands.items.length;

if (flags.json) {
  process.stdout.write(
    JSON.stringify(
      {
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
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(total === 0 ? 3 : 0);
}

const parts: string[] = [];
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
      parts.push(
        `| ${escapeMarkdownTableCell(m.name)} | ${escapeMarkdownTableCell(m.description)} | \`${m.file}\` |`,
      );
    }
  }
  parts.push('');
}

if (want('b')) {
  parts.push(`## B. Reusable Maestro flows (${flows.items.length})`);
  parts.push('_Source: `.rn-agent/actions/`._');
  if (flows.items.length === 0) {
    parts.push('_None match._');
    if (flows.roots.length) {
      parts.push(`_Searched: ${flows.roots.map((r) => '`' + r + '`').join(', ')}_`);
    }
  } else {
    parts.push('| Flow | Purpose | App ID | Mutates | Status | Tags | Produces | Replay |');
    parts.push('|---|---|---|---|---|---|---|---|');
    for (const f of flows.items) {
      const mut = f.mutates === null || f.mutates === undefined ? '?' : f.mutates ? 'yes' : 'no';
      const status = f.status || '?';
      const tags = f.tags && f.tags.length ? f.tags.join(', ') : '?';
      const produces = formatProducesCell(f.produces);
      parts.push(
        `| \`${f.flow}\` | ${escapeMarkdownTableCell(f.purpose)} | \`${f.appId || '?'}\` | ${mut} | ${status} | ${escapeMarkdownTableCell(tags)} | ${escapeMarkdownTableCell(produces)} | \`${f.replay}\` |`,
      );
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
      parts.push(`- \`${c.command}\` — ${escapeMarkdownTableCell(c.description)}`);
    }
  }
  parts.push('');
}

parts.push('---');
parts.push(
  '**Reminder:** For any UI flow, replay a matching flow from section B BEFORE composing `device_*` primitives. Manual walks are a fallback. (See `feedback_execute_artifacts_before_manual.md`.)',
);
process.stdout.write(parts.join('\n') + '\n');
process.exit(total === 0 ? 3 : 0);

// Markdown-table cell escaping. We deliberately only escape the column
// separator `|` and flatten newlines; everything else (including HTML and
// regex metacharacters) is valid inside a GitHub-flavored Markdown table
// cell. CodeQL js/incomplete-sanitization (alert #26) was raised on the
// previous name `esc()` which read like a general-purpose escaper.
function escapeMarkdownTableCell(s: unknown): string {
  // Escape `\` FIRST so a pre-existing `\|` doesn't become `\\\|`.
  return (s || '').toString().replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// D1209 — render the parsed produces map as a compact table cell.
// Empty / null returns '?'.
function formatProducesCell(produces: ProducesMap | null | undefined): string {
  if (!produces || typeof produces !== 'object') return '?';
  const keys = Object.keys(produces).sort();
  if (keys.length === 0) return '?';
  return keys.map((k) => `${k}=${produces[k]}`).join(', ');
}
