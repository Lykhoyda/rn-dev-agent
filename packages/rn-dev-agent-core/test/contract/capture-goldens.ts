// GH #437 (test-confidence audit P0-B): capture REAL runner wire payloads
// into committed golden fixtures under test/fixtures/goldens/<platform>/.
// Goldens are captured, never hand-written — the escaped-bug cluster this
// closes (#396, #353, #418) was hand-written fixtures encoding the WRONG
// shape, so green tests certified broken behavior.
//
// Usage (fixture app installed on the booted device, see test-fixtures/):
//   GOLDEN_PLATFORM=ios     node test/contract/capture-goldens.ts
//   GOLDEN_PLATFORM=android node test/contract/capture-goldens.ts
//
// What it records, per platform, in ONE live session:
//   health.json            raw GET /health body (runner HTTP, no bridge)
//   command-snapshot.json  raw POST /command {command:'snapshot'} body —
//                          the pre-mapping RunnerSnapshotNode wire shape
//   command-error.json     raw POST /command with an unknown verb — the
//                          runner's error-envelope shape
//   tool-envelope-snapshot.json  the bridge's device_snapshot envelope from
//                          the same session — the post-mapping FlatNode shape
//                          findRefByTestID and friends consume
//
// Re-capture cadence: whenever RUNNER_PROTOCOL_VERSION bumps or the runner
// wire shape changes. gh-437-golden-contract.test.ts pins the captured `v`
// stamp to the current RUNNER_PROTOCOL_VERSION, so a protocol bump fails CI
// until the goldens are re-captured against the new runner.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- untyped JS test helper
import { startSupervisor } from '../helpers/supervisor-harness.js';
import { runnerStatePath, readJsonStateFile } from '../../dist/util/secure-state-file.js';

const PLATFORM = process.env.GOLDEN_PLATFORM;
const APP_ID = process.env.GOLDEN_APP_ID ?? 'dev.lykhoyda.rndevagent.fixture';
const DEVICE_ID = process.env.GOLDEN_DEVICE_ID;
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'goldens',
  PLATFORM ?? 'unknown',
);

if (PLATFORM !== 'ios' && PLATFORM !== 'android') {
  console.error('GOLDEN_PLATFORM must be "ios" or "android"');
  process.exit(1);
}

function sh(cmd: string, args: string[], timeout = 15_000): string {
  return execFileSync(cmd, args, { stdio: 'pipe', timeout }).toString();
}

function assertFixtureInstalled(): void {
  try {
    if (PLATFORM === 'ios') {
      sh('xcrun', ['simctl', 'get_app_container', DEVICE_ID ?? 'booted', APP_ID]);
    } else if (!sh('adb', ['shell', 'pm', 'path', APP_ID]).includes('package:')) {
      throw new Error('not installed');
    }
  } catch {
    console.error(
      `Fixture app ${APP_ID} is not installed on the booted ${PLATFORM} device.\n` +
        `Build + install it first — see test-fixtures/${PLATFORM}-fixture/README.md`,
    );
    process.exit(1);
  }
}

function launchFixture(): void {
  if (PLATFORM === 'ios') {
    sh('xcrun', ['simctl', 'launch', DEVICE_ID ?? 'booted', APP_ID], 30_000);
  } else {
    sh('adb', ['shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`], 30_000);
  }
}

function deviceProvenance(): { device: string; os: string } {
  if (PLATFORM === 'ios') {
    const booted = (
      JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])) as {
        devices: Record<string, Array<{ name: string; udid: string }>>;
      }
    ).devices;
    for (const [runtime, devs] of Object.entries(booted)) {
      const device = DEVICE_ID ? devs.find((candidate) => candidate.udid === DEVICE_ID) : devs[0];
      if (device) {
        return {
          device: `${device.name} (${device.udid})`,
          os: runtime.replace('com.apple.CoreSimulator.SimRuntime.', ''),
        };
      }
    }
    return { device: 'unknown-booted-simulator', os: 'unknown' };
  }
  return {
    device: sh('adb', ['shell', 'getprop', 'ro.product.model']).trim(),
    os: `Android ${sh('adb', ['shell', 'getprop', 'ro.build.version.release']).trim()}`,
  };
}

