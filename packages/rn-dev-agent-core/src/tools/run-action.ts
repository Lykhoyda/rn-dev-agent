// Issue #104 — `cdp_run_action` MCP tool. Replays a learned action's
// Maestro flow, parses failures, optionally auto-repairs on
// SELECTOR_NOT_FOUND, and persists a RunRecord with auto-repair
// telemetry to the action's sidecar.
//
// Composition:
//   1. loadAction(projectRoot, actionId) — fail fast if missing.
//   2. createMaestroRunHandler() — first attempt (delegates to the
//      existing `maestro_run` tool, single source of truth for the
//      exact maestro-runner dispatch).
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

import { randomUUID } from 'node:crypto';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import {
  acknowledgeExternalEdit,
  assertReadableActionLoadContextStable,
  loadAction,
  loadActionFromContext,
  openReadableActionLoadContext,
  promoteActionRuntimeWithCAS,
  refreshActionLoadContext,
  saveActionRuntimeWithCAS,
  type ReadableActionLoadContext,
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
import { sidecarPathFor } from '../domain/sidecar-io.js';
import { classifyRouteDriftAfterFailure } from '../nav-graph/route-sequence.js';
import { SessionAuthorityError } from '../session/registry.js';
import type { MaestroDeviceAuthority } from '../domain/maestro-device-authority.js';
import {
  claimManagedNativeOriginAuthority,
  completeManagedRunnerParkAuthority,
  completeManagedNativeOriginAuthority,
  reissueManagedInstallAuthority,
  relaunchManagedNativeOriginApp,
  reproveManagedNativeOrigin,
  type ManagedNativeOriginReproveOptions,
} from '../session/authority-gate.js';
import { getWorkerAuthorityRuntime } from '../session/runtime.js';
import { flowUsesClearState, resolveIosAppFile } from './resolve-ios-app-file.js';
import { actionReplayPreflight } from '../domain/action-engine-compat.js';
import { planIosProofDomains } from '../domain/ios-proof-router.js';
import {
  getEngineStatus,
  PINNED_RUNNER_DIAGNOSE_HINT,
  PINNED_RUNNER_INSTALL_HINT,
  type ReplayEngineStatus,
} from '../domain/engine-pin.js';
import {
  isProvenTrailingVerificationQualifier,
  type TrailingVerificationQualifier,
} from '../domain/maestro-run-ledger.js';
import {
  formatRuntimeSlowCaveat,
  runtimeDegradationFromMetadata,
  runtimeDegradationMetadata,
  type RuntimeDegradation,
} from '../domain/tap-latency.js';

const strictRunActionPolicy = Symbol('strictRunActionPolicy');

type StrictRunActionArgs = RunActionArgs & { [strictRunActionPolicy]?: true };

export function sealStrictRunAction(args: RunActionArgs): RunActionArgs {
  Object.defineProperty(args, strictRunActionPolicy, { value: true });
  return args;
}

function usesStrictRunActionPolicy(args: RunActionArgs): boolean {
  return (args as StrictRunActionArgs)[strictRunActionPolicy] === true;
}

/** GH #705: the session's attested install receipt, or null outside a session. */
function boundInstallReceipt(): { platform?: unknown; deviceId?: unknown; appId?: unknown } | null {
  try {
    const status = getWorkerAuthorityRuntime().status();
    if (!status.available) return null;
    const install = status.bindings.install as Record<string, unknown> | undefined;
    return install ?? null;
  } catch {
    return null;
  }
}

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

function actionFailureCodeForToolCode(code: ToolErrorCode): ActionFailureCode {
  switch (code) {
    case 'TESTID_NOT_FOUND':
      return 'SELECTOR_NOT_FOUND';
    case 'ASSERTION_FAILED':
      return 'STATE_MISMATCH';
    case 'CDP_NOT_CONNECTED':
      return 'ENV_UNREACHABLE';
    case 'RECONNECT_TIMEOUT':
    case 'RUNNER_TIMEOUT':
      return 'TIMEOUT';
    case 'WDA_BOOTSTRAP_FAILED':
    case 'NATIVE_SURFACE_BLIND':
    case 'DEVICE_AUTHORITY_MISMATCH':
    case 'ROUTE_DRIFT':
    case 'TRANSPORT_BLIND':
    case 'FALLBACK_REPLAY_FAILED':
      return code;
    default:
      return 'UNKNOWN';
  }
}

export interface RunActionArgs {
  /** Action id matching `<projectRoot>/.rn-agent/actions/<actionId>.yaml` or `.yml`. */
  actionId: string;
  appId?: string;
  /**
   * GH #705: path to the `.app` Maestro reinstalls from after a `clearState`
   * uninstall. Omit it — the session's attested install receipt resolves the
   * bundle automatically for iOS clearState flows.
   */
  appFile?: string;
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
  code?: ToolErrorCode;
  data?: {
    passed?: boolean;
    output?: string;
    flowFile?: string;
    platform?: string;
    terminal?: MaestroTerminal;
    runner?: string;
    transport?: string;
    proofDomain?: 'react-tree' | 'xctest-native' | 'partitioned';
    transportVersion?: string | null;
    fallback?: string;
    enginePin?: {
      pinned?: string;
      status?: string;
    };
    deviceAuthority?: MaestroDeviceAuthority;
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

const PROVEN_ENGINE_PIN_DIVERGENCE = new Set(['drift-newer', 'drift-older', 'checksum-mismatch']);

function strictEnginePinDivergence(env: MaestroEnvelope): string | null {
  const status = env.data?.enginePin?.status;
  return typeof status === 'string' && PROVEN_ENGINE_PIN_DIVERGENCE.has(status) ? status : null;
}

function parseEnvelope(toolResult: ToolResult, toolName: string): MaestroEnvelope {
  try {
    return JSON.parse(toolResult.content?.[0]?.text ?? '{}') as MaestroEnvelope;
  } catch {
    return { ok: false, error: `Unparseable ${toolName} envelope` };
  }
}

function typedReactSelectorFailure(env: MaestroEnvelope, raw: string): MaestroFailure | null {
  const proofDomain = env.meta?.proofDomain;
  const failedProofDomain = env.meta?.failedProofDomain;
  const failedSelector = env.meta?.failedSelector;
  if (
    env.code !== 'TESTID_NOT_FOUND' ||
    (proofDomain !== 'react-tree' && failedProofDomain !== 'react-tree') ||
    typeof failedSelector !== 'string' ||
    failedSelector.length === 0
  ) {
    return null;
  }
  return {
    kind: 'SELECTOR_NOT_FOUND',
    selectorKind: 'id',
    selector: failedSelector,
    raw,
  };
}

function replaySuccessEvidence(env: MaestroEnvelope): {
  transport: string;
  transportVersion: string | null;
  fallback: string;
  proofDomain: 'react-tree' | 'xctest-native' | 'partitioned';
  deviceAuthority?: MaestroDeviceAuthority;
  perStepReadback: {
    source: 'maestro-runner-step-report' | 'react-tree-step-trace' | 'partitioned-step-trace';
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
    proofDomain: env.data?.proofDomain ?? 'xctest-native',
    ...(env.data?.deviceAuthority ? { deviceAuthority: env.data.deviceAuthority } : {}),
    perStepReadback: {
      source:
        env.data?.proofDomain === 'react-tree'
          ? 'react-tree-step-trace'
          : env.data?.proofDomain === 'partitioned'
            ? 'partitioned-step-trace'
            : 'maestro-runner-step-report',
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

function readMaestroDeviceAuthority(env: MaestroEnvelope): MaestroDeviceAuthority | undefined {
  if (env.data?.deviceAuthority) return env.data.deviceAuthority;
  return (env.meta as { deviceAuthority?: MaestroDeviceAuthority } | undefined)?.deviceAuthority;
}

function readRuntimeDegradation(env: MaestroEnvelope): RuntimeDegradation | undefined {
  for (const source of [env.meta, env.data as Record<string, unknown> | undefined]) {
    const degradation = runtimeDegradationFromMetadata(source?.runtimeDegraded);
    if (degradation) return degradation;
  }
  return undefined;
}

// GH #623: anything short of the fully validated proven shape reads as absent.
function readTrailingVerification(
  env: MaestroEnvelope,
  dispatched: {
    attemptId: string;
    ordinal: number;
    kind: 'initial' | 'repaired';
    parentAttemptId?: string;
  },
): TrailingVerificationQualifier | undefined {
  for (const source of [env.meta, env.data as Record<string, unknown> | undefined]) {
    const candidate = (source as { trailingVerification?: unknown })?.trailingVerification;
    if (!isProvenTrailingVerificationQualifier(candidate)) continue;
    // The qualifier must be bound to THIS dispatched attempt — a stale or
    // unrelated attempt's evidence never softens this failure.
    if (
      candidate.attempt.attemptId !== dispatched.attemptId ||
      candidate.attempt.ordinal !== dispatched.ordinal ||
      candidate.attempt.kind !== dispatched.kind ||
      candidate.attempt.parentAttemptId !== dispatched.parentAttemptId
    ) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

function terminalReason(terminal: MaestroTerminal | undefined): string {
  if (!terminal?.failureKind) return '';
  return ` (${terminal.failureKind}${terminal.failureSelector ? `: ${terminal.failureSelector}` : ''})`;
}

/**
 * maestro_run builds its headline from the full runner stream before slicing
 * data.output/meta.output. Keep that headline as the authoritative failure
 * detail so cdp_run_action never reduces a useful terminal step to UNKNOWN just
 * because the report preamble consumed the bounded output field.
 *
 * GH #580: the WARN path (runner exit 0 with failures) carries no `env.error` and
 * puts its step summary in `data`, not `meta`, so it degraded to a bare slice.
 */
function readMaestroFailureDetail(env: MaestroEnvelope, output: string): string {
  if (typeof env.error === 'string' && env.error.trim()) return env.error.trim();
  const terminal = readMaestroTerminal(env);
  const reason = terminalReason(terminal);
  const metaStep = (env.meta as { failedStep?: { name?: unknown } } | undefined)?.failedStep;
  const dataStep = (env.data as { failedStep?: { name?: unknown } } | undefined)?.failedStep;
  const stepName =
    typeof metaStep?.name === 'string'
      ? metaStep.name
      : typeof dataStep?.name === 'string'
        ? dataStep.name
        : terminal?.failedStep;
  if (stepName) return `Maestro flow failed at step "${stepName}"${reason}`;
  if (reason) return `Maestro flow failed${reason.trim()}`;
  return boundedOutput(output.trim(), 1000) || 'Maestro runner returned no failure detail';
}

// GH #580 defect 3: the terminal failure sits at the TAIL of runner stdout while
// the head carries the WDA preamble, so a head-only slice showed only the preamble.
// Over-budget input always returns exactly `budget` characters.
const OUTPUT_BUDGET = 500;
const OUTPUT_ELISION = '\n…\n';

export function boundedOutput(output: string, budget: number = OUTPUT_BUDGET): string {
  const text = typeof output === 'string' ? output : '';
  if (text.length <= budget) return text;
  const room = budget - OUTPUT_ELISION.length;
  const head = Math.ceil(room / 2);
  return text.slice(0, head) + OUTPUT_ELISION + text.slice(text.length - (room - head));
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
  /** Exact active session authority forwarded to Maestro; never best-available. */
  targetContext?: () => {
    platform?: string;
    deviceId?: string;
    appId?: string;
  } | null;
  claimBundleAuthority?: (args: RunActionArgs) => Promise<boolean>;
  claimNativeOrigin?: (args: RunActionArgs) => Promise<void>;
  completeNativeOrigin?: (
    args: RunActionArgs,
    targetExpected: boolean,
    signal?: AbortSignal,
  ) => Promise<void>;
  relaunchManagedApp?: (args: RunActionArgs, stopApp?: boolean) => Promise<void>;
  reproveManagedOrigin?: (
    args: RunActionArgs,
    options?: ManagedNativeOriginReproveOptions,
  ) => Promise<void>;
  reissueInstallReceipt?: (args: RunActionArgs) => Promise<void>;
  /** GH #705: the session's attested install receipt, for appFile auto-resolution. */
  installReceipt?: () => { platform?: unknown; deviceId?: unknown; appId?: unknown } | null;
  resolveAppFile?: (appId: string, deviceId: string) => string | null;
  engineStatus?: () => Promise<ReplayEngineStatus | null>;
}

function replayCorpusIdentityRefusal(
  context: ReadableActionLoadContext,
  actionId: string,
  meta?: Record<string, unknown>,
): ToolResult | null {
  try {
    assertReadableActionLoadContextStable(context);
    return null;
  } catch (error) {
    return failResult(error instanceof Error ? error.message : String(error), 'BAD_FILENAME', {
      actionId,
      fallback: 'none',
      ...meta,
    });
  }
}

export function createRunActionHandler(deps: RunActionDeps = {}) {
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
  const repairAction = deps.repairAction ?? createRepairActionHandler();
  const getLiveRoute = deps.getLiveRoute ?? (async () => null);
  const targetContext = deps.targetContext ?? (() => null);
  const claimBundleAuthority = deps.claimBundleAuthority ?? (async () => true);
  const claimNativeOrigin = deps.claimNativeOrigin ?? claimManagedNativeOriginAuthority;
  const completeNativeOrigin = deps.completeNativeOrigin ?? completeManagedNativeOriginAuthority;
  const relaunchManagedApp = deps.relaunchManagedApp ?? relaunchManagedNativeOriginApp;
  const reproveManagedOrigin = deps.reproveManagedOrigin ?? reproveManagedNativeOrigin;
  const reissueInstallReceipt = deps.reissueInstallReceipt ?? reissueManagedInstallAuthority;
  const installReceipt = deps.installReceipt ?? boundInstallReceipt;
  const resolveAppFile =
    deps.resolveAppFile ??
    ((appId: string, deviceId: string) => resolveIosAppFile(appId, { deviceId }));
  const resolveEngineStatus = deps.engineStatus ?? (() => getEngineStatus().catch(() => null));
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
    let openedContext: ReadableActionLoadContext | null;
    let loaded: ReturnType<typeof loadAction>;
    try {
      openedContext = openReadableActionLoadContext(projectRoot, {
        actionId: args.actionId,
        includeRunFlowFiles: true,
      });
      loaded = openedContext ? loadActionFromContext(openedContext, args.actionId) : null;
    } catch (err) {
      return failResult(err instanceof Error ? err.message : String(err), 'BAD_FILENAME', {
        actionId: args.actionId,
        fallback: 'none',
      });
    }
    if (!loaded || !openedContext) {
      return failResult(
        `cdp_run_action: action "${args.actionId}" not found at ${projectRoot}/.rn-agent/actions/${args.actionId}.yaml or ${args.actionId}.yml`,
        'NO_PROJECT_ROOT',
        {
          hint: 'Verify with /list-learned-actions, or pass projectRoot if cdp-bridge is invoked outside the project dir.',
        },
      );
    }
    let loadContext = openedContext;
    if (!loaded.replay.ok) {
      return failResult(
        `Action ${args.actionId} is not valid Maestro YAML: ${loaded.replay.error}`,
        'BAD_RECORDING',
        { actionId: args.actionId, fallback: 'none' },
      );
    }
    const replayYaml = loaded.replay.yamlText;
    const preflightCommands = loaded.replay.commands;
    // GH #173 (sub-issue 3): default-true forceReload acknowledges any
    // human edit to the YAML as the new baseline so downstream auto-repair
    // doesn't abort with STALE_TARGET. Opt out with forceReload: false to
    // get the strict Phase 129 "respect external edits" behavior back.
    const forceReload = proofReplay ? false : args.forceReload !== false;
    const action = forceReload ? acknowledgeExternalEdit(loaded) : loaded;
    let runtimeStatePath = action === loaded ? undefined : sidecarPathFor(action.filePath);
    let actionYamlWrite: WriteDisclosureKind = 'none';
    const writeDisclosure = (
      actionYaml: WriteDisclosureKind = 'none',
      outcome?: PersistRunOutcome,
    ) => {
      const disclosedRuntimeStatePath = outcome?.runtimeStatePath ?? runtimeStatePath;
      return {
        actionYaml:
          actionYaml === 'none'
            ? { written: false, reason: 'repair-not-applied' }
            : actionYaml === 'lifecycle-promotion-refused'
              ? { written: false, reason: 'lifecycle-promotion-refused' }
              : { written: true, authorized: true, reason: actionYaml },
        runtimeState: proofReplay
          ? 'none'
          : disclosedRuntimeStatePath
            ? 'sidecar'
            : outcome?.runtimeStateRefused
              ? 'refused-external-write'
              : 'sidecar',
        ...(disclosedRuntimeStatePath ? { runtimeStatePath: disclosedRuntimeStatePath } : {}),
        databaseMirror: proofReplay ? 'none' : 'best-effort',
      };
    };
    const activeTarget = targetContext();
    const replayPlatform =
      args.platform && activeTarget?.platform && args.platform !== activeTarget.platform
        ? undefined
        : (args.platform ?? activeTarget?.platform);
    const iosProofPlan =
      replayPlatform === 'ios' ? planIosProofDomains(preflightCommands, args.params ?? {}) : null;
    const requiresNativeRuntime =
      iosProofPlan?.ok !== true ||
      iosProofPlan.segments.some((segment) => segment.domain === 'xctest-native');

    let engineStatus: ReplayEngineStatus | null;
    try {
      engineStatus = await resolveEngineStatus();
      assertReadableActionLoadContextStable(loadContext);
    } catch (err) {
      return failResult(err instanceof Error ? err.message : String(err), 'BAD_FILENAME', {
        actionId: args.actionId,
        fallback: 'none',
        ...(runtimeStatePath ? { writes: writeDisclosure() } : {}),
      });
    }
    const compatRefusal = actionReplayPreflight({
      enginePin: action.metadata.enginePin,
      commands: preflightCommands,
      engineStatus,
      requireRuntimePin: requiresNativeRuntime,
    });
    if (compatRefusal) {
      return failResult(compatRefusal, 'ENGINE_PIN_MISMATCH', {
        actionId: args.actionId,
        fallback: 'none',
        pin: engineStatus?.pin,
        selectedPath: engineStatus?.selectedPath ?? null,
        provenance: engineStatus?.provenance ?? 'none',
        ...(runtimeStatePath ? { writes: writeDisclosure() } : {}),
      });
    }

    const autoRepairEnabled = args.autoRepair !== false;
    const trigger: 'agent' | 'ci' | 'human' = args.trigger ?? 'agent';
    const timeoutMs = args.timeoutMs ?? 120_000;
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    const runId = randomUUID();
    const timingSteps: NonNullable<RunRecord['timing']>['steps'] = [];
    const measureStep = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const stepStartedMs = Date.now();
      try {
        return await run();
      } finally {
        const stepEndedMs = Date.now();
        timingSteps.push({
          name,
          startedAt: new Date(stepStartedMs).toISOString(),
          endedAt: new Date(stepEndedMs).toISOString(),
          elapsedMs: Math.max(0, stepEndedMs - stepStartedMs),
        });
      }
    };
    if (args.platform && activeTarget?.platform && activeTarget.platform !== args.platform) {
      return failResult(
        `cdp_run_action: requested ${args.platform}, but the active session is ${activeTarget.platform}; refusing cross-platform replay.`,
        'TARGET_SESSION_MISMATCH',
        {
          requestedPlatform: args.platform,
          activeSession: activeTarget,
          ...(runtimeStatePath ? { writes: writeDisclosure() } : {}),
        },
      );
    }
    const maestroDeviceId =
      (!args.platform || activeTarget?.platform === args.platform) && activeTarget?.deviceId
        ? activeTarget.deviceId
        : undefined;

    // GH #705: a clearState flow uninstalls the app, so Maestro needs the
    // bundle to reinstall from. Resolve it off the session's attested install
    // receipt — the exact device and appId it was signed for — so the
    // "Pass appFile=<path>" advice is followable through this tool.
    const receipt = args.appFile ? null : installReceipt();
    const appFile =
      args.appFile ??
      (flowUsesClearState(replayYaml) &&
      receipt?.platform === 'ios' &&
      typeof receipt.appId === 'string' &&
      typeof receipt.deviceId === 'string'
        ? (resolveAppFile(receipt.appId, receipt.deviceId) ?? undefined)
        : undefined);

    // GH #397: deviceId threading. Handler-scoped (not inside the try) because
    // the outer catch also persists a RunRecord and must carry the device too.
    let probeDeviceId: string | null = null;
    // Directly observed transport device (CDP context, else the session target
    // Maestro was pinned to). Used only when the dispatch produced no receipt,
    // so a clean pass can still clear a device-matched blind-probe latch.
    let observedDeviceId: string | null = maestroDeviceId ?? null;
    const persistRunWithDevice = (record: RunRecord): Promise<PersistRunOutcome> => {
      assertReadableActionLoadContextStable(loadContext);
      if (proofReplay) {
        return Promise.resolve({ promoted: false, promotionRefused: false });
      }
      const endedMs = Date.now();
      const timedRecord: RunRecord = {
        ...record,
        runId,
        timing: {
          startedAt,
          endedAt: new Date(endedMs).toISOString(),
          elapsedMs: Math.max(0, endedMs - t0),
          steps: [...timingSteps],
        },
      };
      return persistRun(
        args.actionId,
        projectRoot,
        probeDeviceId ? { ...timedRecord, deviceId: probeDeviceId } : timedRecord,
      );
    };
    // Multi-LLM review of PR #115 (Gemini conf 95): wrap the orchestration
    // body so a thrown exception (maestroRun timeout, repairAction
    // throwing through withSession, etc.) is caught and surfaces as a
    // structured failResult WITH a persisted RunRecord, instead of
    // bubbling up unwrapped to the MCP framework.
    try {
      const strictExecutor = usesStrictRunActionPolicy(args);
      const strictRunRecordMeta = (outcome: PersistRunOutcome): Record<string, unknown> =>
        strictExecutor && outcome.persistedRunId
          ? { strictRunRecordId: outcome.persistedRunId }
          : {};

      // ─── First attempt ───────────────────────────────────────────────
      // Issue #120: capture per-phase timing so MTTR analysis (#105) can
      // distinguish "fast detection / slow repair" from "slow detection
      // / fast repair". Phase boundaries: t0 → tFirstDone → tRepairDone
      // → tRetryDone.
      const tBeforeFirst = Date.now();
      // Requested/session metadata is not RunRecord authority. Clear it before
      // dispatch; only direct maestro-runner evidence may repopulate it.
      probeDeviceId = null;
      const firstCorpusRefusal = replayCorpusIdentityRefusal(
        loadContext,
        args.actionId,
        runtimeStatePath ? { writes: writeDisclosure() } : undefined,
      );
      if (firstCorpusRefusal) return firstCorpusRefusal;
      // GH #623: the post-repair retry names this attempt as its parent.
      const initialAttemptId = randomUUID();
      const maxAttempts = autoRepairEnabled ? 2 : 1;
      const firstResult = await measureStep('maestro-first-attempt', () =>
        maestroRun({
          inlineYaml: replayYaml,
          actionMetadata: action.metadata,
          platform: args.platform,
          appId: args.appId,
          ...(appFile ? { appFile } : {}),
          deviceId: maestroDeviceId,
          timeoutMs,
          params: args.params,
          attempt: { attemptId: initialAttemptId, ordinal: 1, maxAttempts, kind: 'initial' },
          claimNativeOrigin: () => claimNativeOrigin(args),
          completeNativeOrigin: (targetExpected, signal) =>
            completeNativeOrigin(args, targetExpected, signal),
          relaunchManagedApp: (stopApp) => relaunchManagedApp(args, stopApp),
          reproveManagedOrigin: (options) => reproveManagedOrigin(args, options),
          completeRunnerPark: (signal) => completeManagedRunnerParkAuthority(args, signal),
          reissueInstallReceipt: () => reissueInstallReceipt(args),
        }),
      );
      const firstAttemptMs = Date.now() - tBeforeFirst;
      const firstEnv = parseEnvelope(firstResult, 'maestro_run');
      const firstOutput = readMaestroOutput(firstEnv);
      const firstFailureDetail = readMaestroFailureDetail(firstEnv, firstOutput);
      const firstDeviceAuthority = readMaestroDeviceAuthority(firstEnv);
      probeDeviceId = firstDeviceAuthority?.reportedDeviceId ?? observedDeviceId;
      const enginePinDivergence = strictExecutor ? strictEnginePinDivergence(firstEnv) : null;
      const firstTypedSelectorFailure = typedReactSelectorFailure(firstEnv, firstOutput);

      if (enginePinDivergence) {
        const autoRepair: AutoRepairOutcome = {
          attempted: false,
          outcome: 'refused',
          refusedReason: 'NOT_REPAIRABLE_KIND',
          phases: { firstAttemptMs },
        };
        const persisted = await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: 'UNKNOWN',
          failureDetail: `Engine pin status ${enginePinDivergence}`,
          trigger,
          autoRepair,
        });
        return failResult(
          `cdp_run_action: ${args.actionId} refused strict replay because the engine pin status is ${enginePinDivergence}.`,
          'ENGINE_PIN_MISMATCH',
          {
            actionId: args.actionId,
            failureKind: 'ENGINE_PIN_MISMATCH',
            enginePin: firstEnv.data?.enginePin,
            autoRepair,
            writes: writeDisclosure('none', persisted),
            ...strictRunRecordMeta(persisted),
          },
        );
      }

      const firstPassed = firstEnv.ok === true && firstEnv.data?.passed === true;

      if (firstEnv.code && !firstTypedSelectorFailure) {
        const typedCode = firstEnv.code;
        const autoRepair: AutoRepairOutcome = {
          attempted: false,
          outcome: args.autoRepair === false ? 'refused' : 'skipped',
          refusedReason: args.autoRepair === false ? 'USER_DISABLED' : 'NOT_REPAIRABLE_KIND',
          phases: { firstAttemptMs },
        };
        const persisted = await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: actionFailureCodeForToolCode(typedCode),
          failureDetail: firstFailureDetail.slice(0, 1000),
          trigger,
          autoRepair,
        });
        return failResult(
          `cdp_run_action: ${args.actionId} refused replay: ${firstFailureDetail}`,
          typedCode,
          {
            ...firstEnv.meta,
            actionId: args.actionId,
            failureKind: typedCode,
            deviceAuthority: firstDeviceAuthority,
            ...(typedCode === 'NATIVE_SURFACE_BLIND'
              ? {
                  proofDomain: firstEnv.meta?.proofDomain,
                  runner: firstEnv.meta?.runner,
                  transportVersion: firstEnv.meta?.transportVersion,
                  nativeVision: firstEnv.meta?.nativeVision,
                  cleanup: firstEnv.meta?.cleanup,
                  nextAction: firstEnv.meta?.nextAction,
                }
              : {}),
            autoRepair,
            writes: writeDisclosure('none', persisted),
            ...strictRunRecordMeta(persisted),
          },
        );
      }

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
          ...(firstEnv.data?.transport === 'cdp-js' ? { transport: 'cdp-js' as const } : {}),
          ...(firstEnv.data?.proofDomain ? { proofDomain: firstEnv.data.proofDomain } : {}),
        });
        if (strictExecutor && persisted.persistedRunId !== runId) {
          return failResult(
            `cdp_run_action: ${args.actionId} passed, but its authoritative RunRecord was not committed.`,
            'LOAD_FAILED',
            {
              actionId: args.actionId,
              failureKind: 'AUTHORITATIVE_RUN_RECORD_MISSING',
              writes: writeDisclosure('none', persisted),
            },
          );
        }
        return okResult({
          passed: true,
          actionId: args.actionId,
          ...(strictExecutor ? { strictRunRecordId: persisted.persistedRunId } : {}),
          ...(proofReplay ? { proofReplay: true } : {}),
          ...replaySuccessEvidence(firstEnv),
          repair: autoRepair,
          autoRepair,
          writes: writeDisclosure(promotionDisclosure(persisted), persisted),
          durationMs: Date.now() - t0,
          flowFile: action.filePath,
          firstAttemptOutput: boundedOutput(firstOutput),
        });
      }

      // ─── First attempt failed — classify ─────────────────────────────
      const failure =
        firstTypedSelectorFailure ??
        parseMaestroFailure(firstOutput, readMaestroTerminal(firstEnv));

      // GH #623: ledger-proven trailing verification. The failing-step kind is
      // preserved; the qualifier only changes repair/guidance behavior. The
      // final goal state stays UNPROVEN — this is still passed:false.
      const firstTrailingVerification = readTrailingVerification(firstEnv, {
        attemptId: initialAttemptId,
        ordinal: 1,
        kind: 'initial',
      });
      if (firstTrailingVerification) {
        const firstRuntimeDegradation = readRuntimeDegradation(firstEnv);
        // Auto-repair REFUSES (contract): rewriting a merely-slow selector is
        // the harm this path exists to prevent. The true cause lives in the
        // adjacent qualifier block; no new refusal code is introduced.
        const autoRepair: AutoRepairOutcome = {
          attempted: false,
          outcome: 'refused',
          refusedReason: autoRepairEnabled ? 'NOT_REPAIRABLE_KIND' : 'USER_DISABLED',
          phases: { firstAttemptMs },
        };
        const { actionCode, toolCode } = classifyFailure(failure);
        const persisted = await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: actionCode,
          failureDetail: firstFailureDetail.slice(0, 1000),
          trigger,
          autoRepair,
          trailingVerification: firstTrailingVerification,
        });
        const anchor =
          'selector' in failure && failure.selector
            ? ` ("${failure.selector}")`
            : readMaestroTerminal(firstEnv)?.failedStep
              ? ` ("${readMaestroTerminal(firstEnv)?.failedStep}")`
              : '';
        const baseMessage =
          `cdp_run_action: ${args.actionId} failed (${failure.kind}) — trailing verification only: ` +
          `the run ledger proves every authored mutating command completed ` +
          `(${firstTrailingVerification.provenMutations} mutations), and only the final wait/assert${anchor} ` +
          `did not verify within its deadline. The goal state is UNPROVEN — the app may have reached it ` +
          `after the wait gave up. Verify the live state (device_screenshot, cdp_navigation_state, ` +
          `expect_visible_by_testid) before re-running. Auto-repair skipped: the selector may be ` +
          `merely slow, not stale.`;
        const message = firstRuntimeDegradation
          ? `${baseMessage} — ${formatRuntimeSlowCaveat(firstRuntimeDegradation)}`
          : baseMessage;
        const meta = {
          actionId: args.actionId,
          failureKind: failure.kind,
          ...('selector' in failure && failure.selector
            ? { failureSelector: failure.selector }
            : {}),
          underlyingFailure: firstFailureDetail,
          trailingVerification: firstTrailingVerification,
          ...(firstRuntimeDegradation
            ? { runtimeDegraded: runtimeDegradationMetadata(firstRuntimeDegradation) }
            : {}),
          autoRepair,
          writes: writeDisclosure('none', persisted),
          firstAttemptOutput: boundedOutput(firstOutput),
          terminal: readMaestroTerminal(firstEnv),
          runnerResume: (firstEnv.meta as { runnerResume?: unknown } | undefined)?.runnerResume,
          ...strictRunRecordMeta(persisted),
        };
        return toolCode ? failResult(message, toolCode, meta) : failResult(message, meta);
      }

      // GH #186: structural route-drift takes precedence over selector repair.
      // If the action recorded an expected route sequence and the LIVE route is
      // off it, an unexpected screen appeared (e.g. an inserted CouponCode) — a
      // fuzzy selector repair would be wrong, so reclassify as ROUTE_DRIFT and
      // skip repair. Live route is fetched within a bounded budget (best-effort;
      // the default fetcher is a no-op until index.ts wires a CDP-backed one).
      const expectedSeq = action.metadata.expectedRouteSequence;
      if (failure.kind === 'SELECTOR_NOT_FOUND' && expectedSeq && expectedSeq.length > 0) {
        const bundleAuthorityClaimed = await claimBundleAuthority(args);
        const routeCorpusRefusal = replayCorpusIdentityRefusal(
          loadContext,
          args.actionId,
          runtimeStatePath ? { writes: writeDisclosure() } : undefined,
        );
        if (routeCorpusRefusal) return routeCorpusRefusal;
        const liveRoute = bundleAuthorityClaimed ? await getLiveRoute().catch(() => null) : null;
        const drift = classifyRouteDriftAfterFailure({ expectedSequence: expectedSeq, liveRoute });
        if (drift.isDrift) {
          const autoRepair: AutoRepairOutcome = {
            attempted: false,
            outcome: 'refused',
            refusedReason: 'ROUTE_DRIFT',
            phases: { firstAttemptMs },
          };
          const persisted = await persistRunWithDevice({
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
              writes: writeDisclosure('none', persisted),
            },
          );
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
        const persisted = await persistRunWithDevice({
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
          // GH #580: the selector belongs in the envelope structurally, not only
          // inside the human headline the caller would have to re-parse.
          ...('selector' in failure && failure.selector
            ? { failureSelector: failure.selector }
            : {}),
          underlyingFailure: firstFailureDetail,
          autoRepair,
          writes: writeDisclosure('none', persisted),
          firstAttemptOutput: boundedOutput(firstOutput),
          terminal: readMaestroTerminal(firstEnv),
          runnerResume: (firstEnv.meta as { runnerResume?: unknown } | undefined)?.runnerResume,
          ...strictRunRecordMeta(persisted),
        };
        const cacheProvisionRefusal =
          failure.kind === 'WDA_BOOTSTRAP_FAILED' &&
          firstFailureDetail.includes('RUNNER_CACHE_UNAVAILABLE');
        let message = cacheProvisionRefusal
          ? `cdp_run_action: ${args.actionId} failed (WDA_BOOTSTRAP_FAILED) before the first replay step: ${firstFailureDetail}`
          : failure.kind === 'WDA_BOOTSTRAP_FAILED'
            ? `cdp_run_action: ${args.actionId} failed (WDA_BOOTSTRAP_FAILED) before the first replay step: ${failure.detail}. Re-run the replay (bootstrap retries itself); check network access; diagnose the pin-cache runner with ${PINNED_RUNNER_DIAGNOSE_HINT}. Supported correction: ${PINNED_RUNNER_INSTALL_HINT}. Never invoke PATH, ~/.maestro-runner, maestro-cli, or manual login. No preparation or cache mutation was attempted.`
            : `cdp_run_action: ${args.actionId} failed (${failure.kind})${autoRepairEnabled ? ' — failure not auto-repairable' : ' — auto-repair disabled'}: ${firstFailureDetail}`;
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
      const repairResult = await measureStep('selector-repair', () =>
        repairAction({
          actionId: args.actionId,
          failedSelector: failure.selector,
          projectRoot,
          agentReasoning: `auto-repair from cdp_run_action after maestro failure: ${failure.selector}`,
        }),
      );
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
        const persisted = await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: 'SELECTOR_NOT_FOUND',
          // GH #580: the structured detail carries kind + selector; the bounded
          // stdout slice can lose the failing line to later runner narration.
          failureDetail: firstFailureDetail.slice(0, 1000),
          trigger,
          autoRepair,
        });
        return failResult(
          `cdp_run_action: ${args.actionId} failed with SELECTOR_NOT_FOUND (${failure.selector}); auto-repair refused (${refusedReason}): ${repairEnv.error ?? 'unknown'}`,
          'TESTID_NOT_FOUND',
          {
            actionId: args.actionId,
            failureKind: failure.kind,
            failureSelector: failure.selector,
            underlyingFailure: firstFailureDetail,
            terminal: readMaestroTerminal(firstEnv),
            autoRepair,
            writes: writeDisclosure('none', persisted),
            repairError: repairEnv.error,
            firstAttemptOutput: boundedOutput(firstOutput),
          },
        );
      }

      // ─── Repair succeeded — replay once ──────────────────────────────
      const repairData = repairEnv.data as {
        oldSelector: string;
        newSelector: string;
        sidecarPath?: unknown;
      };
      if (typeof repairData.sidecarPath === 'string' && repairData.sidecarPath.length > 0) {
        runtimeStatePath = repairData.sidecarPath;
      }
      actionYamlWrite = 'auto-repair';

      // The repair updated the action on disk. Re-load to pick up the
      // new body + bumped revision/state — saveAction's atomic pair-write
      // means we can read it back deterministically.
      loadContext = refreshActionLoadContext(loadContext, args.actionId);
      const reloadedAction = loadActionFromContext(loadContext, args.actionId);
      if (!reloadedAction) {
        // Shouldn't happen — repair just wrote it. Defensive surface.
        // Persist the failure RunRecord so MTTR sees the outcome.
        const persisted = await persistRunWithDevice({
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
          {
            actionId: args.actionId,
            writes: writeDisclosure('none', persisted),
          },
        );
      }
      if (!reloadedAction.replay.ok) {
        return failResult(
          `cdp_run_action: repaired action is not valid Maestro YAML: ${reloadedAction.replay.error}`,
          'BAD_RECORDING',
          {
            actionId: args.actionId,
            writes: writeDisclosure('auto-repair'),
          },
        );
      }
      const retryYaml = reloadedAction.replay.yamlText;

      const tBeforeRetry = Date.now();
      probeDeviceId = null;
      const retryCorpusRefusal = replayCorpusIdentityRefusal(loadContext, args.actionId, {
        writes: writeDisclosure('auto-repair'),
      });
      if (retryCorpusRefusal) return retryCorpusRefusal;
      const repairedAttemptId = randomUUID();
      const retryResult = await measureStep('maestro-retry', () =>
        maestroRun({
          inlineYaml: retryYaml,
          actionMetadata: reloadedAction.metadata,
          platform: args.platform,
          appId: args.appId,
          ...(appFile ? { appFile } : {}),
          deviceId: maestroDeviceId,
          timeoutMs,
          params: args.params,
          attempt: {
            attemptId: repairedAttemptId,
            ordinal: 2,
            maxAttempts,
            kind: 'repaired',
            parentAttemptId: initialAttemptId,
          },
          claimNativeOrigin: () => claimNativeOrigin(args),
          completeNativeOrigin: (targetExpected, signal) =>
            completeNativeOrigin(args, targetExpected, signal),
          relaunchManagedApp: (stopApp) => relaunchManagedApp(args, stopApp),
          reproveManagedOrigin: (options) => reproveManagedOrigin(args, options),
          completeRunnerPark: (signal) => completeManagedRunnerParkAuthority(args, signal),
          reissueInstallReceipt: () => reissueInstallReceipt(args),
        }),
      );
      const retryMs = Date.now() - tBeforeRetry;
      const retryEnv = parseEnvelope(retryResult, 'maestro_run');
      const retryPassed = retryEnv.ok === true && retryEnv.data?.passed === true;
      const retryOutput = readMaestroOutput(retryEnv);
      const retryFailureDetail = readMaestroFailureDetail(retryEnv, retryOutput);
      const retryTerminal = readMaestroTerminal(retryEnv);
      const retryTypedSelectorFailure = typedReactSelectorFailure(retryEnv, retryOutput);
      const retryFailure = !retryPassed
        ? (retryTypedSelectorFailure ?? parseMaestroFailure(retryOutput, retryTerminal))
        : undefined;
      const retryClassification = retryFailure ? classifyFailure(retryFailure) : undefined;
      const retryDeviceAuthority = readMaestroDeviceAuthority(retryEnv);
      probeDeviceId = retryDeviceAuthority?.reportedDeviceId ?? observedDeviceId;

      if (retryEnv.code && !retryTypedSelectorFailure) {
        const typedCode = retryEnv.code;
        const autoRepair: AutoRepairOutcome = {
          attempted: true,
          outcome: 'failed',
          phases: { firstAttemptMs, repairMs, retryMs },
        };
        const persisted = await persistRunWithDevice({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: 'fail',
          failureCode: actionFailureCodeForToolCode(typedCode),
          failureDetail: retryFailureDetail.slice(0, 1000),
          trigger,
          autoRepair,
        });
        return failResult(
          `cdp_run_action: ${args.actionId} retry failed: ${retryFailureDetail}`,
          typedCode,
          {
            ...retryEnv.meta,
            actionId: args.actionId,
            failureKind: typedCode,
            deviceAuthority: retryDeviceAuthority,
            autoRepair,
            writes: writeDisclosure('auto-repair', persisted),
          },
        );
      }

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
      if (
        retryFailure?.kind === 'SELECTOR_NOT_FOUND' &&
        retryFailure.selector &&
        retryFailure.selector !== repairData.newSelector
      ) {
        nextFailedSelector = retryFailure.selector;
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

      const retryTrailingVerification = retryPassed
        ? undefined
        : readTrailingVerification(retryEnv, {
            attemptId: repairedAttemptId,
            ordinal: 2,
            kind: 'repaired',
            parentAttemptId: initialAttemptId,
          });
      const retryRuntimeDegradation = retryTrailingVerification
        ? readRuntimeDegradation(retryEnv)
        : undefined;
      const persisted = await persistRunWithDevice({
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
        status: retryPassed ? 'pass' : 'fail',
        failureCode: retryClassification?.actionCode,
        failureDetail: retryPassed ? undefined : retryFailureDetail.slice(0, 1000),
        trigger,
        autoRepair,
        ...(retryTrailingVerification ? { trailingVerification: retryTrailingVerification } : {}),
        ...(retryPassed && retryEnv.data?.transport === 'cdp-js'
          ? { transport: 'cdp-js' as const }
          : {}),
        ...(retryPassed && retryEnv.data?.proofDomain
          ? { proofDomain: retryEnv.data.proofDomain }
          : {}),
      });

      if (retryPassed) {
        return okResult({
          passed: true,
          actionId: args.actionId,
          ...replaySuccessEvidence(retryEnv),
          repair: autoRepair,
          autoRepair,
          writes: writeDisclosure('auto-repair', persisted),
          durationMs: Date.now() - t0,
          flowFile: reloadedAction.filePath,
          retriedAfterRepair: true,
          retryOutput: boundedOutput(retryOutput),
        });
      }

      const retryBaseMessage = retryTrailingVerification
        ? `cdp_run_action: ${args.actionId} failed after auto-repair (${repairData.oldSelector} → ${repairData.newSelector}) — trailing verification only: the run ledger proves every authored mutating command completed (${retryTrailingVerification.provenMutations} mutations); only the final wait/assert did not verify within its deadline. The goal state is UNPROVEN — verify the live state before re-running.`
        : `cdp_run_action: ${args.actionId} still failing after auto-repair (${repairData.oldSelector} → ${repairData.newSelector}): ${retryFailureDetail}`;
      const retryMessage = retryRuntimeDegradation
        ? `${retryBaseMessage} — ${formatRuntimeSlowCaveat(retryRuntimeDegradation)}`
        : retryBaseMessage;
      const retryMeta = {
        actionId: args.actionId,
        ...(retryTrailingVerification ? { trailingVerification: retryTrailingVerification } : {}),
        ...(retryRuntimeDegradation
          ? { runtimeDegraded: runtimeDegradationMetadata(retryRuntimeDegradation) }
          : {}),
        autoRepair,
        writes: writeDisclosure('auto-repair', persisted),
        firstAttemptOutput: boundedOutput(firstOutput),
        retryOutput: boundedOutput(retryOutput),
        underlyingFailure: retryFailureDetail,
        ...(retryFailure ? { failureKind: retryFailure.kind } : {}),
        ...(retryFailure && 'selector' in retryFailure && retryFailure.selector
          ? { failureSelector: retryFailure.selector }
          : {}),
        terminal: retryTerminal,
      };
      return retryClassification?.toolCode
        ? failResult(retryMessage, retryClassification.toolCode, retryMeta)
        : failResult(retryMessage, retryMeta);
    } catch (err) {
      if (err instanceof SessionAuthorityError) {
        if (runtimeStatePath) {
          err.attachMeta({ writes: writeDisclosure(actionYamlWrite) });
        }
        throw err;
      }
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
      let persisted: PersistRunOutcome | undefined;
      try {
        persisted = await persistRunWithDevice({
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
        {
          actionId: args.actionId,
          autoRepair,
          internalError: msg.slice(0, 500),
          ...(persisted || runtimeStatePath ? { writes: writeDisclosure('none', persisted) } : {}),
        },
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
  promotionRefused: boolean;
  runtimeStateRefused?: boolean;
  runtimeStatePath?: string;
  persistedRunId?: string;
}

type WriteDisclosureKind =
  | 'none'
  | 'auto-repair'
  | 'lifecycle-promotion'
  | 'lifecycle-promotion-refused';

/**
 * A refused promotion must not read like a run that had nothing to promote —
 * the action stays `experimental` and the operator needs to see why.
 */
function promotionDisclosure(outcome: PersistRunOutcome): WriteDisclosureKind {
  if (outcome.promoted) return 'lifecycle-promotion';
  return outcome.promotionRefused ? 'lifecycle-promotion-refused' : 'none';
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
      return { promoted: false, promotionRefused: false };
    }
    const nextState = appendRunRecord(fresh.state, record);
    const promotes = shouldAutoPromoteToActive(fresh.metadata, record);
    // Runtime telemetry is sidecar-only. A replay that did not apply repair
    // must preserve tracked YAML bytes (including documentation comments).
    const commit = (
      runtimeStatePath: string,
      promoted: boolean,
      promotionRefused: boolean,
    ): PersistRunOutcome => {
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
      return { promoted, promotionRefused, runtimeStatePath, persistedRunId: record.runId };
    };
    // A promotion refusal is deterministic (externally edited YAML, or a missing
    // `# status: experimental` marker) — retrying cannot clear it, so degrade to
    // the sidecar-only append instead of failing an otherwise successful replay.
    const promotion = promotes ? promoteActionRuntimeWithCAS(fresh, nextState) : null;
    const promotionRefused = promotion?.ok === false;
    if (promotion?.ok) return commit(promotion.sidecarPath, true, false);
    const runtimeWrite = saveActionRuntimeWithCAS(fresh, nextState);
    if (runtimeWrite.ok) return commit(runtimeWrite.sidecarPath, false, promotionRefused);
    // Sidecar CAS conflict — another writer raced us. Reload and retry.
    // Exhausting the retries is NOT necessarily a race: a truncated or foreign
    // sidecar is refused deterministically while loadOrInitSidecar keeps
    // handing back a fresh state, so reload+retry can never converge. Degrade
    // with disclosure like the promotion path rather than converting an
    // otherwise-successful replay into an orchestration exception.
    if (attempt === MAX_ATTEMPTS) {
      console.error(
        `cdp_run_action: persistRun for "${actionId}" hit ${MAX_ATTEMPTS} sidecar CAS conflicts; ` +
          `runtime state was not written (status=${record.status}).`,
      );
      return { promoted: false, promotionRefused, runtimeStateRefused: true };
    }
  }
  return { promoted: false, promotionRefused: false };
}
