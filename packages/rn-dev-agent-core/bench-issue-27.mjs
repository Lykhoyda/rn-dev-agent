#!/usr/bin/env node
// Benchmark harness for GitHub issue #27 tools (Phase 79).
// Imports compiled dist handlers directly — does NOT use the MCP server.
// Usage: cd packages/rn-dev-agent-core && node bench-issue-27.mjs [--platform ios|android|both] [--verbose]

import { performance } from 'node:perf_hooks';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const { createDeviceFindHandler, createDeviceFocusNextHandler } =
  await import('./dist/tools/device-interact.js');
const { createDeviceDeeplinkHandler } = await import('./dist/tools/device-deeplink.js');
const { createDeviceAcceptSystemDialogHandler } =
  await import('./dist/tools/device-system-dialog.js');
const { createDevicePickValueHandler, createDevicePickDateHandler } =
  await import('./dist/tools/device-picker.js');
const { setActiveSession, clearActiveSession, runAgentDevice } =
  await import('./dist/agent-device-wrapper.js');

const args = process.argv.slice(2);
const platformArg = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : 'both';
const verbose = args.includes('--verbose');
const PLATFORMS = platformArg === 'both' ? ['ios', 'android'] : [platformArg];

function safeWrite(path, content) {
  try {
    writeFileSync(path, content);
    return path;
  } catch {
    if (!existsSync('./bench-results')) mkdirSync('./bench-results');
    const fb = './bench-results/' + path.split('/').pop();
    writeFileSync(fb, content);
    return fb;
  }
}

function tryParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function time(name, fn) {
  const start = performance.now();
  let result, error;
  try {
    result = await fn();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Math.round(performance.now() - start);
  const envelope = result ? tryParse(result.content?.[0]?.text) : null;
  const ok = result && !result.isError && !error;
  const status = error ? 'throw' : ok ? 'pass' : 'fail';
  if (verbose) console.error(`  [${status}] ${name} — ${ms}ms ${error ? '(' + error + ')' : ''}`);
  return { name, ms, status, error, envelope };
}

async function waitForAndroid(maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFile('adb', ['devices'], { timeout: 5000 });
      if (/emulator-\d+\s+device$/m.test(stdout)) {
        const { stdout: boot } = await execFile('adb', ['shell', 'getprop', 'sys.boot_completed'], {
          timeout: 5000,
        });
        if (boot.trim() === '1') return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function openSession(appId, platform, deviceId) {
  const result = await runAgentDevice([
    'open',
    appId,
    '--platform',
    platform,
    '--session',
    `bench-${platform}-${Date.now()}`,
  ]);
  if (result.isError) return false;
  const env = tryParse(result.content[0].text);
  if (env?.ok && env.data?.session) {
    setActiveSession({ name: env.data.session, platform, deviceId, openedAt: Date.now() });
    return true;
  }
  return false;
}

async function runIosBench() {
  const results = [];
  console.log('\n## iOS — iPhone 17 Pro\n');

  const deeplink = createDeviceDeeplinkHandler();
  results.push(
    await time('G1 device_deeplink https://apple.com', () =>
      deeplink({ url: 'https://apple.com', platform: 'ios' }),
    ),
  );
  await new Promise((r) => setTimeout(r, 1000));
  results.push(
    await time('G1 device_deeplink maps://?q=Apple+Park', () =>
      deeplink({ url: 'maps://?q=Apple+Park', platform: 'ios' }),
    ),
  );
  await new Promise((r) => setTimeout(r, 1000));
  results.push(
    await time('G1 device_deeplink (auto platform detect)', () =>
      deeplink({ url: 'https://example.com' }),
    ),
  );
  await new Promise((r) => setTimeout(r, 1000));

  const sessionOk = await openSession('com.apple.mobilesafari', 'ios');
  results.push({
    name: 'session:open com.apple.mobilesafari',
    ms: 0,
    status: sessionOk ? 'pass' : 'fail',
    envelope: null,
  });
  if (!sessionOk) {
    console.log('WARNING: Could not open Safari session. Skipping session-bound tests.');
    return results;
  }
  await new Promise((r) => setTimeout(r, 1500));

  results.push(await time('baseline: device_snapshot', () => runAgentDevice(['snapshot', '-i'])));

  const find = createDeviceFindHandler();
  results.push(await time('G5 device_find("URL") baseline', () => find({ text: 'URL' })));
  results.push(
    await time('G5 device_find("URL", exact:true)', () => find({ text: 'URL', exact: true })),
  );
  results.push(
    await time('G5 device_find("Tabs", index:0)', () => find({ text: 'Tabs', index: 0 })),
  );
  results.push(
    await time('G5 device_find NOT_FOUND (exact)', () =>
      find({ text: 'ThisDoesNotExist_ZZZ', exact: true }),
    ),
  );
  results.push(
    await time('G5 device_find INDEX_OUT_OF_RANGE', () => find({ text: 'URL', index: 999 })),
  );

  const focusNext = createDeviceFocusNextHandler();
  results.push(await time('G6 device_focus_next (no keyboard)', () => focusNext({})));

  const accept = createDeviceAcceptSystemDialogHandler();
  results.push(
    await time('G2 device_accept_system_dialog (no dialog)', () =>
      accept({ platform: 'ios', timeoutMs: 8000 }),
    ),
  );

  const pickValue = createDevicePickValueHandler();
  results.push(
    await time('G3 device_pick_value (no picker)', () =>
      pickValue({ value: 'DoesNotExist', platform: 'ios', timeoutMs: 8000 }),
    ),
  );

  const pickDate = createDevicePickDateHandler();
  results.push(
    await time('G3 device_pick_date (invalid format)', () =>
      pickDate({ date: 'not-a-date', platform: 'ios' }),
    ),
  );
  results.push(
    await time('G3 device_pick_date 2026-05-15 (no picker visible)', () =>
      pickDate({ date: '2026-05-15', platform: 'ios', timeoutMs: 15000 }),
    ),
  );

  await runAgentDevice(['close']).catch(() => {});
  clearActiveSession();
  return results;
}

async function runAndroidBench(deviceId) {
  const results = [];
  console.log(`\n## Android — ${deviceId}\n`);

  const deeplink = createDeviceDeeplinkHandler();
  results.push(
    await time('G1 device_deeplink https://example.com', () =>
      deeplink({ url: 'https://example.com', platform: 'android' }),
    ),
  );
  await new Promise((r) => setTimeout(r, 1500));
  results.push(
    await time('G1 device_deeplink totallyfake://nowhere', () =>
      deeplink({ url: 'totallyfake://nowhere', platform: 'android' }),
    ),
  );

  const sessionOk =
    (await openSession('com.android.chrome', 'android', deviceId)) ||
    (await openSession('com.android.settings', 'android', deviceId));
  results.push({
    name: 'session:open chrome OR settings',
    ms: 0,
    status: sessionOk ? 'pass' : 'fail',
    envelope: null,
  });
  if (!sessionOk) return results;
  await new Promise((r) => setTimeout(r, 1500));

  results.push(await time('baseline: device_snapshot', () => runAgentDevice(['snapshot', '-i'])));

  const find = createDeviceFindHandler();
  results.push(await time('G5 device_find("Search") baseline', () => find({ text: 'Search' })));
  results.push(
    await time('G5 device_find("Search", exact:true)', () => find({ text: 'Search', exact: true })),
  );
  results.push(
    await time('G5 device_find("Settings", index:0)', () => find({ text: 'Settings', index: 0 })),
  );

  const focusNext = createDeviceFocusNextHandler();
  results.push(await time('G6 device_focus_next (no keyboard)', () => focusNext({})));

  const accept = createDeviceAcceptSystemDialogHandler();
  results.push(
    await time('G2 device_accept_system_dialog (no dialog)', () =>
      accept({ platform: 'android', timeoutMs: 8000 }),
    ),
  );

  const pickDate = createDevicePickDateHandler();
  results.push(
    await time('G3 device_pick_date 2026-05-15 (no picker visible)', () =>
      pickDate({ date: '2026-05-15', platform: 'android', timeoutMs: 15000 }),
    ),
  );

  await runAgentDevice(['close']).catch(() => {});
  clearActiveSession();
  return results;
}

function printTable(results) {
  console.log(`| Tool | Duration | Status | Details |`);
  console.log(`|------|---------:|:------:|---------|`);
  for (const r of results) {
    const details = r.envelope?.error
      ? r.envelope.error.slice(0, 60)
      : r.envelope?.data?.code
        ? String(r.envelope.data.code)
        : r.envelope?.meta?.fallbackUsed
          ? `fallbackUsed=${r.envelope.meta.fallbackUsed}`
          : r.envelope?.meta?.code
            ? String(r.envelope.meta.code)
            : '';
    const icon = r.status === 'pass' ? 'OK' : r.status === 'fail' ? 'FAIL' : 'THROW';
    console.log(`| ${r.name} | ${r.ms}ms | ${icon} | ${details} |`);
  }
}

async function main() {
  console.log('# Phase 79 — Issue #27 Tool Benchmark');
  console.log(
    `_Run at ${new Date().toISOString()} — Node ${process.version} on ${process.platform}_`,
  );
  const all = {};

  if (PLATFORMS.includes('ios')) {
    all.ios = await runIosBench();
    printTable(all.ios);
    const p = safeWrite('/tmp/issue-27-bench-ios.json', JSON.stringify(all.ios, null, 2));
    console.log(`_iOS sidecar: ${p}_`);
  }

  if (PLATFORMS.includes('android')) {
    console.log('\n...waiting for Android emulator...');
    const ready = await waitForAndroid();
    if (!ready) {
      console.log('WARNING: Android emulator not ready after 2 minutes. Skipping.');
    } else {
      const { stdout } = await execFile('adb', ['devices']);
      const match = stdout.match(/(emulator-\d+)\s+device/);
      const deviceId = match ? match[1] : 'emulator-unknown';
      all.android = await runAndroidBench(deviceId);
      printTable(all.android);
      const p = safeWrite('/tmp/issue-27-bench-android.json', JSON.stringify(all.android, null, 2));
      console.log(`_Android sidecar: ${p}_`);
    }
  }

  safeWrite('/tmp/issue-27-bench-all.json', JSON.stringify(all, null, 2));
}

main().catch((err) => {
  console.error('Bench crashed:', err);
  process.exit(1);
});
