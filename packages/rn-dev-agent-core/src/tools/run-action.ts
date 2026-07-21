// Issue #104 — `cdp_run_action` MCP tool. Replays a learned action's
// Maestro flow, parses failures, optionally auto-repairs on
// SELECTOR_NOT_FOUND, and persists a RunRecord with auto-repair
// telemetry to the action's sidecar.
//
// Composition:
//   1. loadAction(projectRoot, actionId) — fail fast if missing.
//   2. createMaestroRunHandler() — first attempt (delegates to the
//      existing `maestro_run` tool, single source of truth for the
//      maestro-runner / Maestro CLI dispatch tiering).
//   3. On failure: parseMaestroFailure → if SELECTOR_NOT_FOUND and
//      autoRepair !== false, invoke createRepairActionHandler. On
//      successful patch, replay maestro once more.
//   4. appendRunRecord (with embedded autoRepair outcome) +
//      saveAction (atomic pair-write) — single source of truth for
//      MTTR analytics.
//
// Behavioural contract:
//   - autoRepair defaults to true. Pass `autoRepair: false` to opt out.
//   - Only SELECTOR_NOT_FOUND-shaped failures trigger repair in phase 1.
//     TIMEOUT and ASSERTION_FAILED are surfaced verbatim (issue #104
//     defers other failure shapes to follow-up).
//   - The repair attempt counts toward `cdp_repair_action`'s 24h budget;
//     an exhausted budget surfaces as `autoRepair.outcome === 'refused'`
//     with `refusedReason: 'BUDGET_EXHAUSTED'`.
//   - One repair attempt + one retry per run. Multi-attempt repair is
//     intentionally NOT in scope for phase 1 (each repair attempt is a
//     30s+ device snapshot; cascading retries would be slow and could
//     mask underlying screen churn).

import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import {
  acknowledgeExternalEdit,
  loadAction,
  promoteActionRuntimeWithCAS,
  saveActionRuntimeWithCAS,
} from '../domain/action-store.js';
import { mirrorToDb } from '../domain/action-state-store.js';
import {
  type RunRecord,
  type AutoRepairOutcome,
  type AutoRepairRefusedReason,
  type ActionFailureCode,
  appendRunRecord,
  shouldAutoPromoteToActive,
} from '../domain/reusable-action.js';
import {
  parseMaestroFailure,
  isAutoRepairable,
  type MaestroFailure,
} from '../domain/maestro-error-parser.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { createRepairActionHandler } from './repair-action.js';
import { isValidActionId } from '../domain/path-safety.js';
import { classifyRouteDriftAfterFailure } from '../nav-graph/route-sequence.js';
import {
  isExactPresent,
  runCdpReplay,
  firstReplayTestId,
  type CdpReplayDeps,
} from './cdp-replay-dispatch.js';
import { UnsupportedStepError } from '../domain/cdp-flow-replay.js';
import { evaluateBlindProbeGate } from '../domain/blind-probe-gate.js';
import type { BlindProbeAtRisk } from '../domain/blind-probe-gate.js';

/**
 * Map a parsed Maestro failure kind to an `ActionFailureCode` (for
 * RunRecord telemetry) and a `ToolErrorCode` (for the failResult
 * envelope). The two enums overlap but are NOT identical — RunRecord
 * captures action-domain semantics, ToolErrorCode is the agent-facing
 * error contract.
 */
function classifyFailure(failure: MaestroFailure): {
  actionCode: ActionFailureCode;
  toolCode: ToolErrorCode | undefined;
} {
  switch (failure.kind) {
    case 'SELECTOR_NOT_FOUND':
      return { actionCode: 'SELECTOR_NOT_FOUND', toolCode: 'TESTID_NOT_FOUND' };
    case 'TIMEOUT':
      return { actionCode: 'TIMEOUT', toolCode: undefined };
    case 'ASSERTION_FAILED':
      return { actionCode: 'STATE_MISMATCH', toolCode: 'ASSERTION_FAILED' };
    case 'WDA_BOOTSTRAP_FAILED':
      return { actionCode: 'WDA_BOOTSTRAP_FAILED', toolCode: 'WDA_BOOTSTRAP_FAILED' };
    case 'UNKNOWN':
    default:
      return { actionCode: 'UNKNOWN', toolCode: undefined };
  }
}

export interface RunActionArgs {
  /** Action id matching `<projectRoot>/.rn-agent/actions/<actionId>.yaml`. */
  actionId: string;
  /**
   * Override the project root. Default: process.cwd(). Useful for tests
   * and for projects where cdp-bridge isn't invoked from the project dir.
   */
  projectRoot?: string;
  /** Force a specific platform; otherwise auto-detected. */
  platform?: 'ios' | 'android';
  /**
   * Auto-repair on SELECTOR_NOT_FOUND failures. Default true. Pass
   * `false` for explicit opt-out (e.g. `--no-auto-repair` from the
   * slash command).
   */
  autoRepair?: boolean;
  /** Maestro execution timeout in ms. Default 120s. */
  timeoutMs?: number;
  /**
   * RunRecord trigger annotation. Default 'agent'. CI calls should pass
   * 'ci'; human-driven invocations 'human'.
   */
  trigger?: 'agent' | 'ci' | 'human';
  /**
   * GH #116: per-flow parameter bindings forwarded to maestro_run as
   * `-e KEY=VALUE` pairs. Keys must match Maestro's env-style convention
   * `/^[A-Z_][A-Z0-9_]*$/`; validation enforced in maestro_run itself.
   * Pass through unchanged on both first attempt AND post-repair retry
   * so a parameterised flow can be replayed identically after repair.
   */
  params?: Record<string, string>;
  /**
   * GH #173 (sub-issue 3): when true (default), treat the YAML's current
   * on-disk state as the new baseline before running. Bumps the sidecar's
   * lastSeenMtimeMs so a downstream cdp_repair_action call doesn't abort
   * with STALE_TARGET during active human composition.
   *
   * Pass `false` to opt back into the Phase 129 "respect external edits"
   * behavior: any human edit since the agent's last write makes repair
   * refuse to run. Use this when you don't want auto-repair to clobber
   * offline human edits (e.g. CI replays of fixed baselines).
   */
  forceReload?: boolean;
  /** Execute the action without persistence for strict proof rehearsal. */
  proofReplay?: boolean;
}