/** UDID of the booted simulator (iOS) or the adb serial (Android). */
function deviceKey(): string {
  if (DEVICE_ID) return DEVICE_ID;
  if (PLATFORM === 'ios') {
    const booted = (
      JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])) as {
        devices: Record<string, Array<{ udid: string }>>;
      }
    ).devices;
    for (const devs of Object.values(booted)) {
      if (devs.length > 0) return devs[0].udid;
    }
    throw new Error('no booted iOS simulator');
  }
  const lines = sh('adb', ['devices'])
    .split('\n')
    .filter((l) => l.endsWith('\tdevice'));
  if (lines.length === 0) throw new Error('no adb device attached');
  return lines[0].split('\t')[0];
}

/**
 * The bridge persists runner state (port for iOS, forwarded hostPort for
 * Android) under <stateDir>/runner-state/<platform>-<device>.json. Pin the
 * lookup to the exact device this capture session opened on — a freshest-file
 * heuristic could silently read a stale or concurrent session's runner.
 */
function discoverRunnerPort(): number {
  const path = runnerStatePath(`${PLATFORM}-${deviceKey()}`);
  const state = readJsonStateFile<{ port?: number; hostPort?: number }>(path);
  const port = PLATFORM === 'ios' ? state?.port : (state?.hostPort ?? state?.port);
  if (typeof port !== 'number') {
    throw new Error(`no live runner port in ${path} — did the session open on this device?`);
  }
  return port;
}

interface Captured {
  httpStatus: number;
  body: unknown;
}

// Mirrors the production clients' slow-command ceiling (snapshot can run
// long while the runner serializes a large tree) — a wedged runner must
// fail the capture, not hang it.
const RAW_HTTP_TIMEOUT_MS = 35_000;

async function rawGet(port: number, path: string): Promise<Captured> {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(RAW_HTTP_TIMEOUT_MS),
  });
  return { httpStatus: resp.status, body: await resp.json() };
}

