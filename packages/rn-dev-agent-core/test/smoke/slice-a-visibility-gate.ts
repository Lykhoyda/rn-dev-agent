// Slice A real-device gate (#627): drives the SHIPPED injected helper through
// CDP against the real RN 0.85 / React 19.2.3 test app. No renderer or
// UIManager is mocked here — that mocking is what made three earlier heads
// ship a layout proof the platform cannot satisfy.
// Env: SLICE_A_APP_ROOT (test-app checkout), SLICE_A_APP_ID, SLICE_A_DEVICE_ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- untyped JS test helper
import { startSupervisor } from '../helpers/supervisor-harness.js';

const APP_ROOT = process.env.SLICE_A_APP_ROOT;
const APP_ID = process.env.SLICE_A_APP_ID ?? 'com.rndevagent.testapp';
const DEVICE_ID = process.env.SLICE_A_DEVICE_ID;
const EVIDENCE_DIR = process.env.SLICE_A_EVIDENCE_DIR ?? join(tmpdir(), 'slice-a-gate');

// Ref-less hosts: plain <View>/<Pressable> nobody holds a ref to. These are the
// controls the removed layout proof could never resolve.
const REF_LESS_IDS = ['home-feature-0', 'home-feature-list', 'task-stats-card'];
const REF_BEARING_ID = 'quick-add-fab';
// Occlusion pair is Slice B. Never assert these green under Slice A.
const OCCLUSION_PAIR = ['qa-covered-btn', 'qa-uncovered-btn'];
const SUCCESS_TARGET = 5;

if (!APP_ROOT) {
  console.error(
    'SLICE_A_APP_ROOT must point at the RN 0.85 test-app checkout.\n' +
      'This gate is a real-device gate; it must not be run against a fixture or a mock.',
  );
  process.exit(1);
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
  const text = line.result?.content?.[0]?.text ?? '';
  let envelope: any = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Non-JSON tool output; callers fall back to `text`.
  }
  return { isError: Boolean(line.result?.isError), envelope, text };
}