interface MaestroTerminal {
  completedSteps?: number;
  failedStep?: string;
  exitClass?: 'before-first-step' | 'step-failure' | 'timed-out' | 'spawn-error';
  bootstrapEvidence?: string;
  failureKind?: 'SELECTOR_NOT_FOUND' | 'TIMEOUT' | 'ASSERTION_FAILED';
  failureSelector?: string | null;
}

interface MaestroEnvelope {
  ok?: boolean;
  data?: {
    passed?: boolean;
    output?: string;
    flowFile?: string;
    platform?: string;
    terminal?: MaestroTerminal;
    runner?: string;
    transport?: string;
    transportVersion?: string | null;
    fallback?: string;
    steps?: Array<{
      index: number;
      name: string;
      verb: string;
      status: 'pass' | 'fail';
      durationMs: number;
    }>;
  };
  error?: string;
  meta?: Record<string, unknown>;
}

function parseEnvelope(toolResult: ToolResult, toolName: string): MaestroEnvelope {
  try {
    return JSON.parse(toolResult.content?.[0]?.text ?? '{}') as MaestroEnvelope;
  } catch {
    return { ok: false, error: `Unparseable ${toolName} envelope` };
  }
}

function replaySuccessEvidence(env: MaestroEnvelope): {
  transport: string;
  transportVersion: string | null;
  fallback: string;
  perStepReadback: {
    source: 'maestro-runner-step-report';
    complete: boolean;
    steps: Array<{
      index: number;
      verb: string;
      status: 'pass' | 'fail';
      durationMs: number;
    }>;
  };
} {
  const reportedSteps = env.data?.steps ?? [];
  const steps = reportedSteps.map(({ index, verb, status, durationMs }) => ({
    index,
    verb,
    status,
    durationMs,
  }));
  return {
    transport: env.data?.transport ?? env.data?.runner ?? 'unproven',
    transportVersion: env.data?.transportVersion ?? null,
    fallback: env.data?.fallback ?? 'unproven',
    perStepReadback: {
      source: 'maestro-runner-step-report',
      complete: steps.length > 0 && steps.every((step) => step.status === 'pass'),
      steps,
    },
  };
}

/**
 * Multi-LLM review of PR #115 (Codex C1, conf 95): when `maestro_run`
 * catches an execFile timeout, it surfaces the partial output through
 * `meta.output` rather than `data.output`. Read both shapes so the
 * parser still sees the underlying failure even when devices are slow
 * — that's the failure mode auto-repair is most valuable for.
 */
function readMaestroTerminal(env: MaestroEnvelope): MaestroTerminal | undefined {
  const fromData = env.data?.terminal;
  if (fromData) return fromData;
  const fromMeta = (env.meta as { terminal?: MaestroTerminal } | undefined)?.terminal;
  return fromMeta;
}

function readMaestroOutput(env: MaestroEnvelope): string {
  if (typeof env.data?.output === 'string') return env.data.output;
  const metaOutput = (env.meta as { output?: unknown } | undefined)?.output;
  if (typeof metaOutput === 'string') return metaOutput;
  return env.error ?? '';
}

/**
 * maestro_run builds its headline from the full runner stream before slicing
 * data.output/meta.output. Keep that headline as the authoritative failure
 * detail so cdp_run_action never reduces a useful terminal step to UNKNOWN just
 * because the report preamble consumed the bounded output field.
 */
function readMaestroFailureDetail(env: MaestroEnvelope, output: string): string {
  if (typeof env.error === 'string' && env.error.trim()) return env.error.trim();
  const failedStep = (env.meta as { failedStep?: { name?: unknown } } | undefined)?.failedStep;
  if (typeof failedStep?.name === 'string')
    return `Maestro flow failed at step "${failedStep.name}"`;
  return output.trim().slice(0, 1000) || 'Maestro runner returned no failure detail';
}

/**
 * Map repair-action's failResult code → an AutoRepairRefusedReason.
 *
 * TODO(repair-action structural disambiguation): the STALE_TARGET branch
 * below disambiguates BUDGET_EXHAUSTED vs EXTERNAL_EDIT by regexing the
 * error STRING ("repair budget"). Multi-LLM review of PR #115 flagged
 * this as brittle — if `repair-action.ts:101`'s wording changes
 * (e.g. shortened to "rolling-budget cap"), BUDGET_EXHAUSTED would
 * silently flip to EXTERNAL_EDIT and MTTR analytics would
 * mis-categorise every churn-driven refusal. The structural fix is to
 * have `cdp_repair_action` expose `meta.subReason: 'BUDGET_EXHAUSTED' |
 * 'EXTERNAL_EDIT'` so this function can read it directly. Filed as a
 * separate issue; the wording-lock test below at least raises the
 * alarm on regression.
 */
