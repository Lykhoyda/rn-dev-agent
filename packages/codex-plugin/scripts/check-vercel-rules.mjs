#!/usr/bin/env node
// check-vercel-rules.mjs — Verification CLI for Vercel agent-skills rules.
//
// Runs the v1.0 grep-pattern rule subset (3 rules, locked per spec §5
// Layer 4) against changed/all source files. Future v1.1 swaps in the
// full eslint-plugin-rn-dev-agent for AST-grade checking.
//
// Modes (mutually exclusive; first one wins):
//   --changed [files...]    Default. Check files passed as positional args.
//                           If none, reads file paths from stdin (one per line).
//   --all                   Walk current working directory for .tsx/.jsx/.ts/.js.
//   --ci                    Same as --all but exits 1 on any violation.
//
// Output formats:
//   --format hook           (default) Compact text for hook additionalContext.
//   --format json           Machine-readable per-violation JSON.
//   --format sarif          GitHub code-scanning SARIF 2.1.0.
//
// Baseline:
//   --baseline <path>       Load baseline file; skip violations present there.
//                           Default: .rn-agent/vercel-rules-baseline.json
//   --baseline-snapshot     Write current violations to baseline path and exit.
//   --no-baseline           Disable baseline loading.
//
// Other:
//   --max <n>               Max files to walk in --all/--ci mode (default 1000).
//   --quiet                 Suppress informational stderr.
//   --help, -h              Show usage.
//
// Exit codes:
//   0   ok (no violations OR --changed mode regardless of count)
//   1   violations found in --ci mode
//   2   invalid arguments
//   3   internal error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// === Rule definitions (v1.0 — 3 grep checkers per spec §5 Layer 4) ===
//
// Each rule.check returns an array of { line, col, message } for matches.
// Patterns are deliberately narrow to keep false-positive rate low; full
// AST coverage moves to eslint-plugin-rn-dev-agent in v1.1.

