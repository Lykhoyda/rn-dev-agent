import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const INDEX_TS = resolve(ROOT, 'scripts/cdp-bridge/src/index.ts');
const OUT_BASE = resolve(__dirname, '../src/content/docs/tools');

const CATEGORIES = {
  cdp_status: 'cdp', cdp_connect: 'cdp', cdp_disconnect: 'cdp',
  cdp_targets: 'cdp', cdp_evaluate: 'cdp', cdp_reload: 'cdp',
  cdp_component_tree: 'cdp', cdp_component_state: 'cdp',
  cdp_navigation_state: 'cdp', cdp_nav_graph: 'cdp', cdp_navigate: 'cdp',
  cdp_store_state: 'cdp', cdp_dispatch: 'cdp', cdp_dev_settings: 'cdp',
  cdp_interact: 'cdp', cdp_network_log: 'cdp', cdp_console_log: 'cdp',
  cdp_error_log: 'cdp', collect_logs: 'cdp',
  device_list: 'device', device_screenshot: 'device', device_snapshot: 'device',
  device_find: 'device', device_press: 'device', device_fill: 'device',
  device_swipe: 'device', device_scroll: 'device', device_scrollintoview: 'device',
  device_back: 'device', device_longpress: 'device', device_pinch: 'device',
  device_permission: 'device', device_batch: 'device',
  cdp_auto_login: 'testing', proof_step: 'testing',
  maestro_run: 'testing', maestro_generate: 'testing', maestro_test_all: 'testing',
};

const SORT_ORDER = Object.keys(CATEGORIES);

function extractBalancedBlock(source, startIdx) {
  let depth = 0;
  let i = startIdx;
  while (i < source.length) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(startIdx + 1, i);
    }
    i++;
  }
  return null;
}

function extractTrackedToolBlocks(source) {
  const blocks = [];
  const marker = 'trackedTool(';
  let pos = 0;
  while ((pos = source.indexOf(marker, pos)) !== -1) {
    const openParen = pos + marker.length - 1;
    const block = extractBalancedBlock(source, openParen);
    if (block) blocks.push(block);
    pos = openParen + (block?.length ?? 1) + 1;
  }
  return blocks;
}