function mapRefusedReason(
  repairCode: string | undefined,
  repairError: string,
): AutoRepairRefusedReason {
  if (repairCode === 'SNAPSHOT_FAILED') return 'SNAPSHOT_FAILED';
  // RUNNER_LEAK = the snapshot returned the Agent Device Runner's own UI rather
  // than the target app. That is structurally a snapshot-infra failure (a known,
  // actionable focus-stealing condition), NOT a transport/contract bug — bucket
  // it with SNAPSHOT_FAILED so MTTR analytics surface it instead of hiding it
  // under INTERNAL_ERROR.
  if (repairCode === 'RUNNER_LEAK') return 'SNAPSHOT_FAILED';
  // GH #317: rn-fast-runner saw the selector but Maestro/WDA could not. Surface
  // it as its own reason (NOT INTERNAL_ERROR) so MTTR sees transport-blindness.
  if (repairCode === 'TRANSPORT_BLIND') return 'TRANSPORT_BLIND';
  if (repairCode === 'TESTID_NOT_FOUND') return 'NO_MATCH';
  if (repairCode === 'STALE_TARGET') {
    if (/repair budget/i.test(repairError)) return 'BUDGET_EXHAUSTED';
    return 'EXTERNAL_EDIT';
  }
  // Unknown / unmapped — map to INTERNAL_ERROR (NOT NO_MATCH) so MTTR
  // doesn't conflate transport / contract bugs with "screen state
  // legitimately doesn't have the testID".
  return 'INTERNAL_ERROR';
}

/**
 * Optional dependency injection for testability. Production callers
 * pass nothing and get the real handlers; tests pass stubs that return
 * pre-shaped envelopes so the orchestration logic can be exercised
 * without booting a device or running Maestro.
 */
export interface RunActionDeps {
  maestroRun?: ReturnType<typeof createMaestroRunHandler>;
  repairAction?: ReturnType<typeof createRepairActionHandler>;
  /**
   * GH #186: fetch the live deepest route name (bounded, best-effort) for
   * structural route-drift detection on a SELECTOR_NOT_FOUND. Defaults to a
   * no-op (null) so the drift check is inert until index.ts wires a real
   * CDP-backed fetcher; tests inject a fake.
   */
  getLiveRoute?: () => Promise<string | null>;
  /**
   * GH #317 Phase 2: factory that returns CdpReplayDeps for the CDP/JS
   * transport-blind fallback, or null to skip the fallback entirely.
   * Defaults to () => null so existing callers and tests are unchanged.
   * Production wiring lives in index.ts.
   */
  replayDeps?: (args: RunActionArgs) => CdpReplayDeps | null;
  /**
   * GH #423: retry budget for the fallback's tree probe. The failed flow has
   * usually just relaunched the app, so CDP is mid-reconnect exactly when the
   * probe runs — a single attempt silently disabled the fallback in the field.
   */
  probeRetry?: { attempts: number; delayMs: number };
  /**
   * GH #397 Phase 2: device context for the proactive blind-probe.
   * null ⇒ gate inert (today's behavior). Production wiring lives in index.ts.
   */
  blindProbeContext?: () => Promise<{
    deviceId: string | null;
    iosRuntimeMajor: number | null;
  } | null>;
}

/** GH #423: why the CDP/JS fallback did not replay — surfaced in failure meta. */
interface CdpJsFallbackSkip {
  attempted: false;
  reason: 'no-replay-deps' | 'no-probe-testid' | 'cdp-unreachable' | 'testid-not-in-tree';
}

async function probeTreeWithRetry(
  replay: CdpReplayDeps,
  probe: string,
  retry: { attempts: number; delayMs: number },
): Promise<{ found: boolean; sawTree: boolean }> {
  // Retry until the probe testID is PRESENT, not merely until a tree is
  // readable — after a WDA-death relaunch the app may serve an early/loading
  // tree while the target element hasn't mounted yet (per-edit review).
  let sawTree = false;
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    const tree = await replay.treeFor(probe).catch(() => null);
    if (tree !== null) {
      sawTree = true;
      if (isExactPresent(tree, probe)) return { found: true, sawTree: true };
    }
    if (attempt < retry.attempts - 1) {
      await new Promise((r) => setTimeout(r, retry.delayMs));
    }
  }
  return { found: false, sawTree };
}

