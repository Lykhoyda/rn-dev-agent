#!/usr/bin/env node
/**
 * Measure MCP tool description weight in scripts/cdp-bridge/src/index.ts.
 *
 * Usage:
 *   node scripts/cdp-bridge/measure-tool-descriptions.mjs
 *   node scripts/cdp-bridge/measure-tool-descriptions.mjs --json
 *   node scripts/cdp-bridge/measure-tool-descriptions.mjs --save
 *
 * Reference baseline (2026-04-28, observation #59):
 *   63 tools, 18,007 desc chars + 11,930 zod chars = 29,937 total
 *   ~7,500 tokens text-only, ~9-11K with JSON schema structural overhead
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, 'src/index.ts');
const source = readFileSync(indexPath, 'utf8');

const charsToTokens = (n) => Math.round(n / 4);

function extractTools(src) {
  const matches = [...src.matchAll(/trackedTool\(\s*'([^']+)',\s*'((?:[^'\\]|\\.)*)',/g)];
  const starts = matches.map((m) => ({
    name: m[1],
    desc: m[2],
    after: m.index + m[0].length,
  }));

  return starts.map((tool, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].after : src.length;
    const block = src.slice(tool.after, end);
    const describes = [...block.matchAll(/\.describe\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)];
    const zodChars = describes.reduce((s, d) => s + d[1].length, 0);
    return {
      name: tool.name,
      desc: tool.desc,
      descChars: tool.desc.length,
      zodParamCount: describes.length,
      zodChars,
      totalChars: tool.desc.length + zodChars,
      loose: classifyLoose(tool.desc, tool.name),
      strict: classifyStrict(tool.desc, tool.name),
    };
  });
}

/**
 * LOOSE classifier — high precision, low recall.
 * Catches the easiest 80% of real cleanup wins with near-zero risk of stripping
 * useful guidance. Flags only "obvious archaeological lore" the LLM never benefits
 * from. Use this set first; act on flagged tools, then re-measure.
 */
function classifyLoose(desc, name) {
  const flags = [];
  if (/\b[BD]\d{2,3}\b/.test(desc)) flags.push('decision-id');
  if (/\bPhase\s+\d+\b|\bM\d+[a-z]?\b/.test(desc)) flags.push('phase-ref');
  return flags;
}

/**
 * STRICT classifier — aggressive but corrected (post multi-LLM review).
 *
 * Removed from earlier draft: `tool-xref` (cross-references are useful routing
 * signal), `version-gated` (only 2 corpus hits, both useful), broad `jargon`
 * matching domain terms like Hermes/DevTools (those are correct), broad
 * `meta-prose` matching FIRST/CAUTION (useful single-line guidance).
 *
 * Added: parenthetical archaeology `(B132)`, historical verbs (shipped/wired/
 * deprecated), workflow narratives ("Workflow: X → Y"), implementation leaks
 * (__RN_AGENT, __NAV_REF__, XPC, "zombie host/page/target").
 *
 * Long-desc only fires when COMBINED with another flag — length alone ≠ bloat.
 */
function classifyStrict(desc, name) {
  const flags = [];

  if (/\b[BD]\d{2,3}\b/.test(desc)) flags.push('decision-id');
  if (/\bPhase\s+\d+\b|\bM\d+[a-z]?\b/.test(desc)) flags.push('phase-ref');

  if (/\((?:[BD]\d{2,3}(?:\/[BD]\d{2,3})?|Phase\s+\d+|M\d+[a-z]?)\)/.test(desc))
    flags.push('paren-archaeology');

  if (/\b(shipped|wired|introduced|formerly|deprecated|previously)\b/i.test(desc))
    flags.push('historical-verb');

  if (/\b(PRIMARY|OTHER|RECOMMENDED|NEVER):/.test(desc)) flags.push('structured-meta');

  if (/\b(__RN_AGENT|__NAV_REF__|XPC|zombie\s+(?:host|page|target))\b/.test(desc))
    flags.push('impl-leak');

  if (/\bWorkflow\s*:/.test(desc)) flags.push('workflow-narrative');

  if (desc.length > 450 && flags.length > 0) flags.push('long-and-lore');

  return flags;
}

const tools = extractTools(source);
tools.sort((a, b) => b.totalChars - a.totalChars);

const totalDescChars = tools.reduce((s, t) => s + t.descChars, 0);
const totalZodChars = tools.reduce((s, t) => s + t.zodChars, 0);
const totalParamCount = tools.reduce((s, t) => s + t.zodParamCount, 0);

