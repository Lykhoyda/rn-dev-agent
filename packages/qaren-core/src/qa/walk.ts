import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CDPClient } from '../cdp-client.js';
import { createComponentTreeHandler } from '../handlers/component-tree.js';
import { createDevSettingsHandler } from '../handlers/dev-settings.js';
import {
  createDeviceBackHandler,
  createDeviceFillHandler,
  createDevicePressHandler,
  createDeviceScrollHandler,
} from '../handlers/device-interact.js';
import { tryRawScreenshot } from '../handlers/device-screenshot-raw.js';
import { createDeviceSnapshotHandler } from '../handlers/device-session.js';
import {
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
} from '../handlers/device-system-dialog.js';
import { foregroundSurfaceFromSnapshot } from '../handlers/expo-dev-menu.js';
import { foreignFlowGate } from '../lifecycle/foreign-flow-gate.js';
import type { ToolResult } from '../utils.js';
import { HandlerError, adapt, describeError, unwrap } from './adapt.js';
import type { LedgerRow } from './ledger.js';
import { parsePlan } from './plan.js';
import { prove } from './prove.js';
import {
  type DigestEntry,
  type NativeNode,
  frontFromSurface,
  join as joinScreen,
} from './screen.js';
import { type ActResult, type WalkerDeps, runPlan } from './walker.js';
import {
  type ResultPayload,
  type WireRequest,
  createWriter,
  missingResult,
  readRequest,
  startupRow,
} from './wire.js';

const log = (message: string): void => {
  process.stderr.write(`qaren-core: ${message}\n`);
};

// stdout is a pipe: wait for it to drain before the process exits.
function exitAfterDrain(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write('', () => process.exit(code));
  });
}