export function createRunActionHandler(deps: RunActionDeps = {}) {
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
  const repairAction = deps.repairAction ?? createRepairActionHandler();
  const getLiveRoute = deps.getLiveRoute ?? (async () => null);
  const getReplayDeps = deps.replayDeps ?? (() => null);
  const probeRetryRaw = deps.probeRetry ?? { attempts: 3, delayMs: 1500 };
  // Clamp so an injected budget can't stall cdp_run_action beyond a few extra
  // seconds (each attempt also carries the tree handler's own CDP timeout).
  const probeRetry = {
    attempts: Math.min(Math.max(1, probeRetryRaw.attempts), 5),
    delayMs: Math.min(Math.max(0, probeRetryRaw.delayMs), 5000),
  };
  const blindProbeContext = deps.blindProbeContext ?? (async () => null);
  return async (args: RunActionArgs): Promise<ToolResult> => {
    if (!args.actionId || typeof args.actionId !== 'string') {
      return failResult('cdp_run_action requires actionId', 'BAD_FILENAME');
    }
    // Phase 134.3 (deepsec HIGH path-traversal): same chokepoint as
    // cdp_repair_action — actionId flows into the .rn-agent/actions/
    // path segment. Reject malicious slugs at the boundary.
    if (!isValidActionId(args.actionId)) {
      return failResult(
        `Invalid actionId "${String(args.actionId).slice(0, 80)}" — must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ (no "..") and be <= 64 chars`,
        'BAD_FILENAME',
      );
    }

    const projectRoot = args.projectRoot ?? process.cwd();
    const proofReplay = args.proofReplay === true;
    if (proofReplay && (args.autoRepair !== false || args.forceReload !== false)) {
      return failResult(
        'cdp_run_action proofReplay requires autoRepair=false and forceReload=false',
        { proofReplay: true },
      );
    }
    const loaded = loadAction(projectRoot, args.actionId);
    if (!loaded) {
      return failResult(
        `cdp_run_action: action "${args.actionId}" not found at ${projectRoot}/.rn-agent/actions/${args.actionId}.yaml`,
        'NO_PROJECT_ROOT',
        {
          hint: 'Verify with /list-learned-actions, or pass projectRoot if cdp-bridge is invoked outside the project dir.',
        },
      );
    }
    // GH #173 (sub-issue 3): default-true forceReload acknowledges any
    // human edit to the YAML as the new baseline so downstream auto-repair
    // doesn't abort with STALE_TARGET. Opt out with forceReload: false to
    // get the strict Phase 129 "respect external edits" behavior back.
    const forceReload = proofReplay ? false : args.forceReload !== false;
    const action = forceReload ? acknowledgeExternalEdit(loaded) : loaded;

    const autoRepairEnabled = args.autoRepair !== false;
    const trigger: 'agent' | 'ci' | 'human' = args.trigger ?? 'agent';
    const timeoutMs = args.timeoutMs ?? 120_000;
    const t0 = Date.now();

    // GH #397: deviceId threading. Handler-scoped (not inside the try) because
    // the outer catch also persists a RunRecord and must carry the device too.
    let probeDeviceId: string | null = null;
    const persistRunWithDevice = (record: RunRecord): Promise<PersistRunOutcome> =>
      proofReplay
        ? Promise.resolve({ promoted: false })
        : persistRun(
            args.actionId,
            projectRoot,
            probeDeviceId ? { ...record, deviceId: probeDeviceId } : record,
          );
    const writeDisclosure = (
      actionYaml: 'none' | 'auto-repair' | 'lifecycle-promotion' = 'none',
    ) => ({
      actionYaml:
        actionYaml === 'none'
          ? { written: false, reason: 'repair-not-applied' }
          : { written: true, authorized: true, reason: actionYaml },
      runtimeState: proofReplay ? 'none' : 'sidecar',
      databaseMirror: proofReplay ? 'none' : 'best-effort',
    });

    // Multi-LLM review of PR #115 (Gemini conf 95): wrap the orchestration
    // body so a thrown exception (maestroRun timeout, repairAction
    // throwing through withSession, etc.) is caught and surfaces as a
    // structured failResult WITH a persisted RunRecord, instead of
    // bubbling up unwrapped to the MCP framework.
    try {
      // GH #397 Phase 2: proactive blind-probe. On at-risk iOS runtimes
      // (>= 26, or a recent device-matched TRANSPORT_BLIND) with a CDP-visible
      // anchor, skip the doomed ~40s WDA attempt and replay via CDP/JS
      // directly. Every branch fails open to the maestro-first path below.
      // Opt out globally with RN_BLIND_PROBE=0.
      let atRisk: BlindProbeAtRisk | null = null;
      const blindProbeDisabled =
        process.env.RN_BLIND_PROBE === '0' || process.env.RN_BLIND_PROBE === 'false';
      if (args.platform !== 'android') {
        // Resolve the device context even when the gate is opted out: a clean
        // maestro pass recorded WITHOUT deviceId can never clear a prior
        // device-matched latch (strict matching), which would defeat the
        // documented "rerun with RN_BLIND_PROBE=0" recovery workflow.
        const ctx = await blindProbeContext().catch(() => null);
        if (ctx) {
          probeDeviceId = ctx.deviceId;
          if (!blindProbeDisabled) {
            atRisk = evaluateBlindProbeGate({
              platform: args.platform,
              iosRuntimeMajor: ctx.iosRuntimeMajor,
              deviceId: ctx.deviceId,
              runHistory: action.state.runHistory,
            }).atRisk;
          }
        }
      }

      if (atRisk) {
        const replayDeps = getReplayDeps(args);
        const probe = replayDeps ? firstReplayTestId(action.body, args.params ?? {}) : null;
        if (replayDeps && probe) {
          const tProbe = Date.now();
          const probeOutcome = await probeTreeWithRetry(replayDeps, probe, probeRetry);
          if (probeOutcome.found) {
            const tReplay = Date.now();
            try {
              const replay = await runCdpReplay(action.body, args.params ?? {}, replayDeps);
              const timings_ms = { probe: tReplay - tProbe, replay: Date.now() - tReplay };
              const blindProbe = { atRisk, skippedMaestro: true };
              const autoRepair: AutoRepairOutcome = {
                attempted: false,
                outcome: 'skipped',
                // The probe+replay IS this run's first (and only) attempt —
                // maestro was skipped by design.
                phases: { firstAttemptMs: Date.now() - tProbe },
              };
              const persisted = await persistRunWithDevice({
                timestamp: new Date().toISOString(),
                durationMs: Date.now() - t0,
                status: replay.passed ? 'pass' : 'fail',
                failureCode: replay.passed ? undefined : 'FALLBACK_REPLAY_FAILED',
                failureDetail: replay.reason,
                trigger,
                autoRepair,
                transport: 'cdp-js',
                blindProbe,
              });
              if (replay.passed) {
                return okResult({
                  passed: true,
                  actionId: args.actionId,
                  transport: 'cdp-js',
                  transportVersion: null,
                  fallback: 'none',
                  repair: autoRepair,
                  writes: writeDisclosure(persisted.promoted ? 'lifecycle-promotion' : 'none'),
                  blindProbe,
                  timings_ms,
                  autoRepair,
                  durationMs: Date.now() - t0,
                  flowFile: action.filePath,
                });
              }
              // NOT 'TRANSPORT_BLIND': maestro was never attempted, so no
              // blindness was observed — this may be app drift or a stale
              // anchor. FALLBACK_REPLAY_FAILED is non-decisive for the latch,
              // so the genuine latch record ages out and maestro gets retried.
              return failResult(
                `cdp_run_action: ${args.actionId} probe-routed to CDP/JS (at-risk: ${atRisk}) and failed at step ${replay.failedStepIndex}: ${replay.reason}. Maestro was not attempted; rerun with RN_BLIND_PROBE=0 to force the engine path.`,
                'FALLBACK_REPLAY_FAILED',
                {
                  actionId: args.actionId,
                  transport: 'cdp-js',
                  blindProbe,
                  timings_ms,
                  failedStepIndex: replay.failedStepIndex,
                },
              );
            } catch (e) {
              if (!(e instanceof UnsupportedStepError)) throw e;
              // Defensive only: firstReplayTestId() already returns null when
              // the flow contains ANY unsupported step (it normalizes the whole
              // flow), so this catch is normally unreachable — kept so a
              // grammar divergence can never block the maestro path below.
            }
          }
        }
      }

      // ─── First attempt ───────────────────────────────────────────────
      // Issue #120: capture per-phase timing so MTTR analysis (#105) can
      // distinguish "fast detection / slow repair" from "slow detection
      // / fast repair". Phase boundaries: t0 → tFirstDone → tRepairDone
      // → tRetryDone.
      const tBeforeFirst = Date.now();
      const firstResult = await maestroRun({
        flowPath: action.filePath,
        platform: args.platform,
        timeoutMs,
        params: args.params,
      });
      const firstAttemptMs = Date.now() - tBeforeFirst;
      const firstEnv = parseEnvelope(firstResult, 'maestro_run');
      const firstPassed = firstEnv.ok === true && firstEnv.data?.passed === true;
      const firstOutput = readMaestroOutput(firstEnv);
      const firstFailureDetail = readMaestroFailureDetail(firstEnv, firstOutput);

      if (firstPassed) {
        // Happy path — append RunRecord with no auto-repair.
        const autoRepair: AutoRepairOutcome = {
          attempted: false,
          outcome: 'skipped',
          phases: { firstAttemptMs },
        };
        const persisted = await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'pass',
          trigger,
          autoRepair,
        });
        return okResult({
          passed: true,
          actionId: args.actionId,
          ...(proofReplay ? { proofReplay: true } : {}),
          ...replaySuccessEvidence(firstEnv),
          repair: autoRepair,
          autoRepair,
          writes: writeDisclosure(persisted.promoted ? 'lifecycle-promotion' : 'none'),
          durationMs: Date.now() - t0,
          flowFile: action.filePath,
          firstAttemptOutput: firstOutput.slice(0, 500),
        });
      }

      // ─── First attempt failed — classify ─────────────────────────────
      const failure = parseMaestroFailure(firstOutput, readMaestroTerminal(firstEnv));

      // GH #186: structural route-drift takes precedence over selector repair.
      // If the action recorded an expected route sequence and the LIVE route is
      // off it, an unexpected screen appeared (e.g. an inserted CouponCode) — a
      // fuzzy selector repair would be wrong, so reclassify as ROUTE_DRIFT and
      // skip repair. Live route is fetched within a bounded budget (best-effort;
      // the default fetcher is a no-op until index.ts wires a CDP-backed one).
      const expectedSeq = action.metadata.expectedRouteSequence;
      if (failure.kind === 'SELECTOR_NOT_FOUND' && expectedSeq && expectedSeq.length > 0) {
        const liveRoute = await getLiveRoute().catch(() => null);
        const drift = classifyRouteDriftAfterFailure({ expectedSequence: expectedSeq, liveRoute });
        if (drift.isDrift) {
          const autoRepair: AutoRepairOutcome = {
            attempted: false,
            outcome: 'refused',
            refusedReason: 'ROUTE_DRIFT',
            phases: { firstAttemptMs },
          };
          await persistRunWithDevice({
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - t0,
            status: 'fail',
            failureCode: 'ROUTE_DRIFT',
            failureDetail: drift.reason ?? 'route drift',
            trigger,
            autoRepair,
          });
          return failResult(
            `cdp_run_action: ${args.actionId} hit structural route-drift — ${drift.reason}. The flow changed shape; re-record the action. Auto-repair skipped (it only fixes stale selectors, not inserted/changed screens).`,
            'ROUTE_DRIFT',
            {
              actionId: args.actionId,
              failureKind: 'ROUTE_DRIFT',
              liveRoute: drift.liveRoute,
              expectedRouteSequence: expectedSeq,
              autoRepair,
            },
          );
        }
      }

      // GH #317 Phase 2: CDP/JS transport-blind fallback (broadened to UNKNOWN).
      // On iOS 26.x bridgeless, WDA fails two ways while the app renders fine:
      //   SELECTOR_NOT_FOUND — WDA drove but couldn't see the element (probe = failed selector)
      //   UNKNOWN            — WDA died at launch before any selector (probe = first action testID)
      // In both, if the probe testID is verbatim-present in the CDP tree the app IS
      // rendering, so this is transport-blindness, not a crash — replay via CDP/JS.
      // GH #423: the probe retries through a reconnecting CDP (the failed flow
      // usually just relaunched the app), and every skip records its reason —
      // a silent skip surfaced in the field as an unexplained UNKNOWN.
      let cdpJsFallback: CdpJsFallbackSkip | undefined;
      if (failure.kind === 'SELECTOR_NOT_FOUND' || failure.kind === 'UNKNOWN') {
        const replayDeps = getReplayDeps(args);
        const probe = !replayDeps
          ? null
          : failure.kind === 'SELECTOR_NOT_FOUND'
            ? failure.selector
            : firstReplayTestId(action.body, args.params ?? {});
        if (!replayDeps) {
          cdpJsFallback = { attempted: false, reason: 'no-replay-deps' };
        } else if (!probe) {
          cdpJsFallback = { attempted: false, reason: 'no-probe-testid' };
        } else {
          const probeOutcome = await probeTreeWithRetry(replayDeps, probe, probeRetry);
          if (!probeOutcome.found) {
            cdpJsFallback = {
              attempted: false,
              reason: probeOutcome.sawTree ? 'testid-not-in-tree' : 'cdp-unreachable',
            };
          } else {
            try {
              const replay = await runCdpReplay(action.body, args.params ?? {}, replayDeps);
              const status = replay.passed ? 'pass' : 'fail';
              const autoRepair: AutoRepairOutcome = {
                attempted: false,
                outcome: 'skipped',
                phases: { firstAttemptMs },
              };
              const persisted = await persistRunWithDevice({
                timestamp: new Date().toISOString(),
                durationMs: Date.now() - t0,
                status,
                failureCode: replay.passed ? undefined : 'TRANSPORT_BLIND',
                failureDetail: replay.reason,
                trigger,
                autoRepair,
                transport: 'cdp-js',
              });
              if (replay.passed) {
                return okResult({
                  passed: true,
                  actionId: args.actionId,
                  transport: 'cdp-js',
                  transportVersion: null,
                  fallback: 'cdp-js',
                  repair: autoRepair,
                  autoRepair,
                  writes: writeDisclosure(persisted.promoted ? 'lifecycle-promotion' : 'none'),
                  durationMs: Date.now() - t0,
                  flowFile: action.filePath,
                });
              }
              return failResult(
                `cdp_run_action: ${args.actionId} replayed via CDP/JS (WDA transport-blind) and failed at step ${replay.failedStepIndex}: ${replay.reason}`,
                'TRANSPORT_BLIND',
                {
                  actionId: args.actionId,
                  transport: 'cdp-js',
                  failedStepIndex: replay.failedStepIndex,
                },
              );
            } catch (e) {
              if (e instanceof UnsupportedStepError) {
                return failResult(
                  `cdp_run_action: ${args.actionId} cannot replay via CDP/JS — ${e.message}. This action uses a step type the iOS 26.x fallback doesn't support; run on iOS 18 (WDA works there).`,
                  'UNSUPPORTED_STEP' as ToolErrorCode,
                  { actionId: args.actionId, stepKey: e.stepKey },
                );
              }
              throw e;
            }
          }
        }
      }

      // Skip repair if disabled or if the failure isn't a repair shape.
      if (!autoRepairEnabled || !isAutoRepairable(failure)) {
        // PR #115 review (both providers conf 88): distinguish opt-out
        // (USER_DISABLED) from the kind-not-repairable skip path so MTTR
        // analysis can tell "user said no" from "kind isn't repairable".
        const autoRepair: AutoRepairOutcome = autoRepairEnabled
          ? {
              attempted: false,
              outcome: failure.kind === 'WDA_BOOTSTRAP_FAILED' ? 'refused' : 'skipped',
              refusedReason:
                failure.kind === 'WDA_BOOTSTRAP_FAILED' ? 'WDA_BOOTSTRAP' : 'NOT_REPAIRABLE_KIND',
              phases: { firstAttemptMs },
            }
          : {
              attempted: false,
              outcome: 'refused',
              refusedReason: 'USER_DISABLED',
              phases: { firstAttemptMs },
            };
        const { actionCode, toolCode } = classifyFailure(failure);
        await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: actionCode,
          failureDetail: firstFailureDetail.slice(0, 1000),
          trigger,
          autoRepair,
        });
        const meta = {
          actionId: args.actionId,
          failureKind: failure.kind,
          underlyingFailure: firstFailureDetail,
          autoRepair,
          firstAttemptOutput: firstOutput.slice(0, 500),
          terminal: readMaestroTerminal(firstEnv),
          runnerResume: (firstEnv.meta as { runnerResume?: unknown } | undefined)?.runnerResume,
          ...(cdpJsFallback ? { cdpJsFallback } : {}),
        };
        let message =
          failure.kind === 'WDA_BOOTSTRAP_FAILED'
            ? `cdp_run_action: ${args.actionId} failed (WDA_BOOTSTRAP_FAILED) before the first replay step: ${failure.detail}. Re-run the replay (bootstrap retries itself); check network access; inspect ~/.maestro-runner/bin/maestro-runner wda version. No preparation or cache mutation was attempted.`
            : `cdp_run_action: ${args.actionId} failed (${failure.kind})${autoRepairEnabled ? ' — failure not auto-repairable' : ' — auto-repair disabled'}: ${firstFailureDetail}`;
        // GH #423: an UNKNOWN with the fallback skipped for CDP reasons was an
        // opaque dead end in the field — say why and what to do next.
        if (cdpJsFallback?.reason === 'cdp-unreachable') {
          message +=
            '. Maestro failed before completing the flow (on iOS 26.x WDA often dies at startup) and the CDP/JS replay fallback was skipped: CDP was unreachable after the flow. Check cdp_status and reconnect, then retry; if another XCUITest automation is driving this simulator, stop it first.';
        }
        return toolCode ? failResult(message, toolCode, meta) : failResult(message, meta);
      }

      // ─── SELECTOR_NOT_FOUND with auto-repair enabled ─────────────────
      if (failure.kind !== 'SELECTOR_NOT_FOUND') {
        // Defensive: isAutoRepairable should already exclude non-selector
        // failures, but TS doesn't narrow through `isAutoRepairable`.
        // PR #115 review (Codex conf 80): bare `throw` here was uncaught
        // — now lands in the outer catch and becomes a structured
        // failResult + persisted RunRecord.
        throw new Error(
          'Internal: isAutoRepairable returned true for non-SELECTOR_NOT_FOUND failure',
        );
      }

      const tBeforeRepair = Date.now();
      const repairResult = await repairAction({
        actionId: args.actionId,
        failedSelector: failure.selector,
        projectRoot,
        agentReasoning: `auto-repair from cdp_run_action after maestro failure: ${failure.selector}`,
      });
      const repairMs = Date.now() - tBeforeRepair;
      const repairEnv = parseEnvelope(repairResult, 'cdp_repair_action');
      const repairPatched =
        repairEnv.ok === true && (repairEnv.data as { patched?: boolean })?.patched === true;

      if (!repairPatched) {
        const refusedReason = mapRefusedReason(
          (repairEnv as { code?: string }).code,
          repairEnv.error ?? '',
        );
        const autoRepair: AutoRepairOutcome = {
          attempted: true,
          outcome: 'refused',
          refusedReason,
          phases: { firstAttemptMs, repairMs },
        };
        await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: 'SELECTOR_NOT_FOUND',
          failureDetail: firstOutput.slice(0, 500),
          trigger,
          autoRepair,
        });
        return failResult(
          `cdp_run_action: ${args.actionId} failed with SELECTOR_NOT_FOUND; auto-repair refused (${refusedReason}): ${repairEnv.error ?? 'unknown'}`,
          refusedReason === 'TRANSPORT_BLIND' ? 'TRANSPORT_BLIND' : 'TESTID_NOT_FOUND',
          {
            actionId: args.actionId,
            autoRepair,
            repairError: repairEnv.error,
            firstAttemptOutput: firstOutput.slice(0, 500),
          },
        );
      }

      // ─── Repair succeeded — replay once ──────────────────────────────
      const repairData = repairEnv.data as {
        oldSelector: string;
        newSelector: string;
      };

      // The repair updated the action on disk. Re-load to pick up the
      // new body + bumped revision/state — saveAction's atomic pair-write
      // means we can read it back deterministically.
      const reloadedAction = loadAction(projectRoot, args.actionId);
      if (!reloadedAction) {
        // Shouldn't happen — repair just wrote it. Defensive surface.
        // Persist the failure RunRecord so MTTR sees the outcome.
        await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: 'UNKNOWN',
          failureDetail: 'action disappeared between repair and retry',
          trigger,
          autoRepair: {
            attempted: true,
            outcome: 'refused',
            refusedReason: 'INTERNAL_ERROR',
            phases: { firstAttemptMs, repairMs },
          },
        });
        return failResult(
          `cdp_run_action: action disappeared between repair and retry — investigate filesystem`,
          'NO_PROJECT_ROOT',
        );
      }

      const tBeforeRetry = Date.now();
      const retryResult = await maestroRun({
        flowPath: reloadedAction.filePath,
        platform: args.platform,
        timeoutMs,
        params: args.params,
      });
      const retryMs = Date.now() - tBeforeRetry;
      const retryEnv = parseEnvelope(retryResult, 'maestro_run');
      const retryPassed = retryEnv.ok === true && retryEnv.data?.passed === true;
      const retryOutput = readMaestroOutput(retryEnv);
      const retryFailureDetail = readMaestroFailureDetail(retryEnv, retryOutput);

      // Issue #120: pull the repair-engine's similarity score and the
      // RepairRecord's timestamp into the AutoRepairOutcome so MTTR can
      // both rank patches by confidence and cross-reference to the
      // RepairRecord without timestamp-fuzzy-matching.
      const repairScore = (repairEnv.data as { score?: number } | undefined)?.score;
      const repairTimestamp =
        reloadedAction.state.repairHistory.length > 0
          ? reloadedAction.state.repairHistory[reloadedAction.state.repairHistory.length - 1]
              .timestamp
          : undefined;

      // GH #119: when the retry fails on a DIFFERENT selector than the
      // one just patched, capture it as `nextFailedSelector` so MTTR
      // analysis can distinguish "patch didn't work" from "cascading
      // failure — patch worked, next selector broke." Only meaningful
      // when retry failed; same-selector failures (= patch didn't work)
      // are implicit in the existing diff.
      let nextFailedSelector: string | undefined;
      if (!retryPassed) {
        try {
          const retryFailure = parseMaestroFailure(retryOutput, readMaestroTerminal(retryEnv));
          if (
            retryFailure.kind === 'SELECTOR_NOT_FOUND' &&
            retryFailure.selector &&
            retryFailure.selector !== repairData.newSelector
          ) {
            nextFailedSelector = retryFailure.selector;
          }
        } catch {
          /* best-effort — don't fail the run because the parser hiccuped */
        }
      }

      const autoRepair: AutoRepairOutcome = {
        attempted: true,
        outcome: retryPassed ? 'passed' : 'failed',
        diff: {
          selector: {
            from: repairData.oldSelector,
            to: repairData.newSelector,
            ...(typeof repairScore === 'number' ? { score: repairScore } : {}),
          },
        },
        phases: { firstAttemptMs, repairMs, retryMs },
        repairTimestamp,
        ...(nextFailedSelector ? { nextFailedSelector } : {}),
      };

      await persistRunWithDevice({
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
        status: retryPassed ? 'pass' : 'fail',
        failureCode: retryPassed ? undefined : 'SELECTOR_NOT_FOUND',
        failureDetail: retryPassed ? undefined : retryFailureDetail.slice(0, 1000),
        trigger,
        autoRepair,
      });

      if (retryPassed) {
        return okResult({
          passed: true,
          actionId: args.actionId,
          ...replaySuccessEvidence(retryEnv),
          repair: autoRepair,
          autoRepair,
          writes: writeDisclosure('auto-repair'),
          durationMs: Date.now() - t0,
          flowFile: reloadedAction.filePath,
          retriedAfterRepair: true,
          retryOutput: retryOutput.slice(0, 500),
        });
      }

      return failResult(
        `cdp_run_action: ${args.actionId} still failing after auto-repair (${repairData.oldSelector} → ${repairData.newSelector}): ${retryFailureDetail}`,
        'TESTID_NOT_FOUND',
        {
          actionId: args.actionId,
          autoRepair,
          writes: writeDisclosure('auto-repair'),
          firstAttemptOutput: firstOutput.slice(0, 500),
          retryOutput: retryOutput.slice(0, 500),
          underlyingFailure: retryFailureDetail,
        },
      );
    } catch (err) {
      // Multi-LLM review of PR #115 (Gemini conf 95): top-level catch
      // ensures any thrown exception during orchestration (maestroRun
      // timeout, repairAction throw through withSession, etc.) lands
      // here as a structured failResult WITH a persisted RunRecord —
      // not as an uncaught exception that crashes the MCP request and
      // loses telemetry entirely.
      const msg = err instanceof Error ? err.message : String(err);
      const autoRepair: AutoRepairOutcome = {
        attempted: false,
        outcome: 'refused',
        refusedReason: 'INTERNAL_ERROR',
      };
      try {
        await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: 'UNKNOWN',
          failureDetail: `Internal error: ${msg.slice(0, 400)}`,
          trigger,
          autoRepair,
        });
      } catch {
        // Don't let a persistence failure mask the original error —
        // surface the original exception via failResult below.
      }
      return failResult(
        `cdp_run_action: ${args.actionId} threw an uncaught exception during orchestration: ${msg.slice(0, 500)}`,
        { actionId: args.actionId, autoRepair, internalError: msg.slice(0, 500) },
      );
    }
  };
}