async function rawCommand(port: number, body: Record<string, unknown>): Promise<Captured> {
  const resp = await fetch(`http://127.0.0.1:${port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RAW_HTTP_TIMEOUT_MS),
  });
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { unparseableBody: text.slice(0, 2000) };
  }
  return { httpStatus: resp.status, body: parsed };
}

function writeGolden(name: string, captured: Captured, extra: Record<string, unknown> = {}): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const { device, os } = deviceProvenance();
  const golden = {
    _provenance: {
      capturedAt: new Date().toISOString(),
      capturedBy: 'test/contract/capture-goldens.ts — captured, never hand-edit',
      recapture:
        're-run when RUNNER_PROTOCOL_VERSION bumps or the runner wire shape changes ' +
        `(GOLDEN_PLATFORM=${PLATFORM} node test/contract/capture-goldens.ts)`,
      platform: PLATFORM,
      device,
      os,
      appId: APP_ID,
      httpStatus: captured.httpStatus,
      ...extra,
    },
    payload: captured.body,
  };
  const outPath = join(OUT_DIR, name);
  writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n');
  console.log(`wrote ${outPath} (HTTP ${captured.httpStatus})`);
}

async function rpc(s: any, method: string, params?: unknown) {
  const id = s.send(method, params);
  for (;;) {
    const line = JSON.parse(await s.nextLine());
    if (line.id === id) return line;
  }
}

async function callTool(s: any, name: string, args: Record<string, unknown> = {}) {
  const line = await rpc(s, 'tools/call', { name, arguments: args });
  const text: string = line.result?.content?.[0]?.text ?? '';
  let envelope: any = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    /* non-JSON tool output */
  }
  return { isError: Boolean(line.result?.isError), envelope, text };
}

async function main(): Promise<void> {
  assertFixtureInstalled();
  launchFixture();

  const cwd = mkdtempSync(join(tmpdir(), 'rn-agent-goldens-'));
  const s = startSupervisor({ cwd, lineTimeoutMs: 600_000, env: { RN_RUNNER_BUILD: 'local' } });
  let opened = false;
  try {
    const init = await rpc(s, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capture-goldens', version: '1.0.0' },
    });
    if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init).slice(0, 300)}`);
    s.notify('notifications/initialized');

    const open = await callTool(s, 'device_snapshot', {
      action: 'open',
      platform: PLATFORM,
      appId: APP_ID,
      attachOnly: true,
      ...(DEVICE_ID ? { deviceId: DEVICE_ID } : {}),
    });
    if (open.envelope?.ok !== true) {
      console.error('--- supervisor stderr tail ---\n' + s.stderrText().slice(-4000));
      throw new Error(`session open failed: ${open.text.slice(0, 500)}`);
    }
    opened = true;

    // Post-mapping layer first: the bridge's own snapshot envelope, exactly
    // what findRefByTestID / parseSnapshotEnvelope consume in production.
    const toolSnap = await callTool(s, 'device_snapshot', { action: 'snapshot' });
    if (toolSnap.envelope?.ok !== true) {
      throw new Error(`device_snapshot failed: ${toolSnap.text.slice(0, 500)}`);
    }

    // Raw wire layer: talk to the runner's HTTP surface directly. A golden
    // that captured a failure would pin the WRONG contract, so success-path
    // payloads are asserted healthy before anything is written (the unknown-
    // verb golden is the one deliberate error capture).
    const port = discoverRunnerPort();
    const health = await rawGet(port, '/health');
    const healthBody = health.body as {
      ok?: boolean;
      runnerVersion?: string;
      protocolVersion?: number;
    };
    if (health.httpStatus !== 200 || healthBody?.ok !== true) {
      throw new Error(
        `/health not healthy: HTTP ${health.httpStatus} ${JSON.stringify(health.body).slice(0, 300)}`,
      );
    }
    const stamp = {
      runnerVersion: healthBody.runnerVersion,
      protocolVersion: healthBody.protocolVersion,
      runnerPort: port,
    };

    const rawSnap = await rawCommand(port, { command: 'snapshot', appBundleId: APP_ID });
    const rawSnapBody = rawSnap.body as { ok?: boolean; data?: { nodes?: unknown[] } };
    if (
      rawSnap.httpStatus !== 200 ||
      rawSnapBody?.ok !== true ||
      !Array.isArray(rawSnapBody?.data?.nodes) ||
      rawSnapBody.data.nodes.length === 0
    ) {
      throw new Error(
        `raw snapshot unhealthy: HTTP ${rawSnap.httpStatus} ${JSON.stringify(rawSnap.body).slice(0, 300)}`,
      );
    }

    writeGolden('health.json', health, stamp);
    writeGolden('command-snapshot.json', rawSnap, stamp);
    writeGolden(
      'command-error.json',
      await rawCommand(port, { command: 'gh437-unknown-command-probe' }),
      { ...stamp, note: 'deliberately unknown verb — pins the error-envelope shape' },
    );
    writeGolden(
      'tool-envelope-snapshot.json',
      { httpStatus: 200, body: toolSnap.envelope },
      { ...stamp, note: 'bridge device_snapshot envelope (post-mapping FlatNode layer)' },
    );
  } finally {
    if (opened) {
      // Close from the failure path too — an open session left behind keeps
      // device locks / adb forwards / the native runner alive.
      await callTool(s, 'device_snapshot', { action: 'close' }).catch((err) => {
        console.error(`session close failed (continuing): ${err}`);
      });
    }
    s.child.kill('SIGTERM');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
