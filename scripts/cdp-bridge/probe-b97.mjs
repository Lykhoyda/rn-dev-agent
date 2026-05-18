#!/usr/bin/env node
// B97 probe — empirical investigation of Android `input text` percent handling.
//
// Tests every plausible approach to preserve a literal `%s` in user text:
//   1. %% escaping (does input text treat %% → %)
//   2. Backslash escaping (\%s)
//   3. URL-style encoding (%25s)
//   4. Clipboard paste (cmd clipboard set-text + keyevent PASTE)
//   5. Per-character keyevent injection
//
// Also probes what other %X sequences input text interprets:
//   %s → space (known), %p, %n, %d, %%, lone %

import { execFileSync } from 'node:child_process';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function adbOk(args) {
  try { sh('adb', args); return { ok: true }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message).split('\n').slice(0, 2).join(' | ') }; }
}

function openSettingsSearch() {
  sh('adb', ['shell', 'am', 'start', '-a', 'android.settings.APP_SEARCH_SETTINGS']);
  sh('sh', ['-c', 'sleep 1.3']);
}

function clearField() {
  sh('adb', ['shell', 'input', 'keyevent', '123']);
  for (let i = 0; i < 80; i++) {
    try { sh('adb', ['shell', 'input', 'keyevent', '67']); } catch {}
  }
}

function readField() {
  sh('adb', ['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  const xml = sh('adb', ['shell', 'cat', '/sdcard/ui.xml']);
  const nodeRe = /<node [^>]*?(?:\/>|><\/node>)/g;
  for (const m of xml.matchAll(nodeRe)) {
    const n = m[0];
    if (!n.includes('android.widget.EditText')) continue;
    if (!/focused="true"/.test(n)) continue;
    const t = n.match(/ text="([^"]*)"/);
    // CodeQL js/double-escaping (alert #17): decode `&amp;` LAST. Decoding it
    // first would incorrectly turn `&amp;lt;` (literal text `&lt;`) into `<`.
    return t ? t[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : '';
  }
  return null;
}

// input text via single-quoted shell literal (matching our current code path)
function inputText(raw) {
  const escaped = raw.replace(/'/g, "'\\''");
  return adbOk(['shell', 'input', 'text', `'${escaped}'`]);
}

// clipboard paste approach
function clipboardPaste(text) {
  // Set clipboard content, then paste via keyevent
  const r1 = adbOk(['shell', 'cmd', 'clipboard', 'set-text', text]);
  if (!r1.ok) return r1;
  sh('sh', ['-c', 'sleep 0.3']);
  return adbOk(['shell', 'input', 'keyevent', '279']); // KEYCODE_PASTE
}

// broadcast-based clipboard (fallback for older API)
function clipboardPasteBroadcast(text) {
  const r1 = adbOk(['shell', 'am', 'broadcast', '-a', 'clipper.set', '-e', 'text', text]);
  if (!r1.ok) return r1;
  sh('sh', ['-c', 'sleep 0.3']);
  return adbOk(['shell', 'input', 'keyevent', '279']);
}

function runProbe(label, fillFn) {
  openSettingsSearch();
  clearField();
  const r = fillFn();
  sh('sh', ['-c', 'sleep 0.7']);
  const actual = readField();
  return { label, actual, err: r.ok ? null : r.err };
}

const platform = sh('adb', ['shell', 'getprop', 'ro.build.version.release']).trim();
const sdk = sh('adb', ['shell', 'getprop', 'ro.build.version.sdk']).trim();
const adbVer = sh('adb', ['--version']).split('\n')[0].trim();

console.log('B97 probe — Android input text % handling');
console.log('='.repeat(60));
console.log(`Device: Android ${platform} (API ${sdk})`);
console.log(`adb:    ${adbVer}`);
console.log();

// === Part 1: What does input text do with various % sequences? ===
console.log('--- Part 1: input text % sequence behavior ---');
const seqTests = [
  { label: '%s (space)', raw: 'a%sb' },
  { label: '%% (double)', raw: 'a%%b' },
  { label: '%%s (double then s)', raw: 'a%%sb' },
  { label: '%p', raw: 'a%pb' },
  { label: '%n', raw: 'a%nb' },
  { label: '%d', raw: 'a%db' },
  { label: '%t', raw: 'a%tb' },
  { label: 'lone %', raw: 'a%b' },
  { label: 'trailing %', raw: 'ab%' },
  { label: '%S (uppercase)', raw: 'a%Sb' },
];

for (const tc of seqTests) {
  const r = runProbe(tc.label, () => inputText(tc.raw));
  const ok = r.actual === tc.raw.replace(/%s/g, ' '); // only %s should become space
  console.log(`  ${tc.label.padEnd(25)} raw=${JSON.stringify(tc.raw).padEnd(12)} → field=${JSON.stringify(r.actual).padEnd(12)} ${r.err ? `ERR: ${r.err.slice(0,30)}` : ''}`);
}

// === Part 2: Can we escape %s to preserve it literally? ===
console.log('\n--- Part 2: escape strategies for literal %s ---');
const escTests = [
  { label: '%%s → literal %s?', raw: '%%s', expected: '%s' },
  { label: '\\%s → literal %s?', raw: '\\%s', expected: '%s' },
  { label: '%25s → literal %s?', raw: '%25s', expected: '%s' },
  { label: 'plain %s → space', raw: '%s', expected: ' ' },
];

for (const tc of escTests) {
  const r = runProbe(tc.label, () => inputText(tc.raw));
  const ok = r.actual === tc.expected;
  console.log(`  ${(ok ? 'PASS' : 'FAIL').padEnd(6)} ${tc.label.padEnd(28)} raw=${JSON.stringify(tc.raw).padEnd(12)} expected=${JSON.stringify(tc.expected).padEnd(8)} actual=${JSON.stringify(r.actual)}`);
}

// === Part 3: Clipboard paste approach ===
console.log('\n--- Part 3: clipboard paste (bypasses input text entirely) ---');
const clipTests = [
  { label: 'literal %s via clipboard', text: 'a%sb', expected: 'a%sb' },
  { label: 'spaces via clipboard', text: 'hello world', expected: 'hello world' },
  { label: 'mixed special via clip', text: "it's $100 (50% off)", expected: "it's $100 (50% off)" },
  { label: 'long via clipboard', text: 'abcdefghijklmnopqrstuvwxyz1234567890', expected: 'abcdefghijklmnopqrstuvwxyz1234567890' },
];

for (const tc of clipTests) {
  const r = runProbe(tc.label, () => clipboardPaste(tc.text));
  const ok = r.actual === tc.expected;
  console.log(`  ${(ok ? 'PASS' : 'FAIL').padEnd(6)} ${tc.label.padEnd(28)} expected=${JSON.stringify(tc.expected).padEnd(24)} actual=${JSON.stringify(r.actual)} ${r.err ? `ERR: ${r.err.slice(0,40)}` : ''}`);
}

console.log('\n--- Part 4: summary ---');
console.log('Done. Use these results to decide the B97 fix strategy.');