async function parseOnly(planFile: string): Promise<never> {
  let markdown: string;
  try {
    markdown = readFileSync(planFile, 'utf8');
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: 'PLAN_UNPARSEABLE', refused: [{ line: 0, text: '', reason: `cannot read ${planFile}: ${describeError(error).message}` }] })}\n`,
    );
    return exitAfterDrain(4);
  }
  const parsed = parsePlan(markdown);
  if (parsed.refused) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: 'PLAN_UNPARSEABLE', refused: parsed.refused })}\n`,
    );
    return exitAfterDrain(4);
  }
  const items = parsed.blocks.reduce((n, b) => n + b.items.length, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, blocks: parsed.blocks.length, items })}\n`);
  return exitAfterDrain(0);
}

interface Session {
  deps: WalkerDeps;
  close(): Promise<void>;
}

type Handler<A> = (args: A) => Promise<ToolResult>;

function act(handler: () => Promise<ToolResult>, proven: boolean): Promise<ActResult> {
  return handler().then(
    (result) => {
      try {
        unwrap(result);
        return { ok: true, proven };
      } catch (error) {
        const { code, message } = describeError(error);
        return { ok: false, proven: false, error: `${code}: ${message}` };
      }
    },
    (error) => {
      const { code, message } = describeError(error);
      return { ok: false, proven: false, error: `${code}: ${message}` };
    },
  );
}

// Attach over CDP, prove the bundle, open the device session, then hand the walker plain functions.
async function openSession(
  request: WireRequest,
  emitRow: (row: LedgerRow) => void,
): Promise<Session> {
  const { target, platform, appId } = request;
  // Run-relative ms on a monotonic clock, anchored once to the CLI's t0.
  const runOffset = Date.now() - request.t0;
  const perfStart = performance.now();
  const cdp = new CDPClient(target.metroPort);
  const getClient = (): CDPClient => cdp;
  try {
    await cdp.connectExact(target.metroPort, { platform, bundleId: appId });
  } catch (error) {
    throw new HandlerError(
      'CDP_NOT_CONNECTED',
      `cannot attach to the dev client through Metro ${target.metroPort}: ${describeError(error).message}`,
    );
  }
  // The lease coordinates qaren processes only; a foreign Maestro or XCUITest driver is a probe.
  if (platform === 'ios') {
    const foreign = await foreignFlowGate.check(target.deviceId);
    if (foreign.active) {
      await cdp.disconnect().catch(() => undefined);
      throw new HandlerError(
        'BUSY_FOREIGN_FLOW',
        foreign.warning?.message ?? 'another automation driver holds the device',
      );
    }
  }

  const snapshot: Handler<{
    action: 'open' | 'close' | 'snapshot';
    appId?: string;
    deviceId?: string;
    platform?: string;
    attachOnly?: boolean;
    sessionName?: string;
  }> = createDeviceSnapshotHandler();
  await adapt(snapshot)({
    action: 'open',
    appId,
    deviceId: target.deviceId,
    platform,
    attachOnly: false,
    sessionName: `qaren-${request.runId}`,
  });
  // Opening the session may have relaunched the app: prove the bundle the walk will see.
  const proof = await prove({ evaluate: (expr) => cdp.evaluate(expr) }, target);
  if (!proof.ok) {
    await snapshot({ action: 'close' }).catch(() => undefined);
    await cdp.disconnect().catch(() => undefined);
    throw new HandlerError(proof.code, proof.message);
  }
  log(
    `bundle proven: ${proof.scriptURL} (${proof.appModules} app modules under ${target.worktree})`,
  );

  const rawSnapshot = async (): Promise<{ nodes: NativeNode[]; surface: string | undefined }> => {
    const result = await snapshot({ action: 'snapshot' });
    const { data, meta } = unwrap<{ nodes?: NativeNode[] }>(result);
    return {
      nodes: data.nodes ?? [],
      surface: typeof meta?.foregroundSurface === 'string' ? meta.foregroundSurface : undefined,
    };
  };
  const devSettings = createDevSettingsHandler(getClient, {
    probeForegroundSurface: async () =>
      foregroundSurfaceFromSnapshot(await snapshot({ action: 'snapshot' }), appId),
  });
  for (const action of ['disableDevMenu', 'hideDevMenu'] as const) {
    try {
      unwrap(await devSettings({ action }));
    } catch (error) {
      log(`${action}: ${describeError(error).message}`);
    }
  }

  const tree = createComponentTreeHandler(getClient);
  const press = createDevicePressHandler(getClient);
  const fill = createDeviceFillHandler(getClient);
  const scroll = createDeviceScrollHandler();
  const back = createDeviceBackHandler();
  const accept = createDeviceAcceptSystemDialogHandler();
  const dismiss = createDeviceDismissSystemDialogHandler();
  let digestWarned = false;

  const deps: WalkerDeps = {
    async captureScreen() {
      const { nodes, surface } = await rawSnapshot();
      let digest: DigestEntry[] = [];
      try {
        const { data } = unwrap<{ interactive?: DigestEntry[] }>(
          await tree({ interactiveOnly: true, depth: 12 }),
        );
        digest = data.interactive ?? [];
      } catch (error) {
        if (!digestWarned) log(`interactive digest unavailable: ${describeError(error).message}`);
        digestWarned = true;
      }
      return joinScreen(nodes, digest, frontFromSurface(surface, nodes));
    },
    press: (ref) => act(() => press({ ref }), false),
    fill: (ref, text) => act(() => fill({ ref, text }), true),
    scroll: (direction) => act(() => scroll({ direction, amount: 0.6 }), false),
    back: () => act(() => back({}), false),
    dialog: (action) =>
      act(() => (action === 'accept' ? accept({ platform }) : dismiss({ platform })), true),
    async screenshot(name) {
      const shot = await tryRawScreenshot(platform, join(request.runDir, name), target.deviceId);
      if (!shot.ok) log(`screenshot ${name} failed: ${shot.reason}`);
      return shot.ok ? name : undefined;
    },
    now: () => Math.round(runOffset + performance.now() - perfStart),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    row: emitRow,
  };
  return {
    deps,
    async close() {
      await snapshot({ action: 'close' }).catch(() => undefined);
      await cdp.disconnect().catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === '--parse') return parseOnly(process.argv[3] ?? '');
  const request = await readRequest(process.stdin);
  const writer = createWriter((line) => process.stdout.write(line), request.runId);
  const rows: LedgerRow[] = [];
  const emitRow = (row: LedgerRow): void => {
    rows.push(row);
    writer.row(row);
  };
  emitRow(startupRow());
  const finish = async (payload: ResultPayload, close?: () => Promise<void>): Promise<never> => {
    const code = writer.result(payload);
    if (close) await close();
    return exitAfterDrain(code);
  };
  const refuse = (code: string, message: string, close?: () => Promise<void>): Promise<never> =>
    finish({ verdict: 'REFUSED', code, message, lease: request.lease }, close);

  if (process.env.QAREN_DEVICE_LEASE !== request.lease) {
    return refuse('LEASE_MISMATCH', 'QAREN_DEVICE_LEASE does not match the request lease');
  }
  const parsed = parsePlan(request.plan);
  if (parsed.refused) {
    const named = parsed.refused.map((r) => `line ${r.line}: ${r.reason}`).join('; ');
    return refuse('PLAN_UNPARSEABLE', `the plan does not parse: ${named}`);
  }

  let session: Session;
  try {
    session = await openSession(request, emitRow);
  } catch (error) {
    const { code, message } = describeError(error);
    return refuse(code, message);
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log(`${signal}: closing the device session`);
      void session.close().finally(() => process.exit(1));
    });
  }
  try {
    const ledger = await runPlan(parsed.blocks, session.deps);
    return finish(ledger, () => session.close());
  } catch (error) {
    const { code, message } = describeError(error);
    return finish(missingResult(rows, `${code}: ${message}`), () => session.close());
  }
}

main().catch((error) => {
  log(`fatal before the wire was established: ${describeError(error).message}`);
  process.exit(1);
});
