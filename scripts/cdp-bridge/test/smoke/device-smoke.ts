// Story 06 Phase B (#387): golden device_* command set through the real
// bridge (dist/supervisor.js over MCP stdio) against the contract fixture
// app (test-fixtures/). SMOKE_PLATFORM=ios|android selects the lane. CDP is
// intentionally absent — device_fill exercises its native read-back path.
// RN_RUNNER_BUILD=local pins runner provenance to the checkout's own build.
// Executed directly as TypeScript via Node >= 22.18 type stripping (a .mjs
// file would fail ci.yml's check-typescript-only gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- untyped JS test helper
import { startSupervisor } from '../helpers/supervisor-harness.js';

const PLATFORM = process.env.SMOKE_PLATFORM;
const APP_ID = process.env.SMOKE_APP_ID ?? 'dev.lykhoyda.rndevagent.fixture';
const DEBUG_DIR = process.env.SMOKE_DEBUG_DIR ?? join(tmpdir(), 'rn-agent-smoke-debug');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

if (PLATFORM !== 'ios' && PLATFORM !== 'android') {
  console.error('SMOKE_PLATFORM must be "ios" or "android"');
  process.exit(1);
}

function assertFixtureInstalled() {
  try {
    if (PLATFORM === 'ios') {
      execFileSync('xcrun', ['simctl', 'get_app_container', 'booted', APP_ID], { stdio: 'pipe' });
    } else {
      const out = execFileSync('adb', ['shell', 'pm', 'path', APP_ID], {
        stdio: 'pipe',
      }).toString();
      if (!out.includes('package:')) throw new Error('not installed');
    }
  } catch {
    console.error(
      `Fixture app ${APP_ID} is not installed on the booted ${PLATFORM} device.\n` +
        `Build + install it first — see test-fixtures/${PLATFORM}-fixture/README.md`,
    );
    process.exit(1);
  }
}

function stopFixture() {
  // Deterministic fresh state per run: an already-running fixture keeps its
  // counter, so `open` would attach mid-state and the count assertions drift.
  try {
    if (PLATFORM === 'ios') {
      execFileSync('xcrun', ['simctl', 'terminate', 'booted', APP_ID], { stdio: 'pipe' });
    } else {
      execFileSync('adb', ['shell', 'am', 'force-stop', APP_ID], { stdio: 'pipe' });
    }
  } catch {
    // Not running — fine.
  }
}

async function rpc(s: any, method: string, params?: unknown) {
  const id = s.send(method, params);
  for (;;) {
    const line = JSON.parse(await s.nextLine());
    if (line.id === id) return line;
    // Anything else (notifications, requests from the server) is skipped.
  }
}

async function callTool(s: any, name: string, args: Record<string, unknown> = {}) {
  const line = await rpc(s, 'tools/call', { name, arguments: args });
  const text = line.result?.content?.[0]?.text ?? '';
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Non-JSON tool output (e.g. image content) — callers use `raw`.
  }
  return { raw: line, isError: Boolean(line.result?.isError), envelope, text };
}

type ToolReply = Awaited<ReturnType<typeof callTool>>;

const refFor = (snapEnvelope: any, identifier: string) =>
  snapEnvelope?.data?.nodes?.find((n: any) => n.identifier === identifier)?.ref;

