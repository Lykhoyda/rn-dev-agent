// GH#525 review r3798017297: generate-tool-docs.mjs only recognizes a param
// type when the zod chain starts right at the colon (`z.boolean…`, no break
// after `z`) and only captures .describe() text when the quote immediately
// follows `describe(`. A formatter-wrapped walkUp declaration published the
// param as an undocumented `unknown`, hiding the boolean contract. Pin the
// discovery surface: the committed docs page must expose walkUp as a described
// boolean plus its safety contract, and the source declaration must keep the
// generator-parseable single-line shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const MDX = join(
  REPO_ROOT,
  'apps',
  'docs-site',
  'src',
  'content',
  'docs',
  'tools',
  'cdp',
  'cdp_interact.mdx',
);
const INDEX_TS = join(REPO_ROOT, 'packages', 'rn-dev-agent-core', 'src', 'index.ts');

test('#525 the generated cdp_interact docs expose walkUp as a described boolean', () => {
  const mdx = fs.readFileSync(MDX, 'utf8');
  const row = mdx.split('\n').find((l) => l.startsWith('| `walkUp`'));
  assert.ok(row, 'the params table must have a walkUp row');
  const cells = (row as string).split('|').map((c) => c.trim());
  assert.equal(cells[2], '`boolean`', `walkUp type must be boolean, got ${cells[2]}`);
  assert.equal(cells[3], 'No', 'walkUp must stay optional');
  assert.match(cells[6], /pressable/i, 'the walkUp row must describe the pressable-ancestor walk');
});

test('#525 the walkUp safety contract stays discoverable on the docs page', () => {
  // Scope every safety phrase to the walkUp sentence run inside the single-line
  // description body — unrelated page text (e.g. the accessibilityLabel
  // ambiguity note) and later table rows must not satisfy it.
  const mdx = fs.readFileSync(MDX, 'utf8');
  const start = mdx.indexOf('walkUp (');
  assert.ok(start !== -1, 'the page body must carry the walkUp contract block');
  const contract = mdx.slice(start, mdx.indexOf('\n', start));
  assert.match(contract, /opt-in/i, 'the contract must present walkUp as opt-in');
  assert.match(contract, /action:"press"/, 'the contract must restrict walkUp to press');
  assert.match(
    contract,
    /testID\/accessibilityLabel/,
    'the contract must restrict walkUp to testID/accessibilityLabel selectors',
  );
  assert.match(contract, /8 fiber ancestors/, 'the contract must state the ancestor bound');
  assert.match(contract, /ambigu/i, 'the contract must state the ambiguity refusal');
  assert.match(contract, /pressable/i, 'the contract must describe the pressable walk');
});

test('#525 the walkUp declaration keeps the generator-parseable single-line shape', () => {
  const src = fs.readFileSync(INDEX_TS, 'utf8');
  assert.match(
    src,
    /^\s*walkUp: z\.boolean\(\)\.optional\(\)\.describe\('[^'\n]+'\),$/m,
    'walkUp must stay a one-line z.boolean() chain with an inline describe string ' +
      '(AGENTS.md: the docs generator drops formatter-wrapped declarations)',
  );
});