function parseStringLiteral(text, startPos) {
  const quote = text[startPos];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let i = startPos + 1;
  let result = '';
  while (i < text.length) {
    if (text[i] === '\\') {
      if (quote === "'" && text[i + 1] === "'") { result += "'"; i += 2; continue; }
      result += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (text[i] === quote) return { value: result, end: i + 1 };
    result += text[i++];
  }
  return null;
}

function extractBalancedBraces(text, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
      inString = true; stringChar = ch;
    } else if (inString && ch === stringChar && text[i - 1] !== '\\') {
      inString = false;
    } else if (!inString) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseZodType(def) {
  if (def.startsWith('z.enum')) {
    const m = def.match(/z\.enum\(\[([^\]]+)\]/);
    if (m) {
      const vals = m[1].replace(/['"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
      return `enum: ${vals.join(' | ')}`;
    }
    return 'enum';
  }
  if (def.startsWith('z.array(z.object')) return 'object[]';
  if (def.startsWith('z.array(z.enum')) {
    const m = def.match(/z\.array\(z\.enum\(\[([^\]]+)\]/);
    if (m) {
      const vals = m[1].replace(/['"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
      return `(${vals.join(' | ')})[]`;
    }
    return 'enum[]';
  }
  if (def.startsWith('z.array')) return 'array';
  if (def.startsWith('z.record')) return 'Record<string, unknown>';
  if (def.startsWith('z.any')) return 'any';
  if (def.startsWith('z.string')) return 'string';
  if (def.startsWith('z.number')) return 'number';
  if (def.startsWith('z.boolean')) return 'boolean';
  if (def.startsWith('z.object')) return 'object';
  return 'unknown';
}

function extractSchemaParams(schemaText) {
  const inner = schemaText.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  if (!inner.trim()) return [];

  const lines = splitTopLevel(inner);
  const params = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim();
    const def = line.slice(colonIdx + 1).trim();

    const param = { name, type: '', required: true, defaultValue: null, description: '', constraints: [] };

    param.type = parseZodType(def);
    if (def.includes('.optional()')) param.required = false;

    const defMatch = def.match(/\.default\((\[.*?\]|[^)]+)\)/);
    if (defMatch) { param.defaultValue = defMatch[1].trim(); param.required = false; }

    const descRe = /\.describe\((['"`])([\s\S]*?)\1\s*\)/g;
    let descMatch;
    let lastDesc = null;
    while ((descMatch = descRe.exec(def)) !== null) lastDesc = descMatch[2];
    if (lastDesc) param.description = lastDesc;

    const minMatch = def.match(/\.min\(([^)]+)\)/);
    const maxMatch = def.match(/\.max\(([^)]+)\)/);
    if (minMatch) param.constraints.push(`min: ${minMatch[1]}`);
    if (maxMatch) param.constraints.push(`max: ${maxMatch[1]}`);
    if (def.includes('.int()')) param.constraints.push('integer');

    params.push(param);
  }
  return params;
}

function blockToTool(block) {
  let pos = 0;
  while (pos < block.length && !"'\"`".includes(block[pos])) pos++;
  const nameResult = parseStringLiteral(block, pos);
  if (!nameResult) return null;
  const name = nameResult.value;
  pos = nameResult.end;

  while (pos < block.length && !"'\"`".includes(block[pos])) pos++;
  const descResult = parseStringLiteral(block, pos);
  if (!descResult) return null;
  const description = descResult.value;
  pos = descResult.end;

  while (pos < block.length && block[pos] !== '{') pos++;
  const schemaText = extractBalancedBraces(block, pos);
  if (!schemaText) return null;
  const params = extractSchemaParams(schemaText);

  return { name, description, params };
}

function escapeYaml(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeMdx(str) {
  return str.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/</g, '&lt;');
}

function generateMdx(tool) {
  const isDeprecated = tool.description.toLowerCase().includes('deprecated');
  const sortIdx = SORT_ORDER.indexOf(tool.name);
  const sidebar = sortIdx >= 0 ? `\nsidebar:\n  order: ${sortIdx}` : '';

  const paramRows = tool.params.map(p => {
    const constraints = p.constraints.length ? p.constraints.join(', ') : '';
    const def = p.defaultValue ?? '';
    const req = p.required ? 'Yes' : 'No';
    return `| \`${p.name}\` | \`${p.type}\` | ${req} | ${def ? `\`${def}\`` : ''} | ${constraints} | ${escapeMdx(p.description)} |`;
  }).join('\n');

  const paramsSection = tool.params.length > 0 ? `
## Parameters

| Name | Type | Required | Default | Constraints | Description |
|------|------|----------|---------|-------------|-------------|
${paramRows}
` : '\nThis tool takes no parameters.\n';

  const deprecatedNote = isDeprecated ? `\n:::caution[Deprecated]\nThis tool is deprecated. ${escapeMdx(tool.description)}\n:::\n` : '';
  const descBlock = isDeprecated ? '' : `\n${escapeMdx(tool.description)}\n`;

  const requiredParams = tool.params.filter(p => p.required);
  const usageArgs = requiredParams.map(p => `${p.name}: <${p.type}>`).join(', ');
  const usage = requiredParams.length > 0
    ? `${tool.name}(${usageArgs})`
    : `${tool.name}()`;

  return `---
title: "${escapeYaml(tool.name)}"
description: "${escapeYaml(tool.description.split('.')[0])}"${sidebar}
---
${deprecatedNote}${descBlock}${paramsSection}
## Usage

\`\`\`
${usage}
\`\`\`
`;
}

// --- Main ---
const source = readFileSync(INDEX_TS, 'utf8');
const blocks = extractTrackedToolBlocks(source);
const tools = blocks.map(blockToTool).filter(Boolean);

console.log(`Extracted ${tools.length} tools from index.ts`);

if (tools.length < 38) {
  console.error(`Expected >= 38 tools, got ${tools.length}. Check extractor logic.`);
  process.exit(1);
}

for (const tool of tools) {
  const category = CATEGORIES[tool.name] ?? 'cdp';
  const outDir = resolve(OUT_BASE, category);
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${tool.name}.mdx`);

  if (existsSync(outPath)) {
    const existing = readFileSync(outPath, 'utf8');
    if (existing.includes('<!-- hand-edited: true -->')) {
      console.log(`  skip (hand-edited): ${tool.name}`);
      continue;
    }
  }
  writeFileSync(outPath, generateMdx(tool));
  console.log(`  generated: tools/${category}/${tool.name}.mdx`);
}

// Copy CHANGELOG.md with frontmatter injection
const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
const changelogOut = resolve(__dirname, '../src/content/docs/changelog.md');
mkdirSync(dirname(changelogOut), { recursive: true });
writeFileSync(changelogOut, `---
title: "Changelog"
description: "Release history for rn-dev-agent"
---

${changelog}`);
console.log('  copied: changelog.md (with frontmatter)');

console.log('Done.');