test(`Phase B golden set (${PLATFORM})`, { timeout: 900_000 }, async () => {
  assertFixtureInstalled();
  stopFixture();
  mkdirSync(DEBUG_DIR, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), 'rn-agent-smoke-'));
  const s = startSupervisor({ cwd, lineTimeoutMs: 600_000, env: { RN_RUNNER_BUILD: 'local' } });
  const steps: Array<{ name: string; isError: boolean; envelope: unknown }> = [];
  const record = (name: string, r: ToolReply) => {
    steps.push({ name, isError: r.isError, envelope: r.envelope });
    console.log(`step ${name}: ${r.isError ? 'ERROR' : ((r.envelope as any)?.ok ?? 'n/a')}`);
    return r;
  };

  try {
    const init = await rpc(s, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'device-smoke', version: '1.0.0' },
    });
    assert.ok(
      init.result,
      `initialize must return a result: ${JSON.stringify(init).slice(0, 300)}`,
    );
    s.notify('notifications/initialized');

    const open = record(
      'open',
      await callTool(s, 'device_snapshot', { action: 'open', platform: PLATFORM, appId: APP_ID }),
    );
    assert.equal(open.envelope?.ok, true, `open failed: ${open.text.slice(0, 500)}`);

    let snap = record('snapshot', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    assert.equal(snap.envelope?.ok, true, `snapshot failed: ${snap.text.slice(0, 500)}`);
    for (const id of [
      'fixture_button',
      'fixture_count',
      'fixture_input',
      'fixture_bottom_button',
    ]) {
      assert.ok(refFor(snap.envelope, id), `snapshot missing @ref for ${id}`);
    }

    // index: 0 — SwiftUI double-exposes a Button's label (inner text element +
    // the button itself), so exact "Increment" is a designed AMBIGUOUS_MATCH;
    // the index short-circuit is the documented remedy and worth exercising.
    const find = record(
      'find',
      await callTool(s, 'device_find', { text: 'Increment', exact: true, index: 0 }),
    );
    assert.equal(find.envelope?.ok, true, `find failed: ${find.text.slice(0, 500)}`);

    const press = record(
      'press',
      await callTool(s, 'device_press', { ref: refFor(snap.envelope, 'fixture_button') }),
    );
    assert.equal(press.envelope?.ok, true, `press failed: ${press.text.slice(0, 500)}`);
    assert.ok(press.envelope?.meta?.settle, 'press must report meta.settle');
    const pressTimings = Object.values(press.envelope?.meta?.timings_ms ?? {}).filter(
      (v) => typeof v === 'number',
    );
    assert.ok(
      pressTimings.length > 0,
      `press must report numeric meta.timings_ms (project convention): ${press.text.slice(0, 300)}`,
    );
    const pressTotal = pressTimings.reduce((a: number, b) => a + (b as number), 0);
    assert.ok(pressTotal < 30_000, `press too slow: ${pressTotal}ms (ceiling 30000)`);

    snap = record('snapshot-2', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    const countNode = snap.envelope?.data?.nodes?.find(
      (n: any) => n.identifier === 'fixture_count',
    );
    assert.ok(countNode, 'fixture_count missing from the post-press snapshot');
    assert.match(countNode.label ?? '', /count: 1/, 'counter must increment after press');

    // device_scrollintoview does exactly ONE blind swipe when the target is
    // absent from the snapshot (device-interact.ts:1383) — row 80 is several
    // screens away (~10 rows visible per screen), so scroll until the row is
    // IN a snapshot, then let the verb finish on its supported path.
    let rowVisible = false;
    for (let i = 0; i < 20 && !rowVisible; i++) {
      const scroll = record(
        `scroll-${i}`,
        await callTool(s, 'device_scroll', { direction: 'down', amount: 1 }),
      );
      assert.equal(scroll.envelope?.ok, true, `scroll failed: ${scroll.text.slice(0, 500)}`);
      const look = record(
        `snapshot-scroll-${i}`,
        await callTool(s, 'device_snapshot', { action: 'snapshot' }),
      );
      rowVisible = Boolean(
        look.envelope?.data?.nodes?.some(
          (n: any) => n.label === 'row 80' || n.identifier === 'fixture_row_80',
        ),
      );
    }
    assert.ok(rowVisible, 'row 80 never appeared in a snapshot after 20 scrolls');

    const into = record(
      'scrollintoview',
      await callTool(s, 'device_scrollintoview', { text: 'row 80' }),
    );
    assert.equal(into.envelope?.ok, true, `scrollintoview failed: ${into.text.slice(0, 500)}`);

    const shot = record('screenshot', await callTool(s, 'device_screenshot', {}));
    const shotPath = shot.envelope?.data?.path;
    if (shotPath) {
      // Default capture is JPEG (faster); PNG when a .png path is passed.
      const head = [...readFileSync(shotPath).subarray(0, 4)];
      const isPng = PNG_MAGIC.every((b, i) => head[i] === b);
      const isJpeg = JPEG_MAGIC.every((b, i) => head[i] === b);
      assert.ok(isPng || isJpeg, `screenshot file is neither PNG nor JPEG: [${head.join(',')}]`);
    } else {
      const img = shot.raw.result?.content?.find((c: any) => c.type === 'image');
      assert.ok(
        img?.data,
        `screenshot returned neither a path nor image content: ${shot.text.slice(0, 300)}`,
      );
    }

    snap = record('snapshot-3', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    const fill = record(
      'fill',
      await callTool(s, 'device_fill', {
        ref: refFor(snap.envelope, 'fixture_input'),
        text: 'hello smoke',
      }),
    );
    assert.equal(fill.envelope?.ok, true, `fill failed: ${fill.text.slice(0, 500)}`);

    // Keyboard-guard scenario (#370 contract): the fill above left the
    // keyboard up; the bottom bar sits under it by fixture design.
    // FRESH snapshot first — @eN refs are positional snapshot tokens, and the
    // keyboard's arrival rewrote the tree, so a pre-fill ref would silently
    // bind to a different element at the same index (device-proven: it tapped
    // a list row dead-center instead of the bottom button).
    snap = record(
      'snapshot-post-fill',
      await callTool(s, 'device_snapshot', { action: 'snapshot' }),
    );
    const bottomRef = refFor(snap.envelope, 'fixture_bottom_button');
    assert.ok(bottomRef, 'fixture_bottom_button missing from the post-fill snapshot');
    const kb = record('keyboard-guard', await callTool(s, 'device_press', { ref: bottomRef }));
    const guard = kb.envelope?.meta?.keyboardGuard;
    if (PLATFORM === 'android') {
      // no_keyboard = environment problem (soft IME never appeared), not a
      // contract result — fail with the fix, don't let it masquerade.
      assert.notEqual(
        guard,
        'no_keyboard',
        'Soft keyboard never appeared — the emulator needs `adb shell settings put secure show_ime_with_hard_keyboard 1` (the nightly workflow sets it)',
      );
      assert.equal(kb.envelope?.ok, true, `keyboard-guard press failed: ${kb.text.slice(0, 500)}`);
      assert.equal(guard, 'dismissed', 'Android must dismiss the keyboard first');
    } else {
      assert.notEqual(
        kb.envelope?.ok,
        true,
        `iOS keyboard-guard scenario invalid: the tap went through (keyboardGuard=${guard}). ` +
          'The software keyboard likely never appeared on this headless simulator — environment problem, not a contract pass.',
      );
      const body = kb.text;
      assert.match(body, /KEYBOARD_OCCLUDED/, `expected KEYBOARD_OCCLUDED: ${body.slice(0, 500)}`);
      assert.match(
        body,
        /dismiss_failed/,
        `expected keyboardGuard=dismiss_failed: ${body.slice(0, 500)}`,
      );
    }

    const neg = record(
      'negative-find',
      await callTool(s, 'device_find', { text: 'fixture_does_not_exist_zz', exact: true }),
    );
    assert.ok(
      neg.isError || neg.envelope?.ok === false,
      'nonexistent element must yield an error envelope',
    );

    const alive = record(
      'snapshot-4',
      await callTool(s, 'device_snapshot', { action: 'snapshot' }),
    );
    assert.equal(alive.envelope?.ok, true, 'bridge must stay healthy after the negative case');

    const close = record('close', await callTool(s, 'device_snapshot', { action: 'close' }));
    assert.equal(close.envelope?.ok, true, `close failed: ${close.text.slice(0, 500)}`);
  } finally {
    writeFileSync(join(DEBUG_DIR, `smoke-${PLATFORM}-steps.json`), JSON.stringify(steps, null, 2));
    s.child.kill('SIGTERM');
  }
});
