import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const GENERATOR = join(REPO_ROOT, 'apps', 'docs-site', 'scripts', 'generate-tool-docs.mjs');
const DOCS = join(REPO_ROOT, 'apps', 'docs-site', 'src', 'content', 'docs');

function splitTableRow(line) {
  const cells = [];
  let current = '';
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\' && line[index + 1] === '|') {
      current += '\\|';
      index++;
    } else if (line[index] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += line[index];
    }
  }
  cells.push(current.trim());
  return cells;
}

function rowFor(mdx, param) {
  const line = mdx.split('\n').find((l) => l.startsWith(`| \`${param}\``));
  assert.ok(line, `params table must have a ${param} row`);
  return splitTableRow(line);
}

function runGenerator(outDir, sourcePath) {
  const env = { ...process.env, RN_DEV_AGENT_DOCS_OUT: outDir };
  if (sourcePath) env.RN_DEV_AGENT_DOCS_SOURCE = sourcePath;
  else delete env.RN_DEV_AGENT_DOCS_SOURCE;
  execFileSync(process.execPath, [GENERATOR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  return join(outDir, 'tools');
}

test('#816 generated docs describe device_accept_system_dialog.timeoutMs as a number with its default', () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  try {
    const tools = runGenerator(out);
    const mdx = fs.readFileSync(join(tools, 'cdp', 'device_accept_system_dialog.mdx'), 'utf8');
    const cells = rowFor(mdx, 'timeoutMs');
    assert.equal(cells[2], '`number`', `timeoutMs must type as number, got ${cells[2]}`);
    assert.match(
      cells[6],
      /default 15000ms/i,
      'the timeout description must state the new default',
    );
    assert.match(cells[6], /120000/, 'explicit values up to 120000 remain documented');
    const dismissed = fs.readFileSync(
      join(tools, 'cdp', 'device_dismiss_system_dialog.mdx'),
      'utf8',
    );
    const dismissCells = rowFor(dismissed, 'timeoutMs');
    assert.equal(dismissCells[2], '`number`');
    assert.match(dismissCells[6], /default 15000ms/i);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('#816 generated docs give device_find.index a real type and non-empty description', () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  try {
    const tools = runGenerator(out);
    const mdx = fs.readFileSync(join(tools, 'device', 'device_find.mdx'), 'utf8');
    const cells = rowFor(mdx, 'index');
    assert.equal(cells[2], '`number`', `index must type as number, got ${cells[2]}`);
    assert.ok(cells[6].length > 0, 'index description must not be empty');
    assert.match(cells[6], /AMBIGUOUS_MATCH|candidate/i);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('#816 cdp_run_action.actionId keeps its correct string type through regeneration', () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  try {
    const tools = runGenerator(out);
    const mdx = fs.readFileSync(join(tools, 'cdp', 'cdp_run_action.mdx'), 'utf8');
    const cells = rowFor(mdx, 'actionId');
    assert.equal(cells[2], '`string`', `actionId must type as string, got ${cells[2]}`);
    assert.equal(cells[3], 'Yes', 'actionId is required');
    assert.ok(cells[6].length > 0, 'actionId description must not be empty');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('#816 generated descriptions decode supported TypeScript string escapes', async () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  const previousOut = process.env.RN_DEV_AGENT_DOCS_OUT;
  const previousSource = process.env.RN_DEV_AGENT_DOCS_SOURCE;
  try {
    process.env.RN_DEV_AGENT_DOCS_OUT = out;
    delete process.env.RN_DEV_AGENT_DOCS_SOURCE;
    const { decodeSupportedStringEscapes } = await import(
      `${pathToFileURL(GENERATOR).href}?escape-regression`
    );
    assert.equal(
      decodeSupportedStringEscapes(String.raw`line\ncolumn\tpath\\quote\'double\"tick\`\u2019`),
      'line\ncolumn\tpath\\quote\'double"tick`’',
    );
    assert.equal(
      decodeSupportedStringEscapes(String.raw`keep\r\x41\u{2019}\q`),
      String.raw`keep\r\x41\u{2019}\q`,
    );

    const tools = join(out, 'tools');
    const dismissed = fs.readFileSync(
      join(tools, 'cdp', 'device_dismiss_system_dialog.mdx'),
      'utf8',
    );
    assert.match(dismissed, /Cancel, Don’t Allow, Deny/);
    assert.doesNotMatch(dismissed, /Don\\\\u2019t Allow/);

    const dispatch = fs.readFileSync(join(tools, 'cdp', 'cdp_dispatch.mdx'), 'utf8');
    assert.match(dispatch, /the LLM's JSON encoder/);
    assert.doesNotMatch(dispatch, /LLM\\\\'s JSON encoder/);
  } finally {
    if (previousOut === undefined) delete process.env.RN_DEV_AGENT_DOCS_OUT;
    else process.env.RN_DEV_AGENT_DOCS_OUT = previousOut;
    if (previousSource === undefined) delete process.env.RN_DEV_AGENT_DOCS_SOURCE;
    else process.env.RN_DEV_AGENT_DOCS_SOURCE = previousSource;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('#816 generated description rows preserve backslashes, line breaks, and delimiters', () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  const sourcePath = join(out, 'fixture-index.ts');
  const source = Array.from(
    { length: 38 },
    (_, index) => String.raw`
trackedTool(
  'escape_fixture_${index}',
  'Fixture tool',
  {
    path: z.string().describe('Path ends in \\'),
    structured: z.string().describe('First\nSecond\u007CTail'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe(
        'Wrapped enum type',
      ),
  },
  () => {},
);`,
  ).join('\n');
  fs.writeFileSync(sourcePath, source);

  try {
    const tools = runGenerator(out, sourcePath);
    const mdx = fs.readFileSync(join(tools, 'cdp', 'escape_fixture_0.mdx'), 'utf8');
    const pathCells = rowFor(mdx, 'path');
    const structuredCells = rowFor(mdx, 'structured');
    const platformCells = rowFor(mdx, 'platform');

    assert.equal(pathCells[6], String.raw`Path ends in \\`);
    assert.equal(structuredCells.length, 8);
    assert.equal(structuredCells[6], 'First<br />Second&#124;Tail');
    assert.equal(platformCells.length, 8);
    assert.equal(platformCells[2], '`enum: ios \\| android`');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('#816 no generated tool page leaves a wrapped-zod param typed unknown with an empty description', () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  try {
    const tools = runGenerator(out);
    const failures = [];
    for (const category of fs.readdirSync(tools)) {
      const dir = join(tools, category);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        const mdx = fs.readFileSync(join(dir, file), 'utf8');
        if (!mdx.includes('## Parameters')) continue;
        for (const line of mdx.split('\n')) {
          if (!line.startsWith('| `') || line.includes('Name | Type')) continue;
          const cells = splitTableRow(line);
          if (cells[2] === '`unknown`' && cells[6] === '') {
            failures.push(`${file}: ${cells[1]}`);
          }
        }
      }
    }
    assert.deepEqual(
      failures,
      [],
      `params regressed to undocumented unknown (GH #816 signature): ${failures.join(', ')}`,
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('#816 committed tool docs are fresh against src/index.ts', () => {
  const out = fs.mkdtempSync(join(tmpdir(), 'gh816-docs-'));
  try {
    const tools = runGenerator(out);
    for (const [category, name] of [
      ['cdp', 'device_accept_system_dialog'],
      ['cdp', 'device_dismiss_system_dialog'],
      ['device', 'device_find'],
      ['cdp', 'cdp_run_action'],
      ['testing', 'maestro_test_all'],
      ['cdp', 'cdp_record_test_generate'],
      ['cdp', 'expect_redux'],
    ]) {
      const generated = fs.readFileSync(join(tools, category, `${name}.mdx`), 'utf8');
      assert.equal(
        generated,
        fs.readFileSync(join(DOCS, 'tools', category, `${name}.mdx`), 'utf8'),
        `committed docs for ${name} are stale — rerun corepack yarn docs:generate`,
      );
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