const summary = {
  measured_at: new Date().toISOString(),
  source: 'scripts/cdp-bridge/src/index.ts',
  tool_count: tools.length,
  total_desc_chars: totalDescChars,
  total_zod_chars: totalZodChars,
  total_chars: totalDescChars + totalZodChars,
  total_param_count: totalParamCount,
  est_tokens_text_only: charsToTokens(totalDescChars + totalZodChars),
  tools: tools.map((t) => ({
    name: t.name,
    descChars: t.descChars,
    zodParamCount: t.zodParamCount,
    zodChars: t.zodChars,
    totalChars: t.totalChars,
    loose: t.loose,
    strict: t.strict,
  })),
};

const looseFlagged = tools.filter((t) => t.loose.length > 0);
const strictFlagged = tools.filter((t) => t.strict.length > 0);
const looseChars = looseFlagged.reduce((s, t) => s + t.totalChars, 0);
const strictChars = strictFlagged.reduce((s, t) => s + t.totalChars, 0);
summary.loose_flagged_count = looseFlagged.length;
summary.loose_flagged_chars = looseChars;
summary.strict_flagged_count = strictFlagged.length;
summary.strict_flagged_chars = strictChars;

const isJson = process.argv.includes('--json');
const isSave = process.argv.includes('--save');

if (isSave) {
  const outDir = resolve(here, 'reports');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = summary.measured_at.replace(/[:.]/g, '-');
  const file = resolve(outDir, `tool-descriptions-${stamp}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.error(`Saved: ${file}`);
}

if (isJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(`MCP Tool Description Baseline`);
  console.log(`Measured: ${summary.measured_at}`);
  console.log(`Source:   ${summary.source}`);
  console.log();
  console.log(`Tools registered:      ${summary.tool_count}`);
  console.log(`Description chars:     ${summary.total_desc_chars.toLocaleString()}`);
  console.log(`Zod .describe() chars: ${summary.total_zod_chars.toLocaleString()} (${summary.total_param_count} params)`);
  console.log(`Combined chars:        ${summary.total_chars.toLocaleString()}`);
  console.log(`Estimated tokens:      ~${summary.est_tokens_text_only.toLocaleString()} (text-only; add ~20-30% for JSON schema overhead)`);
  console.log();
  console.log(`Top 25 by total weight (description + parameter .describe() text):`);
  console.log();
  console.log(`  # | ${pad('Tool', 32)} | ${padL('desc', 5)} | ${padL('zod', 5)} | ${padL('total', 5)} | loose | strict`);
  console.log(`----|${'-'.repeat(34)}|${'-'.repeat(7)}|${'-'.repeat(7)}|${'-'.repeat(7)}|${'-'.repeat(7)}|${'-'.repeat(40)}`);
  for (const [i, t] of tools.slice(0, 25).entries()) {
    const looseMark = t.loose.length > 0 ? '  X  ' : '  -  ';
    const strictStr = t.strict.length > 0 ? t.strict.join(',') : '-';
    console.log(
      `${padL(i + 1, 3)} | ${pad(t.name, 32)} | ${padL(t.descChars, 5)} | ${padL(t.zodChars, 5)} | ${padL(t.totalChars, 5)} | ${looseMark} | ${strictStr}`,
    );
  }
  console.log();
  console.log(`LOOSE  flagged: ${looseFlagged.length.toString().padStart(2)} / ${tools.length} tools, ${looseChars.toLocaleString().padStart(6)} chars (~${charsToTokens(looseChars).toLocaleString()} tokens)`);
  console.log(`STRICT flagged: ${strictFlagged.length.toString().padStart(2)} / ${tools.length} tools, ${strictChars.toLocaleString().padStart(6)} chars (~${charsToTokens(strictChars).toLocaleString()} tokens)`);
  console.log();
  console.log(`Loose-only tools (definitely-clean candidates):`);
  for (const t of looseFlagged) {
    console.log(`  ${pad(t.name, 32)} ${t.loose.join(',')}`);
  }
  console.log();
  const strictOnly = strictFlagged.filter((t) => t.loose.length === 0);
  if (strictOnly.length > 0) {
    console.log(`Strict-only tools (judgment-call candidates, review individually):`);
    for (const t of strictOnly) {
      console.log(`  ${pad(t.name, 32)} ${t.strict.join(',')}`);
    }
  }
}