function lineOf(content, idx) {
  return content.slice(0, idx).split('\n').length;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packagedIndexCandidates = [
  path.join(scriptDir, '..', 'skills', 'rn-best-practices', 'rules.index.json'),
  path.join(
    scriptDir,
    '..',
    'packages',
    'shared-agent-knowledge',
    'skills',
    'rn-best-practices',
    'rules.index.json',
  ),
];
let packagedRuleIndex = new Map();
for (const candidate of packagedIndexCandidates) {
  try {
    const entries = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    packagedRuleIndex = new Map(entries.map((entry) => [entry.id, entry]));
    break;
  } catch {
    // Try the next installed/source-checkout layout.
  }
}

const RULES = [
  {
    id: 'no-touchable-new-code',
    upstream_id: 'react-native-skills/ui-pressable',
    severity: 'warn',
    description: 'Use Pressable instead of Touchable* (Opacity/Highlight/WithoutFeedback).',
    upstream_path:
      'third_party/vercel-labs/agent-skills/skills/react-native-skills/rules/ui-pressable.md',
    check(content) {
      const matches = [];
      const re =
        /^\s*import\b[^;\n]*?\b(Touchable(?:Opacity|Highlight|WithoutFeedback))\b[^;\n]*?from\s+['"]react-native['"]/gm;
      for (const m of content.matchAll(re)) {
        matches.push({
          line: lineOf(content, m.index),
          col: 1,
          message: `${m[1]} imported in new code; use Pressable for new components`,
        });
      }
      return matches;
    },
  },
  {
    id: 'no-inline-renderitem-literals',
    upstream_id: 'react-native-skills/list-performance-inline-objects',
    severity: 'warn',
    description: 'Stabilize renderItem; inline arrow forces re-render of list items.',
    upstream_path:
      'third_party/vercel-labs/agent-skills/skills/react-native-skills/rules/list-performance-inline-objects.md',
    check(content) {
      const matches = [];
      // Match: renderItem={(...) => ...   (inline arrow)
      const re = /\brenderItem\s*=\s*\{\s*\([^)]*\)\s*=>/g;
      for (const m of content.matchAll(re)) {
        matches.push({
          line: lineOf(content, m.index),
          col: 1,
          message: 'Inline `renderItem={(item) => ...}`; extract to a `useCallback` outside JSX',
        });
      }
      return matches;
    },
  },
  {
    id: 'no-falsy-jsx-and',
    upstream_id: 'react-native-skills/rendering-no-falsy-and',
    severity: 'warn',
    description: 'Use ternary or `> 0` instead of `{x.length && <JSX/>}` (renders "0").',
    upstream_path:
      'third_party/vercel-labs/agent-skills/skills/react-native-skills/rules/rendering-no-falsy-and.md',
    check(content) {
      const matches = [];
      // Match: {someName.length && <JSX
      const re = /\{\s*([\w.]+)\.length\s*&&\s*</g;
      for (const m of content.matchAll(re)) {
        matches.push({
          line: lineOf(content, m.index),
          col: 1,
          message: `\`{${m[1]}.length && <…/>}\` renders \`0\` when length is 0; use \`${m[1]}.length > 0\` or a ternary`,
        });
      }
      return matches;
    },
  },
];

// === CLI parsing ===

function parseArgs(argv) {
  const args = {
    mode: 'changed',
    files: [],
    format: 'hook',
    baselinePath: '.rn-agent/vercel-rules-baseline.json',
    snapshot: false,
    useBaseline: true,
    max: 1000,
    quiet: false,
  };
  let endOfFlags = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (endOfFlags) {
      args.files.push(a);
      continue;
    }
    if (a === '--') {
      endOfFlags = true;
    } else if (a === '--changed') args.mode = 'changed';
    else if (a === '--all') args.mode = 'all';
    else if (a === '--ci') args.mode = 'ci';
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--baseline') args.baselinePath = argv[++i];
    else if (a === '--baseline-snapshot') args.snapshot = true;
    else if (a === '--no-baseline') args.useBaseline = false;
    else if (a === '--max') args.max = parseInt(argv[++i], 10);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('--')) {
      args.files.push(a);
    } else {
      console.error(`unknown flag: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!['hook', 'json', 'sarif'].includes(args.format)) {
    console.error(`error: --format must be one of hook|json|sarif (got: ${args.format})`);
    process.exit(2);
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: check-vercel-rules.mjs [--changed | --all | --ci] [files...] [options]

Modes:
  --changed [files...]     Check positional args; or stdin (one path/line) if none
  --all                    Walk cwd for .tsx/.jsx/.ts/.js
  --ci                     --all + exit 1 on any violation

Format:
  --format hook|json|sarif (default: hook)

Baseline:
  --baseline <path>        Default: .rn-agent/vercel-rules-baseline.json
  --baseline-snapshot      Write current violations to baseline path; exit
  --no-baseline            Disable baseline loading

Other:
  --max <n>                Max files in --all/--ci (default 1000)
  --quiet                  Less stderr output
`,
  );
}

// === File walking & reading ===

function isCheckableFile(filePath) {
  if (!/\.(tsx|jsx|ts|js)$/.test(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (/(__tests__|\.test\.|\.spec\.|\.config\.)/.test(filePath)) return false;
  if (/node_modules|\/dist\/|\/build\/|\/\.git\/|\/\.next\//.test(filePath)) return false;
  return true;
}

function walkAll(root, max, results = []) {
  if (results.length >= max) return results;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (results.length >= max) return results;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === '.next' ||
        entry.name === 'third_party' ||
        entry.name.startsWith('.')
      )
        continue;
      walkAll(full, max, results);
    } else if (isCheckableFile(full)) {
      results.push(full);
    }
  }
  return results;
}

function readStdinPaths() {
  try {
    if (process.stdin.isTTY) return [];
    const raw = fs.readFileSync(0, 'utf8');
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// === Baseline ===

function loadBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    return new Set(raw.map((b) => `${b.file}:${b.line}:${b.rule_id}`));
  } catch {
    return null;
  }
}

// === Checking ===

function checkFile(filePath, baseline) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const violations = [];
  for (const rule of RULES) {
    for (const v of rule.check(content)) {
      const baselineKey = `${filePath}:${v.line}:${rule.id}`;
      if (baseline?.has(baselineKey)) continue;
      violations.push({
        file: filePath,
        line: v.line,
        col: v.col || 1,
        rule_id: rule.id,
        upstream_id: rule.upstream_id,
        upstream_path: rule.upstream_path,
        severity: rule.severity,
        message: v.message,
        rule_metadata: packagedRuleIndex.get(rule.upstream_id) ?? null,
      });
    }
  }
  return violations;
}

// === Output formats ===

function formatHook(violations) {
  if (violations.length === 0) return '';
  const cwd = process.cwd();
  let out = `Vercel rule violations in last edit:\n`;
  for (const v of violations.slice(0, 8)) {
    const rel = path.relative(cwd, v.file);
    out += `  - [${v.rule_id}] ${rel}:${v.line} — ${v.message}\n`;
    const metadata = v.rule_metadata;
    out += metadata
      ? `      rule: ${metadata.id} — ${metadata.title} (${metadata.applicable_when})\n`
      : `      rule provenance: ${v.upstream_id}\n`;
  }
  if (violations.length > 8) {
    out += `  ... and ${violations.length - 8} more (run the check-vercel-rules workflow for a full audit)\n`;
  }
  return out;
}

function formatJson(violations) {
  return JSON.stringify({ count: violations.length, violations }, null, 2) + '\n';
}

function formatSarif(violations) {
  const sarif = {
    version: '2.1.0',
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'rn-dev-agent vercel-rules',
            version: '1.0.0',
            informationUri: 'https://github.com/Lykhoyda/rn-dev-agent',
            rules: RULES.map((r) => ({
              id: r.id,
              name: r.id,
              shortDescription: { text: r.description },
              helpUri: `https://github.com/vercel-labs/agent-skills/blob/main/skills/${r.upstream_id.replace('/', '/rules/')}.md`,
            })),
          },
        },
        results: violations.map((v) => ({
          ruleId: v.rule_id,
          level: v.severity === 'error' ? 'error' : 'warning',
          message: { text: v.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.file },
                region: { startLine: v.line, startColumn: v.col },
              },
            },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}

// === Main ===

async function main() {
  const args = parseArgs(process.argv);
  const baseline = args.useBaseline && !args.snapshot ? loadBaseline(args.baselinePath) : null;

  let filesToCheck;
  if (args.mode === 'all' || args.mode === 'ci') {
    filesToCheck = walkAll(process.cwd(), args.max);
    if (!args.quiet) console.error(`scanning ${filesToCheck.length} file(s)...`);
  } else if (args.files.length > 0) {
    filesToCheck = args.files.filter(isCheckableFile);
  } else {
    filesToCheck = readStdinPaths().filter(isCheckableFile);
  }

  const allViolations = [];
  for (const f of filesToCheck) {
    if (!fs.existsSync(f)) continue;
    allViolations.push(...checkFile(f, baseline));
  }

  if (args.snapshot) {
    fs.mkdirSync(path.dirname(args.baselinePath), { recursive: true });
    fs.writeFileSync(args.baselinePath, JSON.stringify(allViolations, null, 2) + '\n', 'utf8');
    if (!args.quiet) {
      console.error(
        `✓ wrote ${args.baselinePath} with ${allViolations.length} baseline violations`,
      );
    }
    process.exit(0);
  }

  let output;
  if (args.format === 'json') output = formatJson(allViolations);
  else if (args.format === 'sarif') output = formatSarif(allViolations);
  else output = formatHook(allViolations);

  if (output) process.stdout.write(output);

  if (args.mode === 'ci' && allViolations.length > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(3);
});
