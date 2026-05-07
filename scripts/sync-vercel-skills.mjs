#!/usr/bin/env node
// sync-vercel-skills.mjs — Sync vendored Vercel agent-skills content.
//
// Fetches the three upstream skills (react-best-practices, composition-patterns,
// react-native-skills) from vercel-labs/agent-skills at a pinned commit SHA,
// wipes-and-replaces the local third_party/ mirror, and regenerates the
// routing index at skills/rn-best-practices/rules.index.json plus the
// integrity manifest at third_party/.../UPSTREAM.lock.json.
//
// Modes:
//   --fix (default)   Fetch, wipe-and-replace, regenerate index + lockfile
//   --check           Read-only; verify on-disk hashes match lockfile
//
// Required (in --fix mode):
//   --ref <sha>       The upstream commit SHA to pin (40 hex chars or 7+ short SHA;
//                     never a branch name like "main")
//
// Optional flags:
//   --accept-missing-license-file   Allow sync if upstream lacks a top-level LICENSE
//   --accept-delta                  Allow rule-count change >±20% from previous lock
//   --quiet                         Suppress per-file logging
//   --help, -h                      Show usage
//
// Usage:
//   node scripts/sync-vercel-skills.mjs --ref abc1234        # fetch and apply
//   node scripts/sync-vercel-skills.mjs --check              # verify on-disk hashes
//
// Exit codes:
//   0   ok
//   1   verification / drift gate failure
//   2   invalid arguments
//   3   network / fetch error

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'third_party', 'vercel-labs', 'agent-skills');
const ADAPTER_ROOT = path.join(REPO_ROOT, 'skills', 'rn-best-practices');

const UPSTREAM_REPO = 'vercel-labs/agent-skills';
const UPSTREAM_SKILLS = ['react-best-practices', 'composition-patterns', 'react-native-skills'];
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM_REPO}`;
const API_BASE = `https://api.github.com/repos/${UPSTREAM_REPO}`;

// Three checkable rules in v1.0 (per spec §5 Layer 4 scope lock).
// Maps rule ID → checkerRule slug used by check-vercel-rules.mjs.
const V1_GREP_CHECKERS = {
  'react-native-skills/ui-pressable': 'no-touchable-new-code',
  'react-native-skills/list-performance-inline-objects': 'no-inline-renderitem-literals',
  'react-native-skills/rendering-no-falsy-and': 'no-falsy-jsx-and',
};

function parseArgs(argv) {
  const args = {
    mode: 'fix',
    ref: null,
    acceptMissingLicense: false,
    acceptDelta: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.mode = 'check';
    else if (a === '--fix') args.mode = 'fix';
    else if (a === '--ref') args.ref = argv[++i];
    else if (a === '--accept-missing-license-file') args.acceptMissingLicense = true;
    else if (a === '--accept-delta') args.acceptDelta = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: sync-vercel-skills.mjs [--fix | --check] [--ref <sha>] [options]

Modes:
  --fix (default)  Fetch from upstream and replace vendored content
  --check          Read-only; verify on-disk hashes match the lockfile

Required (in --fix mode):
  --ref <sha>      Upstream commit SHA (40 hex chars or 7+ short SHA)

Options:
  --accept-missing-license-file
  --accept-delta
  --quiet
`
  );
}

function isValidSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Minimal YAML frontmatter parser for skill files. Handles `key: value` lines
// only (no nested objects, no multi-line values, no JSON-style lists). The
// upstream files use exactly this shape.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kv) {
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[kv[1]] = v;
    }
  }
  return fm;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'rn-dev-agent/sync-vercel-skills',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!r.ok) throw new Error(`${url} → ${r.status} ${r.statusText}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'rn-dev-agent/sync-vercel-skills' },
  });
  if (!r.ok) throw new Error(`${url} → ${r.status} ${r.statusText}`);
  return r.text();
}

async function fetchExists(url) {
  const r = await fetch(url, {
    method: 'HEAD',
    headers: { 'User-Agent': 'rn-dev-agent/sync-vercel-skills' },
  });
  return r.ok;
}

async function listSkillFiles(sha, skill) {
  const files = [];
  async function walk(dir) {
    const url = `${API_BASE}/contents/${dir}?ref=${sha}`;
    const items = await fetchJson(url);
    for (const item of items) {
      if (item.type === 'file') files.push(item.path);
      else if (item.type === 'dir') await walk(item.path);
    }
  }
  await walk(`skills/${skill}`);
  return files;
}