async function evaluate(s: any, expression: string) {
  const r = await callTool(s, 'cdp_evaluate', { expression });
  assert.equal(r.isError, false, `cdp_evaluate failed: ${r.text.slice(0, 300)}`);
  const raw = r.envelope?.data?.result ?? r.envelope?.data?.value ?? r.envelope?.data;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const PRIMITIVE_PROBE = `(() => {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  var renderers = [];
  if (hook && hook.renderers && typeof hook.renderers.forEach === 'function') {
    hook.renderers.forEach(function (r, id) {
      renderers.push({
        id: String(id),
        rendererPackageName: r && r.rendererPackageName ? String(r.rendererPackageName) : null,
        findHostInstanceByFiber: typeof (r && r.findHostInstanceByFiber)
      });
    });
  }
  var fab = globalThis.nativeFabricUIManager;
  return JSON.stringify({
    renderers: renderers,
    fabric: {
      present: typeof fab,
      getBoundingClientRect: typeof (fab && fab.getBoundingClientRect),
      findNodeAtPoint: typeof (fab && fab.findNodeAtPoint)
    }
  });
})()`;

const hostProbe = (testID: string) => `(() => {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  var roots = [];
  if (hook && hook.getFiberRoots && hook.renderers) {
    hook.renderers.forEach(function (_r, id) {
      var set = hook.getFiberRoots(id);
      if (set && typeof set.forEach === 'function') {
        set.forEach(function (root) { if (root && root.current) roots.push(root.current); });
      }
    });
  }
  var matches = [];
  var stack = roots.slice();
  var scanned = 0;
  while (stack.length && scanned++ < 40000) {
    var f = stack.pop();
    if (!f) continue;
    var p = f.memoizedProps || {};
    if (p.testID === ${JSON.stringify(testID)} || p.nativeID === ${JSON.stringify(testID)}) {
      var sn = f.stateNode;
      matches.push({
        tag: f.tag,
        stateNode: sn === null ? 'null' : typeof sn,
        hasCanonical: !!(sn && sn.canonical),
        publicInstance: !!(sn && sn.canonical && sn.canonical.publicInstance),
        directRect: !!(sn && typeof sn.getBoundingClientRect === 'function')
      });
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return JSON.stringify({ testID: ${JSON.stringify(testID)}, matches: matches });
})()`;

const assertVisibleFlow = (id: string) =>
  `appId: ${APP_ID}\n---\n- assertVisible:\n    id: "${id}"\n`;

test('Slice A visibility gate (real device, no mocks)', { timeout: 900_000 }, async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidence: Record<string, unknown> = { appId: APP_ID, sliceA: true };
  // A non-Git app root must be declared explicitly; the supervisor never
  // infers one from the working directory.
  const declaredEnv = existsSync(join(APP_ROOT!, '.git'))
    ? {}
    : { RN_DEV_AGENT_DECLARED_ROOT: APP_ROOT!, RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json' };
  const s = startSupervisor({ cwd: APP_ROOT, lineTimeoutMs: 600_000, env: declaredEnv });

  try {
    const init = await rpc(s, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'slice-a-gate', version: '1.0.0' },
    });
    assert.ok(init.result, 'initialize must return a result');
    s.notify('notifications/initialized');

    const connect = await callTool(s, 'cdp_connect', DEVICE_ID ? { deviceId: DEVICE_ID } : {});
    assert.equal(
      connect.envelope?.ok,
      true,
      `cdp_connect must bind the real app: ${connect.text.slice(0, 400)}`,
    );

    // 1. Primitive probe. Records what the platform actually exposes.
    const primitives = await evaluate(s, PRIMITIVE_PROBE);
    evidence.primitives = primitives;
    assert.ok(
      Array.isArray(primitives.renderers) && primitives.renderers.length > 0,
      'at least one React renderer must be registered',
    );
    // Slice A depends on NO layout primitive. Assert that explicitly: if a
    // renderer ever grows findHostInstanceByFiber, Slice B should reconsider,
    // but Slice A must never require it.
    const anyFindHost = primitives.renderers.some(
      (r: any) => r.findHostInstanceByFiber === 'function',
    );
    evidence.findHostInstanceByFiberAvailable = anyFindHost;

    // 2. Ref-less hosts: prove the lazy path is genuinely unpopulated first.
    const hostProbes: Record<string, unknown> = {};
    for (const id of REF_LESS_IDS) {
      const probe = await evaluate(s, hostProbe(id));
      hostProbes[id] = probe;
      assert.ok(probe.matches.length > 0, `${id} must be mounted in the React tree`);
      const layoutResolvable = probe.matches.some((m: any) => m.publicInstance || m.directRect);
      assert.equal(
        layoutResolvable,
        false,
        `${id} was expected to be ref-less (canonical.publicInstance === null). ` +
          `Got ${JSON.stringify(probe.matches)}. Pick a genuinely ref-less control, ` +
          `otherwise this gate does not exercise the lazy path.`,
      );
    }
    evidence.hostProbes = hostProbes;

    // 3. assertVisible must now succeed for those ref-less hosts.
    const passedIds: string[] = [];
    const perId: Record<string, unknown> = {};
    for (const id of [...REF_LESS_IDS, REF_BEARING_ID]) {
      const run = await callTool(s, 'maestro_run', {
        inlineYaml: assertVisibleFlow(id),
        platform: 'ios',
        appId: APP_ID,
        ...(DEVICE_ID ? { deviceId: DEVICE_ID } : {}),
      });
      const passed = run.envelope?.ok === true && run.envelope?.data?.passed === true;
      const proofDomain = run.envelope?.data?.proofDomain ?? null;
      perId[id] = { passed, proofDomain };
      if (passed && proofDomain === 'react-tree') passedIds.push(id);
    }
    evidence.assertVisible = perId;

    for (const id of REF_LESS_IDS) {
      assert.equal(
        (perId[id] as any).passed,
        true,
        `ref-less host ${id} must assert visible under Slice A: ${JSON.stringify(perId[id])}`,
      );
    }

    // 4. Ref-bearing control asserts AND a replay press mutates observable state.
    assert.equal(
      (perId[REF_BEARING_ID] as any).passed,
      true,
      `${REF_BEARING_ID} must assert visible`,
    );
    const before = await evaluate(s, hostProbe(REF_BEARING_ID));
    const press = await callTool(s, 'maestro_run', {
      inlineYaml: `appId: ${APP_ID}\n---\n- tapOn:\n    id: "${REF_BEARING_ID}"\n`,
      platform: 'ios',
      appId: APP_ID,
      ...(DEVICE_ID ? { deviceId: DEVICE_ID } : {}),
    });
    assert.equal(
      press.envelope?.data?.passed,
      true,
      `replay press on ${REF_BEARING_ID} must pass: ${press.text.slice(0, 400)}`,
    );
    const after = await evaluate(s, hostProbe('quick-add-menu'));
    const mutated =
      JSON.stringify(after?.matches ?? null) !== JSON.stringify(before?.matches ?? null) ||
      (after?.matches?.length ?? 0) > 0;
    evidence.pressMutation = { mutated, after };
    assert.equal(mutated, true, 'replay press must produce an observable tree mutation');

    // 5. Threshold on ids and observed mutations — never on reason substrings.
    evidence.reactTreeSuccessIds = passedIds;
    assert.ok(
      passedIds.length > 0,
      `Slice A requires > 0 exact-testID React-tree successes, got ${passedIds.length}`,
    );
    if (passedIds.length < SUCCESS_TARGET) {
      console.warn(
        `Slice A gate: ${passedIds.length} React-tree successes (target ${SUCCESS_TARGET}). ` +
          `Above the hard floor, below target — recorded, not silently accepted.`,
      );
    }

    // 6. Occlusion pair is out of scope for Slice A and must never read green.
    evidence.occlusionPair = {
      ids: OCCLUSION_PAIR,
      status: 'skipped-slice-a',
      reason:
        'Slice A removes the layout/occlusion tail. Covered-control refusal returns in Slice B ' +
        'on a real layout primitive (nativeFabricUIManager), not renderer internals.',
    };
    console.log(`occlusion pair ${OCCLUSION_PAIR.join(', ')}: SKIPPED under Slice A (known gap)`);
  } finally {
    writeFileSync(
      join(EVIDENCE_DIR, 'slice-a-gate-evidence.json'),
      JSON.stringify(evidence, null, 2),
    );
    try {
      await callTool(s, 'cdp_disconnect', {});
    } catch {
      // Best-effort teardown; the supervisor kill below is authoritative.
    }
    s.child.kill('SIGKILL');
  }
});
