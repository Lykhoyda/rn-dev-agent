#!/usr/bin/env node
// B96 end-to-end verification on real Android.
//
// Runs a matrix of realistic inputs through `androidClipboardFill`'s actual
// code path (bypassing the MCP server layer by importing the rebuilt dist
// directly, per the bench-issue-27.mjs pattern), reads the resulting field
// contents via `uiautomator dump`, and reports a pass/fail table.
//
// This script was the source of the empirical evidence that disproved the
// original B96 theory: the "outer single-quote wrapping" pattern is correct
// on adb 1.0.41 + Android API 37, and removing it breaks shell metacharacter
// handling. See the B96 GitHub Issue and docs/DECISIONS.md D582 for the full
// investigation record.
//
// Usage:
//   cd packages/rn-dev-agent-core && npm run build && node verify-b96.mjs

import { execFileSync } from 'node:child_process';
import { buildAdbInputTextArgv, splitChunkAroundPercentS } from './dist/tools/device-interact.js';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function adbOk(args) {
  try {
    sh('adb', args);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.message).split('\n').slice(0, 2).join(' | ') };
  }
}

function openSettingsSearch() {
  sh('adb', ['shell', 'am', 'start', '-a', 'android.settings.APP_SEARCH_SETTINGS']);
  sh('sh', ['-c', 'sleep 1.3']);
}

function clearFocusedField() {
  sh('adb', ['shell', 'input', 'keyevent', '123']); // MOVE_END
  for (let i = 0; i < 80; i++) {
    try {
      sh('adb', ['shell', 'input', 'keyevent', '67']);
    } catch {} // DEL
  }
}

function readFocusedField() {
  sh('adb', ['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const xml = sh('adb', ['shell', 'cat', '/sdcard/ui.xml']);
  const nodeRe = /<node [^>]*?(?:\/>|><\/node>)/g;
  for (const m of xml.matchAll(nodeRe)) {
    const n = m[0];
    if (!n.includes('android.widget.EditText')) continue;
    if (!/focused="true"/.test(n)) continue;
    const t = n.match(/ text="([^"]*)"/);
    return t ? decodeXml(t[1]) : '';
  }
  return null;
}

// CodeQL js/double-escaping (alert #18): decode `&amp;` LAST. Decoding it
// first would incorrectly turn `&amp;lt;` (literal text `&lt;`) into `<`.
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function runOne(input) {
  openSettingsSearch();
  clearFocusedField();
  const CHUNK = 10;
  let firstError = null;
  for (let i = 0; i < input.length; i += CHUNK) {
    const chunk = input.slice(i, i + CHUNK);
    const segments = splitChunkAroundPercentS(chunk);
    for (const seg of segments) {
      const argv = buildAdbInputTextArgv(seg);
      const r = adbOk(argv);
      if (!r.ok && !firstError) firstError = r.err;
    }
  }
  sh('sh', ['-c', 'sleep 0.7']);
  const actual = readFocusedField();
  return { actual, err: firstError };
}

const TEST_INPUTS = [
  { label: 'plain short', input: 'hello' },
  { label: 'long plain (>30)', input: 'abcdefghijklmnopqrstuvwxyz12345' },
  { label: 'with spaces', input: 'hello world foo' },
  { label: 'single apostrophe', input: "it's" },
  { label: 'two apostrophes', input: "a'b'c" },
  { label: 'shell metas $&|', input: 'a$b&c|d' },
  { label: 'shell metas <>', input: 'a<b>c' },
  { label: 'shell metas ();', input: 'a(b);c' },
  { label: 'backtick', input: 'a`b`c' },
  { label: 'backslash mid', input: 'a\\b\\c' },
  { label: 'realistic email', input: "user's email: a@b.com (test)" },
  { label: 'asterisk + square', input: 'a*b[c]' },
  { label: 'percent (B97 seed)', input: 'a%b' },
  { label: 'literal %s (B97)', input: 'a%sb' },
];

function platform() {
  const out = sh('adb', ['shell', 'getprop', 'ro.build.version.release']).trim();
  const sdk = sh('adb', ['shell', 'getprop', 'ro.build.version.sdk']).trim();
  return `Android ${out} (API ${sdk})`;
}

const adbVer = sh('adb', ['--version']).split('\n')[0].trim();

console.log('B96 verification — shipping code end-to-end');
console.log('='.repeat(72));
console.log(`Device: ${platform()}`);
console.log(`adb:    ${adbVer}`);
console.log();

function trunc(s, n) {
  if (s == null) return '(null)';
  if (s.length > n) return JSON.stringify(s).slice(0, n - 1) + '…';
  return JSON.stringify(s);
}

let pass = 0;
let fail = 0;

console.log('label'.padEnd(22), 'input'.padEnd(32), 'result'.padEnd(8), 'field content');
console.log('-'.repeat(90));

for (const tc of TEST_INPUTS) {
  const res = runOne(tc.input);
  const ok = res.err == null && res.actual === tc.input;
  if (ok) pass++;
  else fail++;
  console.log(
    tc.label.padEnd(22),
    trunc(tc.input, 30).padEnd(32),
    (ok ? 'PASS' : 'FAIL').padEnd(8),
    res.err ? `ERR: ${res.err.slice(0, 40)}` : trunc(res.actual, 30),
  );
}

console.log();
console.log(`${pass}/${TEST_INPUTS.length} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