async function syncSkill(sha, skill, lock, opts) {
  const dest = path.join(VENDOR_ROOT, 'skills', skill);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const files = await listSkillFiles(sha, skill);
  for (const fpath of files) {
    if (fpath.includes('..')) {
      throw new Error(`path traversal rejected: ${fpath}`);
    }
    const rawUrl = `${RAW_BASE}/${sha}/${fpath}`;
    const content = await fetchText(rawUrl);
    if (!opts.quiet) console.log(`    ${fpath} (${content.length} bytes)`);
    const relInSkill = fpath.replace(`skills/${skill}/`, '');
    const localPath = path.join(dest, relInSkill);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, content, 'utf8');

    // Validate frontmatter parses for SKILL.md and rule files (excluding
    // underscore-prefixed files like `_sections.md` which are upstream
    // templates/indexes, not rules).
    const isRule = fpath.match(/\/rules\/(?!_)[^/]+\.md$/);
    if (fpath.endsWith('SKILL.md') || isRule) {
      const fm = parseFrontmatter(content);
      if (!fm) {
        throw new Error(`frontmatter parse failure: ${fpath}`);
      }
      if (fpath.endsWith('SKILL.md') && !fm.name) {
        throw new Error(`SKILL.md missing 'name' field: ${fpath}`);
      }
    }

    lock.files.push({
      path: `skills/${skill}/${relInSkill}`,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }
}

function detectPlatform(skillName) {
  if (skillName === 'react-native-skills') return 'RN';
  if (skillName === 'react-best-practices') return 'web';
  if (skillName === 'composition-patterns') return 'both';
  return 'unknown';
}

function buildRulesIndex(lock) {
  const rules = [];

  // Vendored upstream rules (excluding underscore-prefixed templates/indexes)
  for (const f of lock.files) {
    const m = f.path.match(/^skills\/([^/]+)\/rules\/(?!_)([^/]+)\.md$/);
    if (!m) continue;
    const [, skillName, ruleSlug] = m;
    const fullPath = path.join(VENDOR_ROOT, f.path);
    const content = fs.readFileSync(fullPath, 'utf8');
    const fm = parseFrontmatter(content) || {};
    const id = `${skillName}/${ruleSlug}`;
    const tags = (fm.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    rules.push({
      id,
      title: fm.title || ruleSlug,
      category: fm.category || skillName,
      platform: detectPlatform(skillName),
      severity: (fm.impact || 'MEDIUM').toUpperCase(),
      confidence: 80,
      triggers: tags,
      fileGlobs: ['**/*.{tsx,jsx,ts,js}'],
      checkerRule: V1_GREP_CHECKERS[id] || null,
      checkable: !!V1_GREP_CHECKERS[id],
      upstream_path: `third_party/vercel-labs/agent-skills/${f.path}`,
      applicable_when: fm.impactDescription || '',
    });
  }

  // Custom rn-dev-agent rules
  const customDir = path.join(ADAPTER_ROOT, 'references', 'rn-dev-agent');
  if (fs.existsSync(customDir)) {
    for (const file of fs.readdirSync(customDir).sort()) {
      if (!file.endsWith('.md')) continue;
      const fullPath = path.join(customDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const fm = parseFrontmatter(content) || {};
      const ruleSlug = path.basename(file, '.md');
      const tags = (fm.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      rules.push({
        id: `rn-dev-agent/${ruleSlug}`,
        title: fm.title || ruleSlug,
        category: 'rn-dev-agent',
        platform: 'RN',
        severity: (fm.impact || 'MEDIUM').toUpperCase(),
        confidence: 95,
        triggers: tags,
        fileGlobs: ['**/*.{tsx,jsx}'],
        checkerRule: null,
        checkable: false,
        upstream_path: `skills/rn-best-practices/references/rn-dev-agent/${file}`,
        applicable_when: fm.impactDescription || '',
      });
    }
  }

  return rules;
}

async function runFix(args) {
  console.log(`syncing from ${UPSTREAM_REPO}@${args.ref.slice(0, 12)}...`);

  // License-presence check
  const licenseUrl = `${RAW_BASE}/${args.ref}/LICENSE`;
  const licenseExists = await fetchExists(licenseUrl);
  if (!licenseExists && !args.acceptMissingLicense) {
    console.error(`error: upstream lacks LICENSE file at ${licenseUrl}`);
    console.error('       pass --accept-missing-license-file to override');
    console.error('       (LICENSE-VENDORED.md must call out the absence)');
    process.exit(3);
  }
  if (!licenseExists) {
    console.warn(`  warning: upstream LICENSE missing — using LICENSE-VENDORED.md fallback`);
  }

  // Previous lockfile delta gate
  const lockPath = path.join(VENDOR_ROOT, 'UPSTREAM.lock.json');
  let prevRuleCount = 0;
  if (fs.existsSync(lockPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      prevRuleCount = prev.ruleCounts?.total ?? 0;
    } catch {}
  }

  const lock = {
    sha: args.ref,
    fetchedAt: new Date().toISOString(),
    sourceURL: `https://github.com/${UPSTREAM_REPO}/tree/${args.ref}`,
    licenseFilePresent: licenseExists,
    files: [],
    ruleCounts: { byCategory: {}, total: 0 },
  };

  for (const skill of UPSTREAM_SKILLS) {
    if (!args.quiet) console.log(`  fetching skills/${skill}/...`);
    await syncSkill(args.ref, skill, lock, args);
  }

  // Aggregate rule counts (excluding underscore-prefixed templates/indexes)
  for (const f of lock.files) {
    const m = f.path.match(/^skills\/([^/]+)\/rules\/(?!_)[^/]+\.md$/);
    if (m) {
      const skill = m[1];
      lock.ruleCounts.byCategory[skill] = (lock.ruleCounts.byCategory[skill] ?? 0) + 1;
      lock.ruleCounts.total++;
    }
  }
  // Sort files for deterministic output
  lock.files.sort((a, b) => a.path.localeCompare(b.path));

  // Delta gate
  if (prevRuleCount > 0) {
    const delta = Math.abs(lock.ruleCounts.total - prevRuleCount) / prevRuleCount;
    if (delta > 0.2 && !args.acceptDelta) {
      console.error(
        `error: rule count changed by ${(delta * 100).toFixed(0)}% (was ${prevRuleCount}, now ${lock.ruleCounts.total})`
      );
      console.error('       pass --accept-delta to override');
      process.exit(1);
    }
  }

  // Write lockfile
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  if (!args.quiet) console.log(`  wrote ${path.relative(REPO_ROOT, lockPath)}`);

  // Build and write rules.index.json
  const indexPath = path.join(ADAPTER_ROOT, 'rules.index.json');
  const index = buildRulesIndex(lock);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  if (!args.quiet) {
    const customCount = index.length - lock.ruleCounts.total;
    console.log(
      `  wrote ${path.relative(REPO_ROOT, indexPath)} (${lock.ruleCounts.total} upstream + ${customCount} custom = ${index.length} rules)`
    );
  }

  console.log(`✓ sync complete: ${lock.files.length} files, ${index.length} rules`);
}

async function runCheck(_args) {
  const lockPath = path.join(VENDOR_ROOT, 'UPSTREAM.lock.json');
  if (!fs.existsSync(lockPath)) {
    console.error(`error: ${path.relative(REPO_ROOT, lockPath)} missing`);
    console.error('       run: node scripts/sync-vercel-skills.mjs --fix --ref <sha>');
    process.exit(1);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  let mismatches = 0;
  for (const f of lock.files) {
    const fullPath = path.join(VENDOR_ROOT, f.path);
    if (!fs.existsSync(fullPath)) {
      console.error(`missing: ${f.path}`);
      mismatches++;
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const actual = sha256(content);
    if (actual !== f.sha256) {
      console.error(
        `hash mismatch: ${f.path} (expected ${f.sha256.slice(0, 12)}, got ${actual.slice(0, 12)})`
      );
      mismatches++;
    }
  }
  if (mismatches > 0) {
    console.error(
      `✗ ${mismatches} file(s) out of sync — run: node scripts/sync-vercel-skills.mjs --fix --ref ${lock.sha}`
    );
    process.exit(1);
  }
  console.log(
    `✓ ${lock.files.length} files in sync (sha=${lock.sha.slice(0, 12)} fetchedAt=${lock.fetchedAt})`
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.mode === 'fix') {
    if (!args.ref) {
      console.error('error: --ref <sha> is required in --fix mode');
      process.exit(2);
    }
    if (!isValidSha(args.ref)) {
      console.error(`error: --ref must be a git commit SHA (got: ${args.ref})`);
      console.error('       branch names like "main" are rejected to prevent floating-ref drift');
      process.exit(2);
    }
    return runFix(args);
  }

  return runCheck(args);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(3);
});