/**
 * Append a RunRecord to the action's runtime sidecar without rewriting YAML.
 *
 * Multi-LLM review of PR #115:
 *   - Codex I6 (conf 80): `actionId` is now passed explicitly rather
 *     than derived from `action.filePath`. The previous regex-based
 *     derivation broke for non-canonical paths (inline-yaml synthetic
 *     paths, symlinks) and silently dropped the RunRecord on a derive
 *     failure.
 *   - Codex C2 / Gemini C2 (conf 92): if `loadAction` returns null we
 *     log the dropped record to stderr instead of swallowing silently
 *     so the operator can see telemetry loss in their MCP logs.
 */
interface PersistRunOutcome {
  promoted: boolean;
}

async function persistRun(
  actionId: string,
  projectRoot: string,
  record: RunRecord,
): Promise<PersistRunOutcome> {
  // Re-load to get the freshest state — repair-action may have just
  // bumped revision/repairHistory. Issue #117's bounded CAS retry remains,
  // but only the ignored runtime sidecar is written on ordinary replay.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const fresh = loadAction(projectRoot, actionId);
    if (!fresh) {
      console.error(
        `cdp_run_action: persistRun could not reload action "${actionId}" — RunRecord dropped (status=${record.status}, autoRepair.outcome=${record.autoRepair?.outcome ?? 'n/a'})`,
      );
      return { promoted: false };
    }
    const nextState = appendRunRecord(fresh.state, record);
    const promotes = shouldAutoPromoteToActive(fresh.metadata, record);
    // Runtime telemetry is sidecar-only. A replay that did not apply repair
    // must preserve tracked YAML bytes (including documentation comments).
    const commit = (promoted: boolean): PersistRunOutcome => {
      mirrorToDb({
        yamlFilePath: fresh.filePath,
        state: fresh.state,
        newRunRecord: record,
        meta: {
          appId: fresh.metadata.appId,
          status: promoted ? 'active' : fresh.metadata.status,
          path: fresh.filePath,
        },
      });
      return { promoted };
    };
    // A promotion refusal is deterministic (externally edited YAML, or a missing
    // `# status: experimental` marker) — retrying cannot clear it, so degrade to
    // the sidecar-only append instead of failing an otherwise successful replay.
    if (promotes && promoteActionRuntimeWithCAS(fresh, nextState).ok) return commit(true);
    if (saveActionRuntimeWithCAS(fresh, nextState).ok) return commit(false);
    // Sidecar CAS conflict — another writer raced us. Reload and retry.
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `persistRun for "${actionId}" hit ${MAX_ATTEMPTS} consecutive sidecar CAS conflicts; ` +
          `the runtime sidecar changed after load. RunRecord was not written.`,
      );
    }
  }
  return { promoted: false };
}
