import './env-setup.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  CDPClient,
  type AuthoritativeSessionPolicy,
  type AwaitWithinBoundary,
} from './cdp-client.js';
import { okResult, failResult, withConnection } from './utils.js';
import { annotateMutationAbsence } from './verification/mutation-absence.js';
import { loadVerificationConfig, getCachedProjectRoot } from './verification/config.js';
import { logger } from './logger.js';
import { createPassiveStatusHandler, targetMatchesSession } from './tools/status.js';
import { createEvaluateHandler } from './tools/evaluate.js';
import { createReloadHandler } from './tools/reload.js';
import { createComponentTreeHandler } from './tools/component-tree.js';
import { createNavigationStateHandler, readLiveRoute } from './tools/navigation-state.js';
import { createErrorLogHandler } from './tools/error-log.js';
import { createNativeErrorsHandler } from './tools/native-errors.js';
import { createNetworkLogHandler } from './tools/network-log.js';
import { createWaitForNetworkHandler } from './tools/wait-for-network.js';
import { createNetworkBodyHandler } from './tools/network-body.js';
import { createHeapUsageHandler, createCpuProfileHandler } from './tools/profiling.js';
import { createObjectInspectHandler } from './tools/object-inspect.js';
import { createExceptionBreakpointHandler } from './tools/exception-breakpoint.js';
import { createConsoleLogHandler } from './tools/console-log.js';
import { createStoreStateHandler } from './tools/store-state.js';
import { createDiagnosticRenderersHandler } from './tools/diagnostic-renderers.js';
import {
  createExpectReduxHandler,
  createExpectRouteHandler,
  createExpectVisibleByTestIDHandler,
  createExpectTextHandler,
} from './tools/macro-asserts.js';
import { createRepairActionHandler } from './tools/repair-action.js';
import { createSaveAsActionHandler } from './tools/save-as-action.js';
import { createRunActionHandler } from './tools/run-action.js';
import { createLoginPrologueHandler } from './tools/login-prologue.js';
import { replayTreeData, unwrapTree } from './tools/cdp-replay-dispatch.js';
import type { CdpReplayDeps } from './tools/cdp-replay-dispatch.js';
import { ReplayDispatchError } from './domain/cdp-flow-replay.js';
import { createDispatchHandler } from './tools/dispatch.js';
import { createMmkvHandler } from './tools/mmkv.js';
import { createDevSettingsHandler } from './tools/dev-settings.js';
import { createForegroundSurfaceProbe } from './tools/expo-dev-menu.js';
import { createInteractHandler } from './tools/interact.js';
import { createCollectLogsHandler } from './tools/collect-logs.js';
import { createDeviceListHandler, createDeviceScreenshotHandler } from './tools/device-list.js';
import { createDeviceSnapshotHandler } from './tools/device-session.js';
import { releaseDeviceLockForSession } from './tools/device-session.js';
import { createSessionRuntimeAbsenceProbe } from './session/session-runtime-absence.js';
import {
  createDeviceFindHandler,
  fetchSnapshotNodesForSameScreenProof,
  createDevicePressHandler,
  createDeviceFillHandler,
  performReactTreeInput,
  createDeviceSwipeHandler,
  createDeviceScrollHandler,
  createDeviceScrollIntoViewHandler,
  createDeviceLongPressHandler,
  createDevicePinchHandler,
  createDeviceBackHandler,
  createDeviceFocusNextHandler,
} from './tools/device-interact.js';
import { getIosRuntimeMajorForUdid } from './domain/ios-runtime.js';
import { selectorsVisibleInNativeSnapshot } from './domain/ios-proof-router.js';
import { createDevicePermissionHandler } from './tools/device-permission.js';
import { createDeviceResetStateHandler } from './tools/device-reset-state.js';
import {
  androidDeeplinkCommandArgs,
  createDeviceDeeplinkHandler,
} from './tools/device-deeplink.js';
import { createDismissDevClientPickerHandler } from './tools/dev-client-picker.js';
import { createDeviceRecordHandler } from './tools/device-record.js';
import {
  createProofCaptureHandler,
  proofRootHasTrackedEntries,
  proofCapturePublishedInputSchema,
  readProofActionIdentity,
  readProofGitInfo,
  resolveProofIdentity,
  resolveProofWorktreeRoot,
  writeProofReceiptAtomic,
  type ProofReadiness,
} from './tools/proof-capture.js';
import { validateMedia } from './tools/proof-media.js';
import { proofRuntimeAuthorityMarker } from './domain/proof-capture.js';
import {
  acceptDeeplinkOpenConfirmation,
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
} from './tools/device-system-dialog.js';
import {
  createDevicePickValueHandler,
  createDevicePickDateHandler,
} from './tools/device-picker.js';
import { createNavGraphHandler } from './tools/nav-graph.js';
import { createDeviceBatchHandler } from './tools/device-batch.js';
import { autoLoginToolResult, handleAutoLogin } from './tools/auto-login.js';
import { createProofStepHandler } from './tools/proof-step.js';
import { createDisconnectHandler, createTargetsHandler } from './tools/connection.js';
import { createRestartHandler } from './tools/restart.js';
import { buildGracefulShutdown } from './lifecycle/graceful-shutdown.js';
import { Lockfile, formatLockConflictMessage } from './lifecycle/lockfile.js';
import { startParentDeathWatch } from './lifecycle/parent-watch.js';
import { arbiterWrap, arbiter } from './lifecycle/device-arbiter.js';
import { setForeignGateUdidProvider, foreignFlowGate } from './lifecycle/foreign-flow-gate.js';
import {
  getActiveSession,
  getSnapshotCaptureCheckpoint,
  markSnapshotDirty,
  promoteSnapshotOriginSince,
  runNative,
  setSnapshotAuthorityProvider,
  validateCachedSnapshotEvidenceAuthority,
} from './agent-device-wrapper.js';
import { createMaestroRunHandler, type MaestroRunDeps } from './tools/maestro-run.js';
import { createMaestroGenerateHandler } from './tools/maestro-generate.js';
import { createMaestroTestAllHandler } from './tools/maestro-test-all.js';
import {
  createRecordTestStartHandler,
  createRecordTestStopHandler,
  createRecordTestGenerateHandler,
  createRecordTestAnnotateHandler,
  createRecordTestSaveHandler,
  createRecordTestLoadHandler,
  createRecordTestListHandler,
} from './tools/test-recorder.js';
import { createCrossPlatformVerifyHandler } from './tools/cross-platform-verify.js';
import { createOpenDevToolsHandler } from './tools/open-devtools.js';
import { createMetroEventsHandler } from './tools/metro-events.js';
import {
  clearFastRunnerAfterVerifiedStop,
  probeFastRunnerAuthority,
  resetRunnerRebuildBudgetForCurrentPlugin,
  stopFastRunner,
} from './runners/rn-fast-runner-client.js';
import {
  androidHealthMatchesAuthority,
  probeAndroidRunnerHealthInfo,
} from './runners/rn-android-runner-client.js';
import {
  captureInstalledArtifact,
  captureInstallGeneration,
  verifyInstalledArtifact,
} from './session/install-authority.js';
import { readProcessBirth } from './session/process-birth.js';
import { ensureSingleRunner } from './runners/ensure-single-runner.js';
import { addToolObserver, instrumentTool } from './observability/instrumentation.js';
import { discoverPluginVersion, ExperienceRecorder } from './experience/evidence.js';
import { recorder } from './observability/recorder.js';
import { hashProofValue, StrictProofMonitor } from './domain/proof-capture.js';
import type { ProofAuthority } from './domain/proof-receipt.js';
import {
  maybeCaptureLiveFrame,
  isStateMutating,
  mayTriggerLiveCapture,
  resolveSnapshotInvalidationPlatform,
  toolInvalidatesSnapshotCache,
  toolInvalidatesRetryBaseline,
  buildLiveDeps,
} from './observability/live-device.js';
import { invalidateLastSnapshotHash } from './fast-runner-ref-map.js';
import { tryRawScreenshot } from './tools/device-screenshot-raw.js';
import {
  observeHandler,
  observeSchema,
  setObserveE2eDeps,
  setObserveAuthorityDeps,
  setObserveMirror,
  setObserveStateDeps,
  startObserveServer,
} from './tools/observe.js';
import { buildStateRead } from './observability/state-read.js';
import { autostartObserve } from './observability/autostart.js';
import { removeObserveState } from './observability/observe-state.js';
import { resolveObserveAutostart, resolveMirrorConfig } from './project-config.js';
import { MirrorManager } from './observability/mirror/manager.js';
import { buildMirrorTargetResolver } from './observability/mirror/target.js';
import {
  createMirrorSource,
  IosSimctlLoopSource,
  idbDemotionHint,
} from './observability/mirror/sources.js';
import { parseAllAdbDevices } from './tools/device-record.js';
import { createLockE2eTestHandler } from './tools/lock-e2e-test.js';
import { createRunE2eSuiteHandler, type RunE2eSuiteArgs } from './tools/run-e2e-suite.js';
import { resolveLockedTestSelection } from './domain/e2e-test.js';
import { recoverInterruptedRequests } from './domain/e2e-run-request.js';
import { preflight, probeMetro } from './e2e/preflight.js';
import { resolveIosUdid } from './tools/device-screenshot-raw.js';
import { probeAppInstalled } from './cdp/app-installed-probe.js';
import {
  collectMatchingRnProjects,
  findProjectRoot,
  isRnProject,
  readProjectBundleId,
} from './nav-graph/storage.js';
import { makeCsrfToken } from './observability/e2e-csrf.js';
import {
  createObserveRootResolver,
  ObserveRootUnavailableError,
} from './observability/observe-project-root.js';
import { loadIndex, loadRunRecord } from './domain/e2e-run.js';
import { listActions } from './domain/action-inventory.js';
import { loadAction } from './domain/action-store.js';
import { loadE2eConfig, resolveParams } from './domain/e2e-config.js';
import { getWorkerAuthorityRuntime } from './session/runtime.js';
import { createSessionHandler } from './tools/session.js';
import {
  ensureAndroidMetroReverse,
  removeAndroidMetroReverse,
} from './session/android-metro-reverse.js';
import { bindNativeRunner, unbindNativeRunner } from './session/runner-binding.js';
import {
  claimOptionalBundleAuthority,
  createAuthorityGate,
  type ManagedNativeOriginReproveOptions,
  type StagedRuntimeRelaunch,
} from './session/authority-gate.js';
import { createLocalAuthorityProbe } from './session/local-authority-probe.js';
import { createForeignMetroOriginScanner } from './session/metro-origin.js';
import {
  DISCOVERY_TIMEOUT_MS,
  discoverAllMetroPorts,
  resolveDefaultPorts,
  mapRegistryDeviceBinding,
  setRegistryDeviceBindingProvider,
} from './cdp/discovery.js';
import { assertAuthorityProfilesExhaustive } from './session/tool-profiles.js';
import { readJsonStateFile } from './util/secure-state-file.js';
import {
  buildBundleAuthorityBinding,
  pinExactDevClient,
  reconcileAuthoritativeBundle,
  type BundleAuthorityBinding,
  type BundleAuthorityPromotion,
} from './session/dev-client-authority.js';
import { createRegisteredConnectHandler } from './session/registered-connect.js';
import {
  verifyMetroAuthorityMarker,
  type MetroAuthorityMarker,
} from './session/metro-authority.js';
import {
  filterTargetsForExactDevice,
  proveTargetDeviceAssociation,
} from './session/target-device-authority.js';
import {
  connectExactSessionTarget as connectExactSessionTargetWithDependencies,
  exactCandidateMismatchError,
  exactSessionTargetReadinessTimeoutMs,
  type ExactSessionTargetConnection,
} from './session/connect-exact-session-target.js';
import type { SessionStatus } from './session/registry.js';
import { strictProofSourceIdentity, type SourceIdentity } from './session/source-identity.js';
import { verifyManagedMetroManagementProof } from './session/managed-metro.js';
import { stopBoundRunner } from './session/process-cleanup.js';
import {
  recoverAuthoritativeRuntimeConnection,
  withRecoveredAuthoritativeRuntime,
} from './session/runtime-connection-recovery.js';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkgVersion = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

// M3 / Phase 90: single-instance lock. Must run BEFORE telemetry prune / CDPClient creation
// so two racing MCPs don't corrupt telemetry files or fight for the CDP slot. --no-lock
// opt-out exists for CI parallelism and benchmark harnesses; documented in the conflict
// message. Release is registered on process.exit so ALL exit paths (graceful, uncaught,
// signal) clean up the lock.
// GH #182: module-scoped so the parent-death watch can touch() it (heartbeat) and
// release() it on orphan-exit. null when --no-lock (touch/release become no-ops).
let lockfile: Lockfile | null = null;
const diagnosticContractProbe = process.argv.includes('--diagnostic-contract-probe');
const noLock = diagnosticContractProbe || process.argv.includes('--no-lock');
if (!noLock) {
  lockfile = new Lockfile({ version: pkgVersion });
  const lockResult = lockfile.acquire();
  if (lockResult.status === 'conflict') {
    process.stderr.write(formatLockConflictMessage(lockResult) + '\n');
    process.exit(11);
  }
  process.on('exit', () => lockfile?.release());
}
if (!diagnosticContractProbe) {
  process.on('exit', () => {
    try {
      releaseDeviceLockForSession();
    } catch {
      /* never fail exit */
    }
  });
}

// GH#202 Phase 1: at boot the simulator UDID is unknown, so only the
// files-only pass runs — remove orphaned ~/.agent-device/daemon.{json,lock}
// when their daemon PID is dead. Never touches a live process at startup.
// Default-on; opt out with RN_DEVICE_KILL_LEGACY=0.
if (!diagnosticContractProbe && process.env.RN_DEVICE_KILL_LEGACY !== '0') {
  void ensureSingleRunner()
    .then((r) => {
      if (r.removedFiles.length) {
        logger.info('rn-device', `ensureSingleRunner(boot): removed ${r.removedFiles.join(', ')}`);
      }
    })
    .catch(() => {
      /* non-fatal */
    });
}

let client: CDPClient;

const getClient = (): CDPClient => client;
const configureClientLifecycle = (candidate: CDPClient): CDPClient => {
  candidate.setLifecycleAuthority(() => getClient() === candidate);
  return candidate;
};
const setClient = (candidate: CDPClient): void => {
  client = candidate;
};
const publishClient = (expected: CDPClient, replacement: CDPClient): boolean => {
  if (client !== expected) return false;
  client = replacement;
  return true;
};
client = configureClientLifecycle(new CDPClient());
const createClient = (port: number): CDPClient => {
  const status = authorityRuntime.status();
  return configureClientLifecycle(
    status.available && status.bindings.bundle
      ? client.createReplacement(port)
      : new CDPClient(port),
  );
};

const execFileP = promisify(execFile);

// Parse an MCP envelope; throw when the handler reported failure.
const mustOk = (res: { content: { text: string }[] }, what: string): void => {
  const env = JSON.parse(res.content[0].text) as {
    ok?: boolean;
    code?: string;
    error?: string;
    meta?: Record<string, unknown>;
  };
  if (env.ok === false)
    throw new ReplayDispatchError(
      env.code ?? 'INTERACTION_NOT_ACTUATED',
      `${what} failed: ${env.error ?? 'ok:false'}`,
      env.meta,
    );
};

// Build exact-iOS React-tree replay dependencies from existing handlers.
const makeReplayDeps = (_args?: unknown, signal?: AbortSignal): CdpReplayDeps | null => {
  const session = getActiveSession();
  if (!session || session.platform !== 'ios' || !session.appId) return null;
  const interact = createInteractHandler(getClient);
  const tree = createComponentTreeHandler(getClient);
  return {
    pressByTestId: async (id: string) => {
      mustOk(await interact({ action: 'press', testID: id, animated: false }), `press "${id}"`);
    },
    typeByTestId: async (id: string, text: string) => {
      mustOk(await performReactTreeInput(id, text, getClient(), signal), `type "${id}"`);
    },
    treeFor: async (id: string) => {
      const fetchTree = async (interactiveOnly: boolean) =>
        JSON.parse(
          (
            await tree({
              filter: id,
              depth: 12,
              ...(interactiveOnly ? { interactiveOnly: true } : {}),
            })
          ).content[0].text,
        ) as {
          ok?: boolean;
          code?: string;
          error?: string;
          data?: unknown;
          meta?: Record<string, unknown>;
        };
      let env = await fetchTree(false);
      let data = replayTreeData(env);
      // Retry with the salient digest when the full filtered payload exceeds the helper bound.
      const d = data as Record<string, unknown> | null;
      if (d && typeof d === 'object' && '__agent_truncated' in d) {
        env = await fetchTree(true);
        data = replayTreeData(env);
      }
      return unwrapTree(data);
    },
    frontmostFor: async (id: string) => {
      const result = await getClient().evaluate(
        getClient().bridgeWithFallback(`isTestIdFrontmost(${JSON.stringify(id)})`),
      );
      if (result.error || typeof result.value !== 'string') {
        return {
          visible: false,
          reason: `frontmost route check failed for testID "${id}"`,
          code: 'ASSERTION_FAILED',
        };
      }
      try {
        const parsed = JSON.parse(result.value) as {
          visible?: boolean;
          reason?: string;
          matchCount?: number;
          code?: string;
        };
        return {
          visible: parsed.visible === true,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          ...(typeof parsed.matchCount === 'number' ? { matchCount: parsed.matchCount } : {}),
          ...(parsed.code ? { code: parsed.code } : {}),
        };
      } catch {
        return {
          visible: false,
          reason: `frontmost route check was unreadable for testID "${id}"`,
          code: 'ASSERTION_FAILED',
        };
      }
    },
    launchApp: async (stopApp: boolean) => {
      const udid = await resolveIosUdid(session.deviceId);
      if (!udid) throw new Error('launchApp: could not resolve iOS udid');
      if (stopApp) {
        try {
          await execFileP('xcrun', ['simctl', 'terminate', udid, session.appId!]);
        } catch {
          /* app not running — fine */
        }
      }
      await execFileP('xcrun', ['simctl', 'launch', udid, session.appId!]);
    },
    settle: async (timeoutMs: number) => {
      if (signal?.aborted) throw new ReplayDispatchError('RUNNER_TIMEOUT', 'Replay cancelled');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, timeoutMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new ReplayDispatchError('RUNNER_TIMEOUT', 'Replay cancelled'));
          },
          { once: true },
        );
      });
    },
  };
};

const probeNativeVision: NonNullable<MaestroRunDeps['nativeVisionProbe']> = async ({
  deviceId,
  selectors,
  signal,
}) => {
  signal.throwIfAborted();
  const snapshot = await fetchSnapshotNodesForSameScreenProof();
  signal.throwIfAborted();
  if (!snapshot.ok || snapshot.recoveredTier) return null;
  const visibleSelectors = selectorsVisibleInNativeSnapshot(selectors, snapshot.nodes);
  return {
    source: 'rn-fast-runner-snapshot',
    nodeCount: snapshot.nodes.length,
    visibleSelectors,
    runtimeMajor: await getIosRuntimeMajorForUdid(deviceId),
  };
};

const server = new McpServer({
  name: 'rn-dev-agent-cdp-bridge',
  version: pkgVersion,
});

export const strictProofMonitor = new StrictProofMonitor();
const experienceRecorder = new ExperienceRecorder({
  coreVersion: pkgVersion,
  pluginVersion: discoverPluginVersion(),
});
addToolObserver((o) => recorder.record(o));
addToolObserver((o) => strictProofMonitor.record(o));
addToolObserver((o) => experienceRecorder.observe(o));

const authorityRuntime = getWorkerAuthorityRuntime();
const probeForegroundSurface = createForegroundSurfaceProbe({
  getAuthorityStatus: () => authorityRuntime.status(),
  getActiveSession,
  runNative,
});
setRegistryDeviceBindingProvider(() =>
  mapRegistryDeviceBinding(authorityRuntime.status(), authorityRuntime.available),
);
setSnapshotAuthorityProvider({
  current: () => {
    const status = authorityRuntime.status();
    if (!status.available) return null;
    const device = status.bindings.device as Record<string, unknown> | undefined;
    const install = status.bindings.install as Record<string, unknown> | undefined;
    const runner = status.bindings.runner as Record<string, unknown> | undefined;
    return {
      sessionId: status.sessionId,
      claimEpoch: status.claimEpoch,
      sourceKey: status.sourceKey,
      worktreeKey: status.worktreeKey,
      appRootKey: status.appRootKey,
      platform: device?.platform,
      deviceId: device?.deviceId,
      appId: device?.appId,
      buildGeneration: install?.buildGeneration,
      installGeneration: install?.installGeneration,
      artifactDigest: install?.artifactDigest,
      runnerInstanceId: runner?.instanceId,
      runnerPid: runner?.pid,
      runnerProcessBirth: runner?.processBirth,
      runnerCapabilityHash:
        typeof runner?.capability === 'string'
          ? createHash('sha256').update(runner.capability).digest('hex')
          : undefined,
      runnerPort: runner?.port,
      runnerClaim: status.claims.find((claim) => claim.type === 'runner')?.key,
      deviceClaim: status.claims.find((claim) => claim.type === 'device')?.key,
    };
  },
  record: (receipt) => {
    const { registry, session } = authorityRuntime.requireOperational();
    registry.recordPlatformAuthorityReceipt(session, String(receipt.platform), {
      ...receipt,
    });
  },
  validate: (receipt) => {
    try {
      const { registry, session } = authorityRuntime.requireOperational();
      if (
        !registry.validatePlatformAuthorityReceipt(session, String(receipt.platform), {
          ...receipt,
        })
      ) {
        return false;
      }
      if (
        typeof receipt.platform !== 'string' ||
        typeof receipt.deviceId !== 'string' ||
        typeof receipt.appId !== 'string' ||
        typeof receipt.installGeneration !== 'string' ||
        captureInstallGeneration({
          platform: receipt.platform as 'ios' | 'android',
          deviceId: receipt.deviceId,
          appId: receipt.appId,
        }) !== receipt.installGeneration
      ) {
        return false;
      }
      return (
        typeof receipt.runnerPid === 'number' &&
        typeof receipt.runnerProcessBirth === 'string' &&
        readProcessBirth(receipt.runnerPid)?.token === receipt.runnerProcessBirth
      );
    } catch {
      return false;
    }
  },
  validateEvidence: (receipt) => {
    try {
      const { registry, session } = authorityRuntime.requireOperational();
      if (
        !registry.validatePlatformAuthorityReceipt(session, String(receipt.platform), {
          ...receipt,
        }) ||
        (receipt.platform !== 'ios' && receipt.platform !== 'android') ||
        typeof receipt.deviceId !== 'string' ||
        typeof receipt.appId !== 'string' ||
        typeof receipt.artifactDigest !== 'string' ||
        typeof receipt.installGeneration !== 'string'
      ) {
        return false;
      }
      const observed = captureInstalledArtifact({
        platform: receipt.platform,
        deviceId: receipt.deviceId,
        appId: receipt.appId,
      });
      verifyInstalledArtifact(
        {
          platform: receipt.platform,
          deviceId: receipt.deviceId,
          appId: receipt.appId,
          artifactDigest: receipt.artifactDigest,
          installGeneration: receipt.installGeneration,
        },
        observed,
      );
      return true;
    } catch {
      return false;
    }
  },
  validateLive: async (receipt) => {
    try {
      const { registry, session } = authorityRuntime.requireOperational();
      const probe = registry.getPlatformAuthorityProbe(session, String(receipt.platform), {
        ...receipt,
      });
      if (
        !probe ||
        captureInstallGeneration({
          platform: probe.platform as 'ios' | 'android',
          deviceId: probe.deviceId,
          appId: probe.appId,
        }) !== probe.installGeneration ||
        readProcessBirth(probe.pid)?.token !== probe.processBirth
      ) {
        return false;
      }
      if (probe.platform === 'ios') {
        return probeFastRunnerAuthority(probe);
      }
      if (probe.platform === 'android') {
        const health = await probeAndroidRunnerHealthInfo(probe.port, probe.capability);
        return health.ok === true && androidHealthMatchesAuthority(health, probe);
      }
      return false;
    } catch {
      return false;
    }
  },
  validateOrigin: async (receipt) => {
    try {
      const { registry, session } = authorityRuntime.requireOperational();
      const probe = registry.getPlatformAuthorityProbe(session, String(receipt.platform), {
        ...receipt,
      });
      const status = registry.getSessionStatus(session.sessionId);
      if (!probe || !status || (probe.platform !== 'ios' && probe.platform !== 'android')) {
        return false;
      }
      await localAuthorityProbe({
        axis: 'A',
        phase: 'preflight',
        status: {
          ...status,
          bindings: {
            ...status.bindings,
            device: {
              platform: probe.platform,
              deviceId: probe.deviceId,
              appId: probe.appId,
            },
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  },
});
const foreignMetroOriginScanner = createForeignMetroOriginScanner(
  { execute: (file, args) => execFileP(file, args, { timeout: 5_000 }) },
  {
    listSiblingMetroPorts: async (expectedMetroPort) => {
      let allocated: number[] = [];
      try {
        allocated = authorityRuntime.requireAvailable().registry.allocatedServicePorts('metro');
      } catch {
        // Registry unavailable: fall back to the default discovery ports only.
      }
      const candidates = [...new Set([...allocated, ...resolveDefaultPorts()])].filter(
        (port) => port !== expectedMetroPort,
      );
      return discoverAllMetroPorts(candidates, DISCOVERY_TIMEOUT_MS);
    },
  },
);
const createRuntimeAuthorityProbe = (resolveClient: () => CDPClient) =>
  createLocalAuthorityProbe({
    runtime: authorityRuntime,
    getClient: resolveClient,
    getSecret: () =>
      process.env.RN_DEV_AGENT_SESSION_SECRET_PATH
        ? readJsonStateFile<{
            signerCapability?: string;
            observeCapability?: string;
          }>(process.env.RN_DEV_AGENT_SESSION_SECRET_PATH)
        : null,
    findForeignMetroOrigin: foreignMetroOriginScanner,
    proofActive: (runId) => strictProofMonitor.ownsRun(runId),
  });
const localAuthorityProbe = createRuntimeAuthorityProbe(getClient);
const authorityGate = createAuthorityGate(authorityRuntime, {
  loginSupervisorOverrideToken: () => process.env.RN_LOGIN_PROLOGUE_OVERRIDE_TOKEN,
  resolveLockedE2eTestIds: (args, status) => {
    const projectRoot =
      typeof args.projectRoot === 'string' ? args.projectRoot : status.source.appRoot;
    if (typeof projectRoot !== 'string') return { ids: [], identitiesValid: false };
    args.projectRoot = projectRoot;
    return resolveLockedTestSelection(
      projectRoot,
      typeof args.pattern === 'string' ? args.pattern : undefined,
    );
  },
  probe: async ({ axis, phase, status, tool, args }) =>
    localAuthorityProbe({ axis, phase, status, tool, args }),
  recoverRuntimeConnection: async (status) => {
    const current = getClient();
    const recovered = await recoverAuthoritativeRuntimeConnection(status, current, { getClient });
    const bundle = status.bindings.bundle as
      | { targetId?: unknown; connectionGeneration?: unknown }
      | undefined;
    return (
      recovered.connectedTarget?.id !== bundle?.targetId ||
      recovered.connectionGeneration !== bundle?.connectionGeneration
    );
  },
  runtimeConnectionChanged: (status) => {
    const current = getClient();
    const metro = status.bindings.metro as { port?: unknown } | undefined;
    const device = status.bindings.device as { platform?: unknown; appId?: unknown } | undefined;
    const metroPort = metro?.port;
    const platform = device?.platform;
    const appId = device?.appId;
    if (
      !Number.isSafeInteger(metroPort) ||
      (platform !== 'ios' && platform !== 'android') ||
      typeof appId !== 'string' ||
      !current.matchesAuthoritativeSessionPolicy(Number(metroPort), {
        platform,
        bundleId: appId,
      }) ||
      current.reconnectState.active ||
      !current.isConnected
    ) {
      return false;
    }
    const bundle = status.bindings.bundle as
      | { targetId?: unknown; connectionGeneration?: unknown }
      | undefined;
    return (
      current.connectedTarget?.id !== bundle?.targetId ||
      current.connectionGeneration !== bundle?.connectionGeneration
    );
  },
  refreshRuntimeBinding: rebindSessionRuntime,
  relaunchBoundRuntime: relaunchSessionRuntime,
  reconnectBoundRuntime: reconnectSessionRuntime,
  snapshotCaptureCheckpoint: getSnapshotCaptureCheckpoint,
  promoteSnapshotOrigin: promoteSnapshotOriginSince,
  onRuntimeBundleInvalidated: () => getClient().clearAuthoritativeSessionPolicy(),
  onRunnerReleased: async (runner, signal) => {
    if (runner.platform !== 'ios') return;
    const deviceId = typeof runner.deviceId === 'string' ? runner.deviceId : undefined;
    await stopFastRunner(deviceId, signal);
    resetRunnerRebuildBudgetForCurrentPlugin();
  },
});
setObserveAuthorityDeps({
  resolve: () => {
    const { registry, session } = authorityRuntime.requireAvailable();
    const status = registry.getSessionStatus(session.sessionId);
    const secret = process.env.RN_DEV_AGENT_SESSION_SECRET_PATH
      ? readJsonStateFile<{ observeCapability?: string }>(
          process.env.RN_DEV_AGENT_SESSION_SECRET_PATH,
        )
      : null;
    const port = Number(status?.bindings.observePort);
    if (!status || !secret?.observeCapability || !Number.isSafeInteger(port)) {
      throw new Error('OBSERVE_AUTHORITY_MISMATCH: Observe authority is incomplete');
    }
    return {
      port,
      authority: {
        sessionId: status.sessionId,
        claimEpoch: status.claimEpoch,
        instanceId: randomUUID(),
        capability: secret.observeCapability,
      },
    };
  },
  bind: ({ port, authority, autostarted }) => {
    const { registry, session } = authorityRuntime.requireAvailable();
    const controller = registry.getControllerBinding(session);
    registry.updateBindings(session, {
      bindings: {
        observe: {
          port,
          sessionId: authority.sessionId,
          claimEpoch: authority.claimEpoch,
          instanceId: authority.instanceId,
          cleanupCapability: authority.capability,
          pid: controller.worker.pid,
          processBirth: controller.worker.token,
          autostarted,
        },
      },
    });
  },
  unbind: (authority) => {
    const { registry, session } = authorityRuntime.requireAvailable();
    const status = registry.getSessionStatus(session.sessionId);
    const observe = status?.bindings.observe as
      | {
          sessionId?: unknown;
          claimEpoch?: unknown;
          instanceId?: unknown;
        }
      | undefined;
    if (
      observe?.sessionId !== authority.sessionId ||
      observe.claimEpoch !== authority.claimEpoch ||
      observe.instanceId !== authority.instanceId
    ) {
      return;
    }
    registry.updateBindings(session, { bindings: { observe: null } });
  },
});

// GH#186 Phase 6: the foreign-flow gate needs the active iOS session's udid
// (registered here — a direct import inside the gate would cycle modules).
setForeignGateUdidProvider(() => {
  const s = getActiveSession();
  return s?.platform === 'ios' && s.deviceId ? s.deviceId : null;
});

// Mirror block declared BEFORE liveDeps: buildLiveDeps's isMirrorActive input
// closes over `mirrorManager`, so this must exist first (TDZ safety) even
// though the arrow body only runs later.
const mirrorCfg = diagnosticContractProbe
  ? { enabled: false as const, fps: 0 }
  : resolveMirrorConfig();
const mirrorManager = mirrorCfg.enabled
  ? new MirrorManager({
      resolveTarget: buildMirrorTargetResolver({
        getPlatform: () => {
          const p = getActiveSession()?.platform ?? getClient().connectedTarget?.platform;
          return p === 'ios' || p === 'android' ? p : null;
        },
        getSessionDeviceId: () => getActiveSession()?.deviceId ?? undefined,
        // GH #791: same fence as cdp discovery (PR #786) — an authority session
        // without a proven device binding blocks the mirror instead of guessing.
        getRegistryDeviceBinding: () =>
          mapRegistryDeviceBinding(authorityRuntime.status(), authorityRuntime.available),
        resolveIosUdid: () => resolveIosUdid(),
        listAndroidSerials: async () => {
          try {
            const { stdout } = await execFileP('adb', ['devices'], {
              timeout: 5000,
              maxBuffer: 1024 * 1024,
            });
            return parseAllAdbDevices(stdout)
              .filter((d) => d.state === 'device')
              .map((d) => d.serial);
          } catch {
            return [];
          }
        },
      }),
      createSource: (t) =>
        createMirrorSource(t, mirrorCfg.fps, {
          firstFrameTimeoutMs: mirrorCfg.firstFrameTimeoutMs,
        }),
      createFallbackSource: async (t, cause) => {
        if (t.platform !== 'ios') {
          throw new Error('mirror fallback is iOS simctl only');
        }
        return new IosSimctlLoopSource(t.deviceId, {
          degradedHint: idbDemotionHint(cause),
        });
      },
      // MirrorStatus is a closed interface (no index signature); recorder.push
      // takes the open event shape every other recorder.push(...) call site
      // uses. Spread into a fresh literal so structural assignability applies.
      pushStatus: (s) => recorder.push({ ...s }),
      // Outlasts the source-level idb first-frame timeout so demotion runs first.
      firstFrameWatchdogMs: mirrorCfg.firstFrameTimeoutMs + 15_000,
    })
  : undefined;
if (mirrorManager) setObserveMirror(mirrorManager);

const liveEnabled = !diagnosticContractProbe && process.env.RN_OBSERVE_LIVE !== '0';
const liveDeps = buildLiveDeps({
  recorder,
  isFlowActive: () => arbiter.flowActive || foreignFlowGate.lastActive,
  getActiveSession,
  getClient: () => getClient(),
  captureScreenshot: (platform, path) => {
    // GH #422: bind the live panel to the session device too — raw resolution
    // refuses on multi-sim ambiguity instead of first-pick now.
    const session = getActiveSession();
    return tryRawScreenshot(
      platform,
      path,
      session && session.platform === platform ? session.deviceId : undefined,
    );
  },
  readRoute: (c) => readLiveRoute(c as Parameters<typeof readLiveRoute>[0]),
  readShotFile: (path) => {
    try {
      const buf = readFileSync(path);
      // Derive content-type from the magic bytes, not the extension: Android's
      // `adb screencap -p` writes PNG bytes regardless of the .jpg tmp path, so
      // an extension-based guess would mislabel them (final-review finding).
      const isPng =
        buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      return { buf, contentType: isPng ? 'image/png' : 'image/jpeg' };
    } catch {
      return null;
    }
  },
  isMirrorActive: () => mirrorManager?.isStreaming() ?? false,
});

const registeredToolNames: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trackedTool(name: string, desc: string, schema: z.ZodRawShape, handler: any): void {
  registeredToolNames.push(name);
  const base = instrumentTool(
    name,
    authorityGate.wrap(
      name,
      arbiterWrap(
        name,
        handler as (...args: unknown[]) => Promise<import('./utils.js').ToolResult>,
      ) as (...args: unknown[]) => Promise<unknown>,
    ),
  );
  // GH #321: the device_find snapshot-cache must be invalidated after ANY tool
  // that could change the screen — including JS-level mutations that bypass the
  // runNative choke point (cdp_interact, cdp_navigate, device_deeplink, the
  // fastSwipe path, cdp_dispatch/reload/maestro_*). trackedTool is the one
  // boundary every external call crosses, so the fail-safe invalidation lives
  // here and runs regardless of liveEnabled. GH #206 live capture layers on top.
  const installLiveCapture = liveEnabled && mayTriggerLiveCapture(name);
  const wrapped = async (...a: unknown[]): Promise<unknown> => {
    if (diagnosticContractProbe) {
      return failResult(
        'Tool calls are disabled in the read-only MCP contract probe.',
        'DIAGNOSTIC_MODE_READ_ONLY',
      );
    }
    const args = a[0] as Record<string, unknown> | undefined;
    let result: unknown;
    try {
      result = await base(...a);
    } finally {
      // A mutating tool may have changed the screen even on a thrown/rejected
      // call (dispatch landed, then something downstream failed), so both
      // fail-safe invalidations run on the error path too — not only after a
      // clean return. Story 05 (#386): the tap-retry baseline hash shares the
      // same boundary as the GH #321 snapshot-cache dirty flag above it — see
      // toolInvalidatesRetryBaseline's doc comment for why native device verbs
      // are excluded (they manage it themselves via settle).
      const snapshotPlatform = resolveSnapshotInvalidationPlatform(
        name,
        args,
        getActiveSession()?.platform,
      );
      if (toolInvalidatesSnapshotCache(name, args)) markSnapshotDirty(snapshotPlatform);
      if (toolInvalidatesRetryBaseline(name, args)) invalidateLastSnapshotHash();
    }
    if (installLiveCapture && isStateMutating(name, args)) {
      void maybeCaptureLiveFrame(liveDeps);
    }
    return result;
  };
  server.tool(
    name,
    desc,
    {
      ...schema,
      supervisorOverrideToken: z
        .string()
        .min(16)
        .optional()
        .describe('Supervisor token for one audited mutation after a blocked login prologue.'),
    },
    wrapped as typeof handler,
  );
}

async function pinSessionDevClient(
  status: SessionStatus,
  options: { force: boolean },
  commitBundle: (bundle: BundleAuthorityBinding, promotion: BundleAuthorityPromotion) => void,
) {
  const device = status.bindings.device as {
    platform: 'ios' | 'android';
    deviceId: string;
    appId: string;
  };
  const metro = status.bindings.metro as {
    port: number;
    instanceId: string;
    buildGeneration: number;
  };
  const install = status.bindings.install as
    | {
        appId?: unknown;
        buildGeneration?: unknown;
        buildKind?: unknown;
        devClientUrl?: unknown;
        deviceId?: unknown;
        metroPort?: unknown;
        platform?: unknown;
      }
    | undefined;
  const secret = process.env.RN_DEV_AGENT_SESSION_SECRET_PATH
    ? readJsonStateFile<{ signerCapability?: string }>(process.env.RN_DEV_AGENT_SESSION_SECRET_PATH)
    : null;
  if (
    install?.platform !== device.platform ||
    install.deviceId !== device.deviceId ||
    install.appId !== device.appId ||
    install.metroPort !== metro.port ||
    install.buildGeneration !== metro.buildGeneration
  ) {
    throw new Error('BUILD_RECEIPT_INVALID: exact launch provenance is unavailable');
  }
  const devClientUrl = typeof install.devClientUrl === 'string' ? install.devClientUrl : undefined;
  if (install.buildKind !== 'expo' && install.buildKind !== 'bare-react-native') {
    throw new Error('BUILD_RECEIPT_INVALID: exact build command provenance is unavailable');
  }
  const runtimeKind = install.buildKind === 'expo' ? 'expo-dev-client' : 'bare-react-native';
  if (!secret?.signerCapability) {
    throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: session signer is unavailable');
  }
  const current = getClient();
  const suspendedPolicy =
    device.platform === 'android' ? current.authoritativeSessionPolicy : undefined;
  if (device.platform === 'ios') {
    current.clearAuthoritativeSessionPolicy();
    if (options.force) {
      await current.disconnect();
      setClient(createClient(metro.port));
    }
  } else if (suspendedPolicy) {
    current.clearAuthoritativeSessionPolicy();
  }
  foreignMetroOriginScanner.invalidate();
  try {
    const bundle = await pinExactDevClient(
      {
        sessionId: status.sessionId,
        metroInstanceId: metro.instanceId,
        worktreeKey: status.worktreeKey,
        appId: device.appId,
        platform: device.platform,
        buildGeneration: metro.buildGeneration,
        deviceId: device.deviceId,
        metroPort: metro.port,
        runtimeKind,
        ...(devClientUrl ? { devClientUrl, expectedDevClientUrl: devClientUrl } : {}),
        signerCapability: secret.signerCapability,
      },
      {
        openUrl: async (platform, deviceId, url) => {
          if (platform === 'ios') {
            await execFileP('xcrun', ['simctl', 'openurl', deviceId, url]);
          } else {
            await execFileP('adb', androidDeeplinkCommandArgs(url, undefined, deviceId));
          }
        },
        launchExactApp: async (platform, deviceId, appId) => {
          if (platform === 'ios') {
            await execFileP('xcrun', ['simctl', 'launch', deviceId, appId]);
          } else {
            await execFileP('adb', [
              '-s',
              deviceId,
              'shell',
              'monkey',
              '--pct-syskeys',
              '0',
              '-p',
              appId,
              '-c',
              'android.intent.category.LAUNCHER',
              '1',
            ]);
          }
        },
        launchExactAppWithInitialUrl: async (deviceId, appId, initialUrl) => {
          await execFileP('xcrun', [
            'simctl',
            'launch',
            '--terminate-running-process',
            deviceId,
            appId,
            '--initialUrl',
            initialUrl,
          ]);
        },
        acceptIosOpenDialog: async () => {
          const result = await acceptDeeplinkOpenConfirmation();
          if (result && !result.tapped) {
            throw new Error(
              'DEV_CLIENT_ENDPOINT_NOT_FOUND: iOS open confirmation did not expose the exact Open action',
            );
          }
        },
        connectExact: async ({ metroPort, platform, appId, deviceId }) => {
          return connectExactSessionTarget(
            { metroPort, platform, appId, deviceId },
            exactSessionTargetReadinessTimeoutMs(platform),
          );
        },
        detectForeignMetroOrigin: foreignMetroOriginScanner,
        readMarker: async (connection) => {
          const markerClient = 'client' in connection ? connection.client : getClient();
          const result = await markerClient.evaluate(
            'JSON.stringify(globalThis.__RN_DEV_AGENT_AUTHORITY__ ?? null)',
          );
          if (typeof result.value !== 'string') return null;
          const parsed = JSON.parse(result.value) as {
            status?: string;
            marker?: MetroAuthorityMarker;
          } | null;
          return parsed?.status === 'signed' && parsed.marker
            ? { status: 'signed' as const, marker: parsed.marker }
            : null;
        },
        commitBundle,
        readManagedManifest: async ({ host, metroPort, platform }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          try {
            const response = await fetch(`http://${host}:${metroPort}/`, {
              headers: {
                accept: 'multipart/mixed,application/expo+json,application/json',
                'expo-platform': platform,
              },
              signal: controller.signal,
            });
            return {
              body: await response.text(),
              contentType: response.headers.get('content-type') ?? '',
              status: response.status,
            };
          } catch (error) {
            throw new Error(
              `METRO_MANIFEST_ENDPOINT_MISMATCH: managed manifest request failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } finally {
            clearTimeout(timer);
          }
        },
      },
    );
    getClient().setAuthoritativeSessionPolicy(createAuthoritativeSessionPolicy(status));
    foreignMetroOriginScanner.invalidate();
    return bundle;
  } catch (error) {
    if (suspendedPolicy && getClient() === current) {
      current.setAuthoritativeSessionPolicy(suspendedPolicy);
    }
    throw error;
  }
}

function createAuthoritativeSessionPolicy(status: SessionStatus): AuthoritativeSessionPolicy {
  const device = status.bindings.device as {
    platform: 'ios' | 'android';
    deviceId: string;
    appId: string;
  };
  const metroPort = Number(status.bindings.metroPort);
  return {
    port: metroPort,
    filters: { platform: device.platform, bundleId: device.appId },
    resolveTargetId: async (
      targets: import('./types.js').HermesTarget[],
      awaitWithinBoundary?: AwaitWithinBoundary,
    ) => {
      const exactCandidates = await filterTargetsForExactDevice(
        {
          platform: device.platform,
          deviceId: device.deviceId,
          targets,
        },
        { execute: execFileP, awaitWithinBoundary },
      );
      if (exactCandidates.length !== 1) {
        throw exactCandidateMismatchError(
          {
            metroPort,
            platform: device.platform,
            appId: device.appId,
            deviceId: device.deviceId,
          },
          targets,
          targets,
          exactCandidates,
        );
      }
      return exactCandidates[0]!.id;
    },
    verifyAndReconcile: (connectedClient, awaitWithinBoundary) =>
      reconcileAuthoritativeConnection(connectedClient, awaitWithinBoundary),
  };
}

async function connectExactSessionTarget(
  input: {
    metroPort: number;
    platform: 'ios' | 'android';
    appId: string;
    deviceId: string;
  },
  timeoutMs: number,
): Promise<ExactSessionTargetConnection> {
  return connectExactSessionTargetWithDependencies(input, timeoutMs, {
    getClient,
    setClient,
    publishClient,
    createClient,
    createAttemptClient: (port) => configureClientLifecycle(new CDPClient(port)),
    execute: execFileP,
  });
}

interface ManagedRuntimeLaunchBinding {
  platform: 'ios' | 'android';
  deviceId: string;
  appId: string;
  metroPort: number;
  devClientUrl: string | null;
}

function resolveManagedRuntimeLaunchBinding(status: SessionStatus): ManagedRuntimeLaunchBinding {
  const device = status.bindings.device as {
    platform?: unknown;
    deviceId?: unknown;
    appId?: unknown;
    devClientUrl?: unknown;
  };
  const metro = status.bindings.metro as { port?: unknown };
  const install = status.bindings.install as { devClientUrl?: unknown };
  const platform = device.platform;
  const deviceId = device.deviceId;
  const appId = device.appId;
  const metroPort = metro.port;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    typeof deviceId !== 'string' ||
    typeof appId !== 'string' ||
    !Number.isSafeInteger(metroPort)
  ) {
    throw new Error('METRO_ORIGIN_MISMATCH: managed replay launch authority is incomplete');
  }
  return {
    platform,
    deviceId,
    appId,
    metroPort: Number(metroPort),
    devClientUrl:
      typeof install.devClientUrl === 'string'
        ? install.devClientUrl
        : typeof device.devClientUrl === 'string'
          ? device.devClientUrl
          : null,
  };
}

function stageAndroidRuntimeConnection(
  connection: ExactSessionTargetConnection,
): StagedRuntimeRelaunch {
  const candidateProbe = createRuntimeAuthorityProbe(() => connection.client);
  return {
    probe: (input) => connection.run(() => candidateProbe(input)),
    refreshRuntimeBinding: (currentStatus) =>
      connection.run(() => rebindSessionRuntime(currentStatus, connection.run, connection.client)),
    assertActive: connection.assertActive,
    publish: (currentStatus) => {
      connection.publish();
      getClient().setAuthoritativeSessionPolicy(createAuthoritativeSessionPolicy(currentStatus));
    },
    cancel: connection.cancel,
  };
}

/**
 * GH #708: re-establish the exact managed target without touching the app.
 * A mid-flow relaunch whose dev-client only re-registers after the flow's own
 * post-launch steps needs the connection back, not another cold start.
 */
async function reconnectSessionRuntime(
  status: SessionStatus,
  options?: ManagedNativeOriginReproveOptions,
): Promise<StagedRuntimeRelaunch | void> {
  const { platform, deviceId, appId, metroPort } = resolveManagedRuntimeLaunchBinding(status);
  const platformBudgetMs = exactSessionTargetReadinessTimeoutMs(platform);
  const readinessTimeoutMs =
    typeof options?.readinessTimeoutMs === 'number'
      ? Math.max(1, Math.min(options.readinessTimeoutMs, platformBudgetMs))
      : platformBudgetMs;
  if (platform === 'ios') {
    const current = getClient();
    await current.disconnect();
    setClient(createClient(metroPort));
    await connectExactSessionTarget({ metroPort, platform, appId, deviceId }, readinessTimeoutMs);
    return;
  }
  const connection = await connectExactSessionTarget(
    { metroPort, platform, appId, deviceId },
    readinessTimeoutMs,
  );
  return stageAndroidRuntimeConnection(connection);
}

const isSessionRuntimeAbsent = createSessionRuntimeAbsenceProbe({
  resolveBinding: () => {
    const status = authorityRuntime.status();
    if (!status.available) return null;
    const { platform, deviceId, appId, metroPort } = resolveManagedRuntimeLaunchBinding(status);
    return { platform, deviceId, appId, metroPort };
  },
  listTargets: (metroPort) => getClient().listTargetsExact(metroPort),
  execute: (file, args, options) => execFileP(file, args, options),
});

async function relaunchSessionRuntime(
  status: SessionStatus,
): Promise<StagedRuntimeRelaunch | void> {
  const {
    platform,
    deviceId,
    appId,
    metroPort,
    devClientUrl: boundDevClientUrl,
  } = resolveManagedRuntimeLaunchBinding(status);
  if (platform === 'ios') {
    const current = getClient();
    await current.disconnect();
    setClient(createClient(metroPort));
    await execFileP('xcrun', [
      'simctl',
      'launch',
      '--terminate-running-process',
      deviceId,
      appId,
      '--initialUrl',
      `http://127.0.0.1:${String(metroPort)}`,
    ]);
    await connectExactSessionTarget(
      { metroPort, platform, appId, deviceId },
      exactSessionTargetReadinessTimeoutMs(platform),
    );
    return;
  }

  if (!boundDevClientUrl) {
    throw new Error(
      'DEV_CLIENT_ENDPOINT_NOT_FOUND: managed Android replay requires the exact Dev Client URL',
    );
  }
  await execFileP('adb', [
    ...androidDeeplinkCommandArgs(boundDevClientUrl, undefined, deviceId),
    '-p',
    appId,
  ]);
  const connection = await connectExactSessionTarget(
    { metroPort, platform, appId, deviceId },
    exactSessionTargetReadinessTimeoutMs(platform),
  );
  return stageAndroidRuntimeConnection(connection);
}

async function rebindSessionRuntime(
  status: SessionStatus,
  awaitWithinBoundary?: AwaitWithinBoundary,
  connectedClient: CDPClient = getClient(),
): Promise<Record<string, unknown>> {
  const device = status.bindings.device as {
    platform: 'ios' | 'android';
    deviceId: string;
    appId: string;
  };
  const metro = status.bindings.metro as {
    port: number;
    instanceId: string;
    buildGeneration: number;
  };
  const prior = status.bindings.bundle as Record<string, unknown> | null;
  const install = status.bindings.install as { devClientUrl?: string };
  const declaredDevice = status.bindings.device as { devClientUrl?: string };
  const secret = process.env.RN_DEV_AGENT_SESSION_SECRET_PATH
    ? readJsonStateFile<{ signerCapability?: string }>(process.env.RN_DEV_AGENT_SESSION_SECRET_PATH)
    : null;
  return withRecoveredAuthoritativeRuntime(
    status,
    connectedClient,
    async (client) => {
      const target = client.connectedTarget;
      if (
        !client.isConnected ||
        !target ||
        client.metroPort !== metro.port ||
        !targetMatchesSession(target, {
          platform: device.platform,
          bundleId: device.appId,
        })
      ) {
        throw new Error(
          'CDP_TARGET_AUTHORITY_MISMATCH: runtime reset did not reconnect the exact session target',
        );
      }
      await proveTargetDeviceAssociation(
        {
          platform: device.platform,
          deviceId: device.deviceId,
          targetDeviceName: target.deviceName,
        },
        { execute: execFileP, awaitWithinBoundary },
      );
      const evaluateMarker = () =>
        client.evaluate('JSON.stringify(globalThis.__RN_DEV_AGENT_AUTHORITY__ ?? null)');
      const evaluated = await (awaitWithinBoundary
        ? awaitWithinBoundary(evaluateMarker)
        : evaluateMarker());
      const outer =
        typeof evaluated.value === 'string'
          ? (JSON.parse(evaluated.value) as {
              status?: string;
              marker?: MetroAuthorityMarker;
            } | null)
          : null;
      if (outer?.status !== 'signed' || !outer.marker || !secret?.signerCapability) {
        throw new Error(
          'BUNDLE_HANDSHAKE_UNAVAILABLE: runtime reset did not expose the signed session marker',
        );
      }
      const verified = verifyMetroAuthorityMarker(outer.marker, secret.signerCapability, {
        sessionId: status.sessionId,
        metroInstanceId: metro.instanceId,
        worktreeKey: status.worktreeKey,
        appId: device.appId,
        platform: device.platform,
        buildGeneration: metro.buildGeneration,
      });
      const devClientUrl =
        (typeof prior?.devClientUrl === 'string' ? prior.devClientUrl : undefined) ??
        install.devClientUrl ??
        declaredDevice.devClientUrl;
      return buildBundleAuthorityBinding({
        ...verified,
        deviceId: device.deviceId,
        metroPort: metro.port,
        ...(devClientUrl ? { devClientUrl } : {}),
        targetId: target.id,
        connectionGeneration: client.connectionGeneration,
      });
    },
    { getClient },
  );
}

async function reconcileAuthoritativeConnection(
  connectedClient: CDPClient,
  awaitWithinBoundary?: AwaitWithinBoundary,
): Promise<void> {
  if (getClient() !== connectedClient) {
    throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: authoritative client was replaced');
  }
  const available = authorityRuntime.requireAvailable();
  const status = available.registry.getSessionStatus(available.session.sessionId);
  if (!status) throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: session authority is unavailable');
  await reconcileAuthoritativeBundle(status, {
    verifyRuntime: () => rebindSessionRuntime(status, awaitWithinBoundary),
    hasActiveOperation: () =>
      available.registry.currentOperation() !== undefined ||
      available.registry.hasActiveBundleOperation(available.session),
    commit: (input) => available.registry.updateBindings(available.session, input),
  });
}

const persistedAuthorityStatus = authorityRuntime.status();
if (persistedAuthorityStatus.available && persistedAuthorityStatus.bindings.bundle) {
  getClient().setAuthoritativeSessionPolicy(
    createAuthoritativeSessionPolicy(persistedAuthorityStatus),
  );
}

const getSessionSignerCapability = (sessionId?: string): string | null => {
  const currentSecretPath = process.env.RN_DEV_AGENT_SESSION_SECRET_PATH;
  if (!currentSecretPath) return null;
  if (sessionId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return null;
  const secretPath = sessionId
    ? join(dirname(dirname(currentSecretPath)), sessionId, 'secret.json')
    : currentSecretPath;
  return readJsonStateFile<{ signerCapability?: string }>(secretPath)?.signerCapability ?? null;
};
// GH #706: SIGUSR2 is the supervisor's existing hot-reload intent — it respawns this
// worker (replaying the MCP handshake) with the environment of a freshly resolved
// session, which is the only way a released session becomes usable again in-band.
const spawningSupervisorPid = process.ppid;
const requestWorkerRecycle = (): boolean => {
  if (process.env.RN_BRIDGE_SUPERVISED !== '1') return false;
  if (!Number.isInteger(spawningSupervisorPid) || spawningSupervisorPid <= 1) return false;
  setTimeout(() => {
    // A changed parent means the supervisor died and its PID may now belong to an
    // unrelated process; never signal that stranger.
    if (process.ppid !== spawningSupervisorPid) return;
    try {
      process.kill(spawningSupervisorPid, 'SIGUSR2');
    } catch {
      /* supervisor already gone — the next transport start resolves a session */
    }
  }, 250).unref();
  return true;
};

const sessionHandler = createSessionHandler(authorityRuntime, {
  getSignerCapability: getSessionSignerCapability,
  pinDevClient: pinSessionDevClient,
  onBundleInvalidated: () => getClient().clearAuthoritativeSessionPolicy(),
  requestWorkerRecycle,
  ensureAndroidMetroReverse,
  removeAndroidMetroReverse,
});
const disconnectClientHandler = createDisconnectHandler(getClient, setClient, createClient);

const connectBoundSession = createRegisteredConnectHandler(authorityRuntime, sessionHandler);

async function disconnectBoundSession() {
  const disconnected = await disconnectClientHandler({});
  if (disconnected.isError) return disconnected;
  const { registry, session } = authorityRuntime.requireAvailable();
  const status = registry.getSessionStatus(session.sessionId);
  const targetId = (status?.bindings.bundle as { targetId?: unknown } | undefined)?.targetId;
  if (status && typeof targetId === 'string') {
    registry.releaseResources(session, [
      {
        type: 'target',
        key: `${String(status.bindings.metroPort)}:${targetId}`,
      },
    ]);
    registry.updateBindings(session, {
      state: 'device_bound',
      bindings: { bundle: null },
    });
  }
  getClient().clearAuthoritativeSessionPolicy();
  return disconnected;
}

trackedTool(
  'rn_session',
  'Inspect and transition the fenced rn-dev-agent authority session. Status reconciles lost managed Metro authority without touching the app; bind, handoff, adoption, recovery, managed Metro cleanup, and release actions are fail-closed.',
  {
    action: z.enum([
      'status',
      'bind_source',
      'bind_device',
      'bind_metro',
      'pin_dev_client',
      'prepare_handoff',
      'cancel_handoff',
      'accept_handoff',
      'adopt_stale',
      'release_stale_device',
      'recover_arbiter',
      'preview_integration',
      'apply_integration',
      'restore_integration',
      'stop_metro',
      'release',
    ]),
    projectRoot: z
      .string()
      .describe('bind_source: same-repo worktree to rebind; other actions refuse on mismatch')
      .optional(),
    platform: z
      .enum(['ios', 'android'])
      .describe('Required with deviceId for foreign transfer; omit both to resume own journal')
      .optional(),
    deviceId: z
      .string()
      .describe('Required with platform for foreign transfer; omit both to resume own journal')
      .optional(),
    appId: z.string().optional(),
    devClientUrl: z.string().url().optional(),
    buildReceipt: z.record(z.unknown()).optional(),
    metroPort: z.number().int().min(1).max(65535).optional(),
    metroPid: z.number().int().positive().optional(),
    metroInstanceId: z.string().optional(),
    buildGeneration: z.number().int().nonnegative().optional(),
    mode: z.enum(['managed', 'external']).optional(),
    targetHandle: z.string().optional(),
    ttlMs: z.number().int().min(5_000).max(300_000).optional(),
    handoffId: z.string().optional(),
    token: z.string().optional(),
    adoptionHandle: z.string().optional(),
    releaseHandle: z
      .string()
      .describe('Legacy release-offer capability; confirmed: true supersedes it')
      .optional(),
    confirmed: z.boolean().describe('Authorizes inline proven-dead device cleanup').optional(),
    force: z.boolean().optional(),
  },
  sessionHandler,
);

trackedTool(
  'cdp_status',
  'Passively report the current authority session, Metro client, and CDP target without connecting, relaunching, dismissing UI, or choosing an ambient target.',
  {
    metroPort: z
      .number()
      .optional()
      .describe('Diagnostic comparison only; cdp_status never changes the active Metro port'),
    platform: z
      .string()
      .optional()
      .describe(
        'Filter target by platform (e.g. "ios", "android") to avoid connecting to the wrong device in multi-simulator setups',
      ),
  },
  createPassiveStatusHandler(getClient, authorityRuntime, {
    getSignerCapability: getSessionSignerCapability,
    onBundleInvalidated: () => getClient().clearAuthoritativeSessionPolicy(),
  }),
);

trackedTool(
  'observe',
  "Start/stop the read-only observability web UI (watch the agent's live tool-call timeline, device screenshot, and app state). action: start|stop|status.",
  observeSchema,
  observeHandler,
);

trackedTool(
  'cdp_diagnostic_renderers',
  'Diagnostic helper for "fiber root invisibility" bug reports (issue #126 follow-up). Enumerates every registered React renderer and its root count via __REACT_DEVTOOLS_GLOBAL_HOOK__. Returns hook keys, renderer Map keys, per-renderer-id root summaries (top fiber type + first child + testID), and notes when renderers are registered but unscanned. Use this when cdp_component_tree returns empty for a component you know is mounted (modals, portals, sub-apps), or when bug-reporting fiber-walk failures.',
  {
    maxRendererId: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many renderer IDs to scan. Default 20 (matches IIFE MAX_RENDERER_IDS).'),
  },
  createDiagnosticRenderersHandler(getClient),
);

trackedTool(
  'cdp_connect',
  'Connect only the exact app target on the authority-bound Metro and commit its signed initial-bundle handshake. Omitted port/platform/app values come from the session; conflicts refuse.',
  {
    metroPort: z
      .number()
      .optional()
      .describe('Must equal the authority-bound Metro port; omitted uses that exact port'),
    platform: z
      .string()
      .optional()
      .describe(
        'Filter target by platform (e.g. "ios", "android"). If already connected to a different platform, forces reconnection to the correct target.',
      ),
    targetId: z
      .string()
      .optional()
      .describe('Advisory; refuses only if it conflicts with the bound target'),
    bundleId: z
      .string()
      .optional()
      .describe(
        'App bundle id to match against target.description (e.g. "com.myapp.dev"). Filters out zombie Expo Go host pages when the real app target is present. B111/D635.',
      ),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Force disconnect and reconnect even if already connected. Use to switch targets or recover from stale connections.',
      ),
  },
  connectBoundSession,
);

trackedTool(
  'cdp_disconnect',
  'Disconnect the authority-bound Hermes target and transactionally invalidate its bundle/target claim.',
  {},
  disconnectBoundSession,
);

trackedTool(
  'cdp_targets',
  'List available Hermes debug targets without connecting. An authoritative session lists only its exact managed Metro port; a fresh non-authoritative client keeps ordinary port discovery. Shows target IDs, titles, optional legacy VM metadata, and the currently connected target.',
  {
    metroPort: z.number().optional().describe('Session port; otherwise an ordinary discovery hint'),
  },
  createTargetsHandler(getClient),
);

trackedTool(
  'cdp_evaluate',
  'CAUTION: Executes arbitrary JavaScript directly in the Hermes runtime with no sandboxing. Use only when no specific tool covers the need. Has a 5-second timeout. The Hermes dev runtime has NO Node `require()` — Metro bundles modules internally and only the live React tree is reachable. Use cdp_mmkv for storage R/W, cdp_dispatch for Redux/Zustand state changes, cdp_component_tree / cdp_store_state for introspection. Reach for raw evaluate only when no targeted tool fits.',
  {
    expression: z.string().describe('JavaScript expression to evaluate'),
    awaitPromise: z.boolean().default(false).describe('Wait for promise resolution'),
  },
  createEvaluateHandler(getClient),
);

trackedTool(
  'cdp_reload',
  'Reload the authority-bound app and atomically replace its exact Hermes target claim. Recovery uses only the session device/app/Metro bindings and returns a failure unless the signed runtime marker is re-proven.',
  {
    full: z
      .boolean()
      .default(true)
      .describe('Always performs a full reload via DevSettings.reload()'),
  },
  createReloadHandler(getClient, setClient, createClient),
);

trackedTool(
  'cdp_component_tree',
  'Get React component tree. Returns components with props, state, testIDs. Use filter to scope to a specific subtree — NEVER request full tree unless necessary (saves tokens). Detects RedBox and warns. Pass interactiveOnly=true for a compact "what can I act on here?" digest (only tappable/editable elements + their text, no props/state) — the cheapest way to perceive a novel screen for live interaction.',
  {
    filter: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring match against component name, testID/nativeID, or accessibilityLabel (e.g. "CartBadge", "product-list", "Continue")',
      ),
    depth: z.number().int().min(1).max(12).default(4).describe('Max depth (default 4, max 12)'),
    interactiveOnly: z
      .boolean()
      .optional()
      .describe(
        'Return a compact salient digest: only actionable nodes (Pressable/Button/TextInput/Switch/Link + accessibilityRole controls) with {testID, role, text, label}, dropping props/hookStates/nesting. Ignores filter/depth. Use to cheaply see what is tappable on the current screen.',
      ),
  },
  createComponentTreeHandler(getClient),
);

trackedTool(
  'cdp_navigation_state',
  'Get current navigation state: active route, params, stack history, nested navigators, active tab. Works with React Navigation and Expo Router.',
  {},
  createNavigationStateHandler(getClient),
);

trackedTool(
  'cdp_nav_graph',
  'Navigation graph tool. PRIMARY: action="go" — navigates to any screen in ONE call (auto-scans if stale, plans path, executes via __NAV_REF__, verifies arrival, records outcome, returns heal advice on failure). Other actions for manual control: scan, read, navigate (plan only), record, staleness, playbook, heal.',
  {
    action: z
      .enum(['go', 'scan', 'read', 'navigate', 'record', 'staleness', 'playbook', 'heal'])
      .describe(
        'go = navigate in one call (recommended). scan/read/navigate/record/staleness/playbook/heal for manual control',
      ),
    navigator_id: z.string().optional().describe('(read) Filter to navigator subtree by id'),
    screen: z.string().optional().describe('(read/navigate/record/heal) Target screen name'),
    from: z.string().optional().describe('(navigate) Current screen. Omit to use active screen'),
    force: z.boolean().default(false).describe('(scan) Force re-scan'),
    method: z
      .enum(['programmatic', 'deep_link', 'ui_interaction'])
      .optional()
      .describe('(record/heal) Navigation method'),
    success: z.boolean().optional().describe('(record) Whether navigation succeeded'),
    latency_ms: z.number().optional().describe('(record) Navigation time in ms'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('(go/playbook/heal) Platform for playbook tips and heal advice'),
    params: z
      .record(z.unknown())
      .optional()
      .describe('(go) Screen params to pass (e.g. { id: "1" })'),
  },
  createNavGraphHandler(getClient),
);

trackedTool(
  'cdp_error_log',
  'Get unhandled JS errors and promise rejections. Hooked into ErrorUtils and Hermes rejection tracker. If empty but app crashed, the error is NATIVE — call cdp_native_errors to check native logs.',
  {
    clear: z.boolean().default(false).describe('Clear all captured errors instead of reading them'),
  },
  createErrorLogHandler(getClient),
);

trackedTool(
  'cdp_native_errors',
  'Read native-level errors from the exact authority-bound device. iOS uses simctl spawn for the claimed simulator; Android uses adb -s for the claimed serial.',
  {
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
    sinceSeconds: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .optional()
      .describe('How far back to look (default 60s, max 3600)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Max entries to return (default 10, max 100)'),
  },
  createNativeErrorsHandler(getClient),
);

trackedTool(
  'cdp_network_log',
  'Get recent network requests. Shows method, URL, status, duration. On RN 0.83+ uses CDP Network domain. On older versions uses injected fetch/XHR hooks (auto-detected). Buffers are per-device, keyed by Metro port + target id — switching simulators no longer bleeds stale traffic. Pass `device: "all"` to merge across every device seen this session. Filters AND-combine: `filter` (URL substring), `method` (HTTP verb), `since` (ISO timestamp). When more entries match than `limit` allows, response includes `truncated:true` + `total_matches`.',
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Max entries to return (default 20, max 100)'),
    filter: z.string().optional().describe('Filter by URL substring (e.g. "/api/cart")'),
    method: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Filter by HTTP method, case-insensitive (e.g. "POST" or ["POST","PUT"]). AND-combined with `filter`. Use to isolate mutations from follow-up GETs.',
      ),
    since: z
      .string()
      .optional()
      .describe(
        'ISO timestamp — drop entries with timestamp < since before applying limit. Use to pin a checkpoint before an action and ask for everything since.',
      ),
    clear: z.boolean().default(false).describe('Clear network buffer instead of reading'),
    device: z
      .string()
      .optional()
      .describe(
        'Scope: a specific device key OR the literal "all" for a chronologically-merged view across every device. Defaults to the active device.',
      ),
  },
  createNetworkLogHandler(getClient),
);

trackedTool(
  'cdp_network_body',
  'Get the actual response body for a network request by its requestId. Use cdp_network_log first to find request IDs. In CDP mode (RN 0.83+) bodies are fetched on-demand; on RN < 0.83 hook mode a small recent-response cache is used. Pass `device` to look up requestId in a specific device buffer; defaults to the active device.',
  {
    requestId: z.string().describe('Request ID from cdp_network_log output'),
    maxLength: z
      .number()
      .int()
      .min(100)
      .max(100000)
      .default(10000)
      .optional()
      .describe('Max body length to return (default 10000 chars). Truncated if longer.'),
    device: z
      .string()
      .optional()
      .describe(
        'Device key to scope the lookup ("all" to search every device buffer). Defaults to the active device.',
      ),
  },
  createNetworkBodyHandler(getClient),
);

trackedTool(
  'cdp_wait_for_network',
  'Block until a network request matching url_pattern (URL substring) and optional method completes (response received), or timeout_ms elapses. Two-phase: scans the existing buffer first (retroactive match), then polls every poll_interval_ms until deadline. Returns {matched:true, mutation, network_log_since} on success or {matched:false, timeout_ms, candidates_seen} (capped at 10) on timeout — never errors on timeout; agents should check `data.matched`. Use after triggering an action that fires a request to deterministically confirm it landed without buffer-churn races. Pin `since` to a timestamp captured BEFORE the trigger (Date.now() ISO) to also catch mutations that land in the MCP transport window. On RN < 0.83 (hook network mode) new-entry detection granularity is ~500ms — sub-500ms poll_interval_ms buys nothing there.',
  {
    url_pattern: z
      .string()
      .describe(
        'URL substring to match (e.g. "/api/cart/add", "checkout"). Same matching semantics as cdp_network_log filter.',
      ),
    method: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'HTTP method filter, case-insensitive (e.g. "POST" or ["POST","PUT"]). Omit to match any method.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(5000)
      .optional()
      .describe('Max wait in ms (default 5000, range 100-60000)'),
    poll_interval_ms: z
      .number()
      .int()
      .min(50)
      .max(500)
      .default(100)
      .optional()
      .describe('Buffer poll cadence in ms (default 100, range 50-500)'),
    since: z
      .string()
      .optional()
      .describe(
        'ISO timestamp checkpoint — ignore entries older than this. Defaults to the moment the tool is called. Capture `new Date().toISOString()` before the trigger action to avoid missing the mutation in the transport window.',
      ),
    device: z.string().optional().describe('Device key OR "all". Defaults to the active device.'),
  },
  createWaitForNetworkHandler(getClient),
);

trackedTool(
  'cdp_heap_usage',
  'Get current JS heap memory usage. Single fast CDP call — useful before/after operations to detect memory leaks. Returns used/total in bytes and MB.',
  {},
  createHeapUsageHandler(getClient),
);

trackedTool(
  'cdp_cpu_profile',
  'Record a CPU profile for a specified duration. Returns the top hot functions sorted by hit count and reports when the Profiler domain is unavailable.',
  {
    durationMs: z
      .number()
      .int()
      .min(500)
      .max(30000)
      .default(3000)
      .optional()
      .describe('Profile duration in ms (default 3000, max 30000)'),
  },
  createCpuProfileHandler(getClient),
);

trackedTool(
  'cdp_object_inspect',
  'Inspect a JS object by property path without flattening to JSON. Uses Runtime.getProperties for lazy, handle-based inspection. Good for large objects, cyclic refs, class instances.',
  {
    expression: z.string().describe('JS property path or primitive literal to inspect'),
    depth: z
      .number()
      .int()
      .min(0)
      .max(3)
      .default(1)
      .optional()
      .describe('Property inspection depth (default 1, max 3)'),
    maxProperties: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .optional()
      .describe('Max properties per level (default 20)'),
  },
  createObjectInspectHandler(getClient),
);

trackedTool(
  'cdp_exception_breakpoint',
  'Set the debugger to pause on exceptions. With durationMs: records exceptions for that period then auto-disables. Without durationMs: toggles the breakpoint state (call with state="none" to disable).',
  {
    state: z
      .enum(['none', 'uncaught', 'all'])
      .default('uncaught')
      .describe('Exception pause mode: none (off), uncaught (default), all'),
    durationMs: z
      .number()
      .int()
      .min(1000)
      .max(30000)
      .optional()
      .describe('Auto-capture duration in ms. If set, records exceptions then disables.'),
  },
  createExceptionBreakpointHandler(getClient),
);

trackedTool(
  'cdp_console_log',
  'Get recent console output. Buffered in ring buffer so logs from between agent calls are preserved.',
  {
    level: z
      .enum(['all', 'log', 'warn', 'error', 'info', 'debug'])
      .default('all')
      .describe('Filter by log level'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Max entries to return (default 50, max 200)'),
    clear: z.boolean().default(false).describe('Clear console buffer instead of reading'),
  },
  createConsoleLogHandler(getClient),
);

trackedTool(
  'cdp_store_state',
  'Read app store state (Redux, Zustand, Jotai, React Query). Use path to query specific slice (e.g. "cart.items", "auth.user.name"). Use storeType to target a specific store when multiple exist. Redux auto-detected via fiber Provider. Zustand requires: if (__DEV__) global.__ZUSTAND_STORES__ = { store }. Jotai requires: if (__DEV__) { global.__JOTAI_STORE__ = store; global.__JOTAI_ATOMS__ = { name: atom } }',
  {
    path: z.string().optional().describe('Dot-path into store state (e.g. "cart.items")'),
    storeType: z
      .enum(['redux', 'zustand', 'jotai', 'react-query'])
      .optional()
      .describe('Target a specific store type. Useful when app has both Redux and React Query.'),
  },
  createStoreStateHandler(getClient),
);

trackedTool(
  'cdp_navigate',
  'Navigate to any screen by name, including nested stack screens that __NAV_REF__.navigate() cannot reach. Builds a nested dispatch action by walking the navigation state tree. Works across tabs, stacks, and modals.',
  {
    screen: z
      .string()
      .describe('Screen name to navigate to (e.g. "AllTasks", "Dashboard", "ProfileEditModal")'),
    params: z.record(z.unknown()).optional().describe('Screen params (e.g. { id: "1" })'),
  },
  withConnection(
    getClient,
    async (args: { screen: string; params?: Record<string, unknown> }, client) => {
      const paramsArg = args.params ? JSON.stringify(args.params) : 'undefined';
      const expression = `__RN_AGENT.navigateTo(${JSON.stringify(args.screen)}, ${paramsArg})`;
      const result = await client.evaluate(expression);
      if (result.error) return failResult(`Navigate error: ${result.error}`);
      if (typeof result.value !== 'string') return failResult('Unexpected response');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.value);
      } catch {
        return okResult({ raw: result.value });
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        '__agent_error' in (parsed as Record<string, unknown>)
      ) {
        return failResult(String((parsed as Record<string, unknown>).__agent_error));
      }
      // GH #91: surface verification_warning when the requested screen matches
      // the success-shape regex AND the 5s rolling window has no qualifying
      // mutation. Uses args.screen as the signal — the user asked to navigate
      // there, so even if the actual landing route differs we capture intent.
      const cfg = loadVerificationConfig(getCachedProjectRoot());
      return annotateMutationAbsence(okResult(parsed), {
        client,
        screenName: args.screen,
        source: 'cdp_navigate',
        successShapes: cfg.successShapes,
        mutationMethods: cfg.mutationMethods,
      });
    },
  ),
);

trackedTool(
  'cdp_component_state',
  "Inspect a specific component's full hook state by testID. Returns props, all hook values (useState, useRef, useForm, etc.), and auto-detects react-hook-form control objects. Use when cdp_store_state misses non-Redux state (forms, local state, atoms).",
  {
    testID: z.string().describe('testID of the target component'),
  },
  withConnection(getClient, async (args: { testID: string }, client) => {
    const result = await client.evaluate(
      `__RN_AGENT.getComponentState(${JSON.stringify(args.testID)})`,
    );
    if (result.error) return failResult(`Component state error: ${result.error}`);
    if (typeof result.value !== 'string') return failResult('Unexpected response');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return okResult({ raw: result.value });
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      '__agent_error' in (parsed as Record<string, unknown>)
    ) {
      return failResult(String((parsed as Record<string, unknown>).__agent_error));
    }
    return okResult(parsed);
  }),
);

trackedTool(
  'cdp_set_shared_value',
  'Set a Reanimated SharedValue on a component found by testID. Walks the React fiber tree to find the component, locates the named prop (a SharedValue object), and sets .value. Useful for driving Reanimated animations in proof captures when gesture/scroll synthesis is unavailable.',
  {
    testID: z.string().describe('testID of the component that receives the SharedValue as a prop'),
    prop: z.string().describe('Prop name containing the SharedValue (e.g. "scrollY", "progress")'),
    value: z.number().describe('Numeric value to set on the SharedValue'),
  },
  withConnection(
    getClient,
    async (args: { testID: string; prop: string; value: number }, client) => {
      const expression = `(function() {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || typeof hook.getFiberRoots !== 'function') return JSON.stringify({ __agent_error: 'No React DevTools hook' });
      var allRoots = [];
      for (var i = 1; i <= 5; i++) {
        var r = hook.getFiberRoots(i);
        if (r && r.size) { var it = r.values(); var v; while (!(v = it.next()).done) allRoots.push(v.value); }
      }
      if (!allRoots.length) return JSON.stringify({ __agent_error: 'No fiber roots' });
      var found = null;
      function walk(fiber, depth) {
        if (!fiber || depth > 300 || found) return;
        var props = fiber.memoizedProps;
        if (props && props.testID === ${JSON.stringify(args.testID)}) {
          var sv = props[${JSON.stringify(args.prop)}];
          if (sv && typeof sv === 'object' && 'value' in sv) { found = fiber; return; }
          var fc = fiber;
          for (var up = 0; up < 5 && fc; up++) {
            var p2 = fc.memoizedProps;
            if (p2 && p2[${JSON.stringify(args.prop)}] && typeof p2[${JSON.stringify(
              args.prop,
            )}] === 'object' && 'value' in p2[${JSON.stringify(args.prop)}]) {
              found = fc; return;
            }
            fc = fc.return;
          }
        }
        if (fiber.child) walk(fiber.child, depth + 1);
        if (fiber.sibling) walk(fiber.sibling, depth);
      }
      for (var ri = 0; ri < allRoots.length; ri++) walk(allRoots[ri].current, 0);
      if (!found) return JSON.stringify({ __agent_error: 'No component with testID=' + ${JSON.stringify(
        args.testID,
      )} + ' has a SharedValue prop named ' + ${JSON.stringify(args.prop)} });
      var sv = found.memoizedProps[${JSON.stringify(args.prop)}];
      if (!sv) {
        var fc2 = found;
        for (var up2 = 0; up2 < 5 && fc2; up2++) {
          if (fc2.memoizedProps && fc2.memoizedProps[${JSON.stringify(
            args.prop,
          )}]) { sv = fc2.memoizedProps[${JSON.stringify(args.prop)}]; break; }
          fc2 = fc2.return;
        }
      }
      if (!sv || typeof sv !== 'object' || !('value' in sv)) return JSON.stringify({ __agent_error: 'SharedValue prop found but not accessible on the resolved fiber' });
      sv.value = ${args.value};
      var observed = sv.value;
      var drift = observed !== ${args.value};
      return JSON.stringify({ ok: true, testID: ${JSON.stringify(
        args.testID,
      )}, prop: ${JSON.stringify(args.prop)}, written: ${
        args.value
      }, observed: observed, drift: drift });
    })()`;
      const result = await client.evaluate(expression);
      if (result.error) return failResult(`SharedValue error: ${result.error}`);
      if (typeof result.value !== 'string') return failResult('Unexpected response');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.value);
      } catch {
        return okResult({ raw: result.value });
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        '__agent_error' in (parsed as Record<string, unknown>)
      ) {
        return failResult(String((parsed as Record<string, unknown>).__agent_error));
      }
      return okResult(parsed);
    },
  ),
);

trackedTool(
  'cdp_dispatch',
  'Dispatch a Redux action and optionally read state afterward — all in a single synchronous JS execution. Use for atomic dispatch+verify operations (e.g. dispatch "tasks/softDelete" then read "tasks.pendingDelete"). NOTE: Best used for state verification, not UI interaction testing — React components may not re-render immediately after CDP-dispatched actions. For UI testing, use device_press/device_find to trigger the action through the UI instead.',
  {
    action: z.string().describe('Redux action type (e.g. "tasks/softDelete", "cart/addItem")'),
    payload: z
      .any()
      .optional()
      .describe(
        'Action payload. WARNING: JSON-RPC between LLM and MCP does not preserve the distinction between string "42" and number 42 — the LLM\'s JSON encoder may serialize either way. For type-critical payloads (e.g. a string that happens to be numeric), use payloadJson instead.',
      ),
    payloadJson: z
      .string()
      .optional()
      .describe(
        'Stringified JSON payload with guaranteed type preservation. Takes precedence over `payload` when provided. Example: payloadJson=\'"42"\' dispatches the STRING "42"; payloadJson=\'42\' dispatches the NUMBER 42; payloadJson=\'{"id":"42","qty":5}\' dispatches an object.',
      ),
    readPath: z
      .string()
      .optional()
      .describe('Dot-path to read from store after dispatch (e.g. "tasks.pendingDelete")'),
  },
  createDispatchHandler(getClient),
);

trackedTool(
  'cdp_mmkv',
  'Read/write the app\'s MMKV storage from Hermes. Closes the iteration-loop gap where tests had to xcrun simctl uninstall + reinstall to clear cooldowns/timestamps/feature flags. Requires react-native-mmkv v3+ (Nitro-based) — older versions exposed via TurboModule are not reachable. Returns __agent_error if MMKV / NitroModulesProxy is unavailable in the runtime. Actions: get|set|delete|has|keys|clear. Use sparingly: writing to MMKV bypasses the real user flow, so only use during test setup/teardown, not as a substitute for UI interaction (see "Verification Fidelity" rule).',
  {
    action: z
      .enum(['get', 'set', 'delete', 'has', 'keys', 'clear'])
      .describe('MMKV action: get/set/delete/has by key, keys (list all), clear (wipe instance)'),
    key: z.string().optional().describe('Required for get/set/delete/has actions'),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe('Required for set action. Combine with `type` to disambiguate (default: string)'),
    type: z
      .enum(['string', 'number', 'boolean'])
      .optional()
      .describe('Value type for get/set (default: string)'),
    instanceId: z.string().optional().describe('MMKV instance id (default: "mmkv.default")'),
  },
  createMmkvHandler(getClient),
);

trackedTool(
  'cdp_dev_settings',
  'Control React Native dev settings programmatically (no visual dev menu needed). dismissRedBox clears LogBox overlays and RedBox errors via a 4-tier fallback chain. disableDevMenu suppresses the React Native core dev menu gesture. hideDevMenu calls ExpoDevMenu hideMenu or closeMenu over CDP on iOS or Android, with at most one retry and a five-second bound per attempt; it verifies the foreground surface and returns hidden, no_menu_present, DEV_MENU_HIDE_FAILED when no close call was sent, or DEV_MENU_HIDE_UNVERIFIED when a sent call is not proven clean. For reload with auto-reconnect, use cdp_reload instead.',
  {
    action: z
      .enum([
        'reload',
        'toggleInspector',
        'togglePerfMonitor',
        'dismissRedBox',
        'disableDevMenu',
        'hideDevMenu',
      ])
      .describe('Dev menu action to execute'),
  },
  createDevSettingsHandler(getClient, { probeForegroundSurface }),
);

trackedTool(
  'cdp_interact',
  'Interact with React components by testID, accessibilityLabel, or supported discovery facts. Calls JS handlers directly, not native touch. typeText joins every matching source to exact eligible handler-owning fibers under one cycle-safe 2,000-work-unit limit and refuses incomplete or ambiguous resolution; success proves one exact React handler dispatch, not native keyboard or input fidelity. It accepts placeholder or role+name, and generic onChange is eligible only on a proven native text-input host Fiber. accessibilityLabel matching uses exact, normalized, then substring tiers. setFieldValue walks to the nearest FormProvider, or safely matches an explicit control prop to an ancestor useForm hook return by object identity before calling setValue. Portal roots can be registered through globalThis.__RN_AGENT_EXTRA_ROOTS__. walkUp (opt-in): for action:"press" with testID/accessibilityLabel selectors only, walks up at most 8 fiber ancestors to the nearest pressable and refuses absence or ambiguity. Use device_swipe/device_press for native gestures.',
  {
    action: z
      .enum(['press', 'longPress', 'typeText', 'scroll', 'setFieldValue'])
      .describe('Action: press, longPress, typeText, scroll, or React Hook Form setFieldValue.'),
    testID: z
      .string()
      .optional()
      .describe(
        "testID prop of the target component (strict match — preferred). For setFieldValue, this is the testID anchor inside the form's subtree from which to walk up.",
      ),
    accessibilityLabel: z
      .string()
      .optional()
      .describe(
        'accessibilityLabel prop (used if testID not provided). Tiered match: exact → normalized (trim+lowercase) → substring. Returns Ambiguous error if >1 component matches.',
      ),
    text: z.string().optional().describe('Text to enter, or visible text selector for press.'),
    role: z
      .string()
      .optional()
      .describe('Accessibility role selector; for typeText combine with name.'),
    placeholder: z
      .string()
      .optional()
      .describe('Match a TextInput placeholder for press or typeText.'),
    exact: z
      .boolean()
      .optional()
      .describe(
        'Discovery ladder: require an exact (full-string) match for text/name/placeholder instead of case-insensitive substring.',
      ),
    includeHidden: z
      .boolean()
      .optional()
      .describe('Discovery ladder: include accessibility-hidden elements (excluded by default).'),
    scrollX: z.number().optional().describe('For scroll: horizontal offset in pixels (default 0)'),
    scrollY: z.number().optional().describe('For scroll: vertical offset in pixels (default 300)'),
    animated: z.boolean().default(true).describe('For scroll: whether to animate'),
    name: z
      .string()
      .optional()
      .describe('React Hook Form field name, or accessible name paired with role.'),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe(
        'Value to set. For setFieldValue: passed to setValue (a digit-string is kept a string when the field currently holds a string — give string fields a "" default so this applies). For press: when provided, onPress receives this value instead of a synthetic event — use for radio/chip-style value-bearing controls.',
      ),
    shouldValidate: z
      .boolean()
      .optional()
      .describe(
        "For setFieldValue: pass-through to setValue's options.shouldValidate (default true). Set false to suppress synchronous validation.",
      ),
    shouldDirty: z
      .boolean()
      .optional()
      .describe(
        "For setFieldValue: pass-through to setValue's options.shouldDirty (default true). Set false to keep the field marked pristine.",
      ),
    walkUp: z.boolean().optional().describe('Opt-in press-only nearest-pressable-ancestor walk'),
  },
  createInteractHandler(getClient),
);

trackedTool(
  'collect_logs',
  'Collect logs from multiple sources in parallel: JS console (Hermes ring buffer snapshot), native iOS (xcrun simctl log stream), native Android (adb logcat). Results merged and sorted by timestamp. Works without CDP when only native sources requested. Use when debugging crashes that span JS and native layers.',
  {
    sources: z
      .array(z.enum(['js_console', 'native_ios', 'native_android']))
      .default(['js_console'])
      .describe('Log sources to collect from (default: js_console only)'),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(2000)
      .describe(
        'How long to stream native logs in ms (default 2000). JS console is a snapshot — durationMs only applies to native sources.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe(
        'Max entries to return (default 100, max 500). Returns most recent entries when truncated.',
      ),
    filter: z.string().optional().describe('Substring filter applied to log text after collection'),
    logLevel: z
      .enum(['all', 'log', 'warn', 'error', 'info', 'debug'])
      .default('all')
      .describe('Filter by log level (default: all)'),
    runnerDiagnosticsOutputPath: z
      .string()
      .optional()
      .describe('New caller-named file for the newest sanitized runner diagnostics bundle'),
  },
  createCollectLogsHandler(getClient),
);

// --- device tools (native interaction via in-tree runners) ---

trackedTool(
  'device_list',
  'List all available iOS simulators and Android emulators. Returns device name, UDID, platform, and status. Use before device_snapshot action=open to confirm the target device.',
  {},
  createDeviceListHandler(),
);

trackedTool(
  'device_screenshot',
  'Capture the exact authority-bound device screen with no cross-device retry. Raw control requires exact install/device/runner authority but not a managed Metro target; meta.originAuthority explicitly reports proven or not-proven, and not-proven screenshots are never strict source evidence. Returns the file path; iOS failures preserve sanitized backend argv, exit/signal/timeout, stderr, output format/path, and a shortened receipt-bound device identity.',
  {
    path: z
      .string()
      .optional()
      .describe('Output file path (default: auto-generated in /tmp). Use .jpg extension for JPEG.'),
    format: z
      .enum(['jpeg', 'png'])
      .optional()
      .describe('Image format (default: auto-detect from path extension, or jpeg)'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
    maxWidth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Downscale image so width does not exceed this many pixels. 0 disables resize. Default 800 (saves ~46% on iPhone 15/17 Pro screenshots without losing label readability).',
      ),
    quality: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('JPEG compression quality (1-100). Only applied to .jpg/.jpeg files. Default 85.'),
  },
  createDeviceScreenshotHandler(getClient),
);

trackedTool(
  'device_snapshot',
  'Manage exact device sessions and capture UI snapshots even when a Dev Client remains at its native picker. Raw control requires exact install/device/runner authority but not a managed Metro target; meta.originAuthority explicitly reports proven or not-proven, and not-proven snapshots are never strict source evidence. action=open starts a session (required before other device_ tools), waits for Android app accessibility, and reports readiness.reactNativeUi=ready only when a matching live CDP helper confirms the RN fiber boundary; otherwise it warns that RN readiness is unverified. Pass deviceId to select an exact iOS simulator UDID or Android adb serial when devices run in parallel. action=snapshot returns the accessibility tree with @ref identifiers for device_press/device_fill. action=close ends the session. Use attachOnly=true on action=open to skip launching the app when it is already running (avoids relaunch-induced bundle races); liveness is checked only on the resolved exact device and refuses when that identity is unavailable.',
  {
    action: z
      .enum(['open', 'close', 'snapshot'])
      .default('snapshot')
      .describe(
        'open: start session for an app. snapshot: capture UI tree with element refs. close: end session.',
      ),
    appId: z
      .string()
      .optional()
      .describe('App bundle ID — required for action=open (e.g. "com.example.app")'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Target platform — used with action=open to select device'),
    deviceId: z
      .string()
      .optional()
      .describe('Exact iOS simulator UDID or Android adb serial to use for action=open'),
    sessionName: z.string().optional().describe('Session name override (default: auto-generated)'),
    attachOnly: z
      .boolean()
      .optional()
      .describe(
        'action=open only: skip launching the app. Requires the app to be already running. Use when connecting to an already-active dev session to avoid bundle-load races.',
      ),
  },
  createDeviceSnapshotHandler({
    bindRunner: (platform, deviceId, appId) =>
      bindNativeRunner(authorityRuntime, { platform, deviceId, appId }),
    unbindRunner: (beforeRelease) => unbindNativeRunner(authorityRuntime, beforeRelease),
    probeReactNativeUi: async (platform, deviceId, appId) => {
      const client = getClient();
      const filters = {
        platform,
        bundleId: appId,
        ...(platform === 'android'
          ? {
              deviceKind: deviceId.startsWith('emulator-')
                ? ('emulator' as const)
                : ('physical' as const),
            }
          : {}),
      };
      if (!client.isConnected || !client.helpersInjected) return false;
      if (!targetMatchesSession(client.connectedTarget, filters)) return false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const probe = await client
          .evaluate(
            'typeof globalThis.__RN_AGENT !== "undefined" && globalThis.__RN_AGENT.isReady() === true',
          )
          .catch(() => ({ value: false }));
        if (probe.value === true) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    },
  }),
);

trackedTool(
  'device_find',
  'Find a UI element by visible text and optionally interact with it. Android matching is app-window-only by default; includeSystemUi=true explicitly allows system chrome and may leave the app. Use action="click" to tap, omit for find-only. Returns element ref for use with device_press/device_fill. Requires an open session. For overlapping labels (e.g. "Property damaged" vs "Property lost"), pass exact=true for strict match or index=N to pick the Nth candidate directly — both short-circuit AMBIGUOUS_MATCH. If AMBIGUOUS_MATCH still occurs, the result includes a candidates[] array with refs you can pass to device_press.',
  {
    text: z.string().describe('Visible text, accessibility label, or identifier to find'),
    action: z
      .string()
      .optional()
      .describe('Action to perform: "click" to tap, omit for search-only'),
    exact: z
      .boolean()
      .optional()
      .describe('Require exact label match (case-sensitive). Skips fuzzy matching entirely.'),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Pick the Nth candidate (0-based) when multiple elements match. Short-circuits AMBIGUOUS_MATCH.',
      ),
    includeSystemUi: z
      .boolean()
      .optional()
      .describe('Include Android system UI in matching (default false; may leave the app).'),
  },
  createDeviceFindHandler(getClient),
);

trackedTool(
  'device_press',
  'Tap a UI element by its @ref from device_snapshot, or at explicit raw x/y coordinates. Exact raw control can operate without a managed Metro target and always labels meta.originAuthority as proven or not-proven; not-proven results are never strict source evidence. Pass exactly one target form. On iOS, a latest-snapshot Key/Keyboard ref is runner-validated against the current live keyboard and activated exactly once (meta.keyboardGuard="keyboard_target"); stale, forged, missing-keyboard, or raw-coordinate targets never receive that exemption. Ordinary app-content taps dismiss only through a safe native hide/dismiss control or optional JS tier, then refresh and uniquely re-resolve before one tap. Supports double-tap, repeated taps, long hold, and post-tap focus settle. Requires an open session. Stale ordinary app @refs self-heal by identity re-resolution (meta.reResolved); stale iOS Key/Keyboard refs refuse with KEYBOARD_TARGET_STALE and mutation:none. A command is never replayed after a possible dispatch; uncertain Android effects fail with one-attempt typed uncertainty. On Android the tap is scoped to the owned app window: a @ref belonging to another package (system navigation, IME, dialogs) is refused with OUTSIDE_APP_WINDOW — use device_find with includeSystemUi=true and action="click" for system UI.',
  {
    ref: z
      .string()
      .optional()
      .describe('Element ref from device_snapshot (e.g. "e3" or "@e3"). Omit when using x/y.'),
    x: z.number().optional().describe('Raw tap X coordinate; requires y and no ref'),
    y: z.number().optional().describe('Raw tap Y coordinate; requires x and no ref'),
    doubleTap: z.boolean().optional().describe('Use double-tap gesture'),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Repeat tap N times (for rapid-fire interactions)'),
    holdMs: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe('Hold duration in ms (for long-press via ref)'),
    waitForFocusMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe(
        'Sleep this many ms after tap to let keyboard focus settle — useful in sequential press+fill flows where focus would otherwise not propagate.',
      ),
    settleTimeoutMs: z
      .number()
      .int()
      .min(500)
      .max(30000)
      .optional()
      .describe(
        'Override the post-action settle budget in ms (default 6000). Settle waits for the UI to stabilize after the action; see meta.settle in the result. Budget knob only — RN_SETTLE=0 disables settle.',
      ),
    retryIfNoChange: z
      .boolean()
      .optional()
      .describe(
        'Deprecated compatibility option. Interactions are never automatically replayed after a possible dispatch; uncertainty is reported from the first attempt.',
      ),
  },
  createDevicePressHandler(getClient),
);

trackedTool(
  'device_fill',
  'Type text into an input field by its @ref or testID from device_snapshot, binding exactly one direct native TextInput or one `${name}-pressable` wrapper uniquely mapped to its inner `${name}` input before mutation. Exact raw control can operate without a managed Metro target and always labels meta.originAuthority as proven or not-proven. The tool skips the focus tap only when that exact input is already focused and returns filled:true ONLY after a stable exact native post-settle read-back (meta.verify is always "exact" on success). One operation token owns one native mutation and its read-back; mismatch or uncertainty refuses without resend, rebinding, React Fiber evidence, or Maestro. Unverifiable outcomes hard-fail: NO_TEXT_INPUT_TARGET means nothing was typed (rebind after a fresh snapshot); TEXT_ENTRY_UNVERIFIED means an attempt ran but the exact value could not be proven — check meta.mutation: "none" = safe to retry after a fresh snapshot; "observed" = the field holds a wrong value, take a fresh snapshot and re-read before a corrective fill; "possible" = do NOT retry the same ref — take a fresh device_snapshot, rebind the input by identity, and read its state first (a blind retry can double-type). Secure masked native values are never proof; empty text is a verified clear. Requires an open session.',
  {
    ref: z.string().describe('Input ref from device_snapshot (for example "@e5"), or a testID'),
    text: z.string().describe('Text to type into the field (empty string = verified clear)'),
    waitForKeyboardMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe(
        'Bounded wait for the exact input to gain focus after the in-operation focus tap (default 1500). Bump to 3000-5000ms for slow keyboard animations on Pressable-wrapped TextInputs.',
      ),
    testID: z
      .string()
      .optional()
      .describe(
        "Explicit exact target identity. Otherwise device_fill uses the fresh snapshot ref's nonblank testID.",
      ),
    settleTimeoutMs: z
      .number()
      .int()
      .min(500)
      .max(30000)
      .optional()
      .describe(
        'Deprecated compatibility option. Exact owner-local read-back supplies the bounded stability check.',
      ),
  },
  createDeviceFillHandler(getClient),
);

trackedTool(
  'device_swipe',
  'Swipe on the device screen. Use direction for simple scrolling, or x1/y1/x2/y2 for precise coordinate-based swipes (drag-to-reorder, bottom sheets). Pass exact: true for a precise unclamped gesture duration via the in-tree runner — needed for momentum-sensitive UIs like UIDatePicker wheels where a normalized/clamped duration causes overshoot. Requires an open session.',
  {
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .optional()
      .describe('Simple directional swipe (delegates to scroll)'),
    x1: z
      .number()
      .optional()
      .describe('Start X coordinate (use with y1, x2, y2 for precise swipes)'),
    y1: z.number().optional().describe('Start Y coordinate'),
    x2: z.number().optional().describe('End X coordinate'),
    y2: z.number().optional().describe('End Y coordinate'),
    durationMs: z
      .number()
      .int()
      .min(50)
      .max(10000)
      .optional()
      .describe(
        'Swipe duration in ms (slower = more precise, default ~300). Note: the non-exact path may normalize/clamp very short durations — use exact: true for an unclamped duration.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Repeat swipe N times (incompatible with exact: true)'),
    pattern: z
      .enum(['one-way', 'ping-pong'])
      .optional()
      .describe(
        'Repeat pattern: one-way (reset to start) or ping-pong (reverse direction). Incompatible with exact: true.',
      ),
    exact: z
      .boolean()
      .optional()
      .describe(
        'B123: REQUIRE fast-runner (no daemon fallback). Preserves user-supplied durationMs verbatim — needed for slow precise swipes on UIDatePicker wheels and similar momentum-sensitive UIs. Fails with EXACT_REQUIRES_FAST_RUNNER if fast-runner unavailable instead of silently degrading.',
      ),
  },
  createDeviceSwipeHandler(),
);

trackedTool(
  'device_back',
  'Press the system back button (Android) or perform back navigation gesture (iOS). Requires an open session.',
  {},
  createDeviceBackHandler(),
);

trackedTool(
  'device_longpress',
  'Long press on an element or coordinates. Use for context menus, drag initiation, or hold-to-delete. Requires an open session.',
  {
    ref: z.string().optional().describe('Element ref from device_snapshot (uses press --hold-ms)'),
    x: z.number().optional().describe('X coordinate (use with y for coordinate-based long press)'),
    y: z.number().optional().describe('Y coordinate'),
    durationMs: z
      .number()
      .int()
      .min(100)
      .max(10000)
      .optional()
      .describe('Hold duration in ms (default 1000)'),
    retryIfNoChange: z
      .boolean()
      .optional()
      .describe(
        'Deprecated compatibility option. Interactions are never automatically replayed after a possible dispatch; uncertainty is reported from the first attempt.',
      ),
  },
  createDeviceLongPressHandler(getClient),
);

trackedTool(
  'device_scroll',
  'Scroll the screen in a direction. Smoother than device_swipe for list scrolling. Requires an open session.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Scroll amount 0-1 (default ~0.5). 1 = full screen height/width.'),
  },
  createDeviceScrollHandler(),
);

trackedTool(
  'device_scrollintoview',
  'Scroll until a specific element becomes visible. Use for finding elements in long lists without knowing their position. Requires an open session.',
  {
    text: z.string().optional().describe('Visible text to scroll to'),
    ref: z.string().optional().describe('Element ref from device_snapshot to scroll to'),
  },
  createDeviceScrollIntoViewHandler(),
);

trackedTool(
  'device_pinch',
  'Pinch/zoom gesture on the screen. scale < 1 zooms out, scale > 1 zooms in. iOS simulator only. Requires an open session.',
  {
    scale: z
      .number()
      .min(0.1)
      .max(10)
      .describe('Pinch scale factor (0.5 = zoom out 50%, 2.0 = zoom in 2x)'),
    x: z.number().optional().describe('Center X coordinate (default: screen center)'),
    y: z.number().optional().describe('Center Y coordinate (default: screen center)'),
  },
  createDevicePinchHandler(),
);

trackedTool(
  'device_permission',
  'Grant, revoke, reset, or query permissions for the authority-bound app on the exact claimed device.',
  {
    action: z
      .enum(['grant', 'revoke', 'reset', 'query'])
      .describe(
        'grant: allow. revoke: deny. reset: restore default. query: check current state (Android: granted/denied/not_declared, iOS: unknown).',
      ),
    permission: z
      .string()
      .describe(
        'Permission key: notifications, camera, microphone, location, location-always, photos, contacts, calendar, reminders, storage, all',
      ),
    appId: z
      .string()
      .optional()
      .describe('Authority-bound app identifier; normally injected by the session'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
  },
  createDevicePermissionHandler(),
);

trackedTool(
  'device_reset_state',
  'Reset permissions/storage and relaunch the authority-bound app on its exact claimed device, then reconnect and re-prove the session target.',
  {
    appId: z
      .string()
      .optional()
      .describe('Authority-bound app identifier; normally injected by the session'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
    permissions: z
      .array(
        z.union([
          z.string(),
          z.object({
            name: z.string(),
            action: z.enum(['revoke', 'reset']).optional(),
          }),
        ]),
      )
      .optional()
      .describe(
        'Permissions to revoke/reset before relaunch. String shorthand defaults to revoke. Each entry is processed via device_permission.',
      ),
    storageKeys: z
      .array(z.string())
      .optional()
      .describe(
        'MMKV keys to delete before terminate (so the app reads cleared values on next launch). Skipped if CDP is not connected.',
      ),
    mmkvInstanceId: z
      .string()
      .optional()
      .describe('Forwarded to cdp_mmkv. Defaults to mmkv.default.'),
    relaunch: z.boolean().optional().describe('Launch the app after terminate. Default true.'),
    waitForReady: z
      .boolean()
      .optional()
      .describe(
        'After relaunch, wait for CDP reconnect + helpers injection. Default true. Set false to return immediately and let the caller poll.',
      ),
    waitForNavReady: z
      .boolean()
      .optional()
      .describe(
        'After helpers, also wait for globalThis.__NAV_REF__ to expose a non-empty navigation state. Default false.',
      ),
  },
  createDeviceResetStateHandler(getClient, { getSession: getActiveSession }),
);

trackedTool(
  'device_deeplink',
  'Open a deep link on the exact authority-bound iOS simulator or Android device. On an open iOS session, best-effort accepts the native SpringBoard Open confirmation and reports meta.openDialogTapped.',
  {
    url: z
      .string()
      .describe('URL to open, e.g. "myapp://claims/new" or "https://example.com/page".'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Authority-bound exact iOS simulator UDID or Android adb serial; normally injected by the session',
      ),
    metroPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe('Authority-bound Metro port used only for an exact picker row match'),
    packageName: z
      .string()
      .optional()
      .describe(
        '(Android only) Explicit package/activity, e.g. "com.example/.MainActivity". Usually not needed — intent resolution picks the right app.',
      ),
  },
  createDeviceDeeplinkHandler(),
);

trackedTool(
  'cdp_dismiss_dev_client_picker',
  'Dismiss the Expo Dev Client "Development servers" picker on demand. The picker is a native expo-dev-menu screen that blocks the JS bundle after deep links, restarts, permission changes, or clearState; this taps the Metro server entry (preferring the row matching the project\'s Metro port, deprioritizing stale link-local addresses) so CDP/the bundle can proceed. Also clears the native stale-server "Error loading app" dialog that can hide the picker after a network change. iOS + Android (requires an open device session — call device_snapshot action="open" first). Prefer this over a racy Maestro `runFlow when: visible: "DEVELOPMENT SERVERS"` block.',
  {
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
  },
  createDismissDevClientPickerHandler(() => getClient().metroPort, {
    isBundleBound: () => {
      const status = authorityRuntime.status();
      return status.available && Boolean(status.bindings.bundle);
    },
    isSessionRuntimeAbsent: isSessionRuntimeAbsent,
  }),
);

trackedTool(
  'device_accept_system_dialog',
  'Tap an OS-level accept button on the exact session device. iOS prefers the capability-bound native runner so SpringBoard-owned dialogs are reachable; DIALOG_BUTTON_NOT_FOUND returns availableButtons for an exact-label retry.',
  {
    label: z
      .string()
      .optional()
      .describe(
        'Specific button label to tap. Omit to try common defaults (Allow, OK, Open, Continue, Yes, Accept).',
      ),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .optional()
      .describe(
        'Whole fallback Maestro timeout (default 15000ms; explicit values up to 120000 accepted). Native iOS runner path is preferred.',
      ),
  },
  createDeviceAcceptSystemDialogHandler(),
);

trackedTool(
  'device_dismiss_system_dialog',
  'Tap an OS-level dismiss button through the capability-bound runner on the exact session device.',
  {
    label: z
      .string()
      .optional()
      .describe(
        'Specific button label to tap. Omit to try common defaults (Cancel, Don\u2019t Allow, Deny, No, Not Now).',
      ),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .optional()
      .describe(
        'Whole fallback Maestro timeout (default 15000ms; explicit values up to 120000 accepted).',
      ),
  },
  createDeviceDismissSystemDialogHandler(),
);

const resolveNativeProofDevice = async (): Promise<{
  id: string;
  name: string;
  osVersion: string;
} | null> => {
  const session = getActiveSession();
  if (!session?.deviceId) return null;
  if (session.platform === 'ios') {
    try {
      const { stdout } = await execFileP('xcrun', ['simctl', 'list', '-j', 'devices', 'booted']);
      const payload = JSON.parse(String(stdout)) as {
        devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
      };
      for (const [runtime, devices] of Object.entries(payload.devices ?? {})) {
        const device = devices.find(
          (candidate) =>
            candidate.udid === session.deviceId &&
            candidate.state === 'Booted' &&
            typeof candidate.name === 'string',
        );
        if (device?.name) {
          const version = runtime.match(/iOS[-.]([0-9.-]+)$/)?.[1]?.replaceAll('-', '.');
          if (version)
            return {
              id: session.deviceId,
              name: device.name,
              osVersion: version,
            };
        }
      }
    } catch {
      return null;
    }
  }
  if (session.platform === 'android') {
    try {
      const [{ stdout: model }, { stdout: version }] = await Promise.all([
        execFileP('adb', ['-s', session.deviceId, 'shell', 'getprop', 'ro.product.model']),
        execFileP('adb', ['-s', session.deviceId, 'shell', 'getprop', 'ro.build.version.release']),
      ]);
      const name = String(model).trim();
      const osVersion = String(version).trim();
      if (name && osVersion) return { id: session.deviceId, name, osVersion };
    } catch {
      return null;
    }
  }
  return null;
};

const proofReadiness = async (): Promise<ProofReadiness> => {
  const current = getClient();
  const target = current.connectedTarget;
  const session = getActiveSession();
  const metroEvents = current.metroEventsClient;
  let errors: unknown[] = [{ unavailable: true }];
  if (current.isConnected && current.helpersInjected) {
    const errorResult = await current.evaluate(current.helperExpr('getErrors()'));
    try {
      const parsed = typeof errorResult.value === 'string' ? JSON.parse(errorResult.value) : null;
      if (Array.isArray(parsed)) errors = parsed;
    } catch {
      // Unreadable errors keep the baseline dirty.
    }
  }
  const metroBuildPending = metroEvents?.lastBuild?.status === 'started';
  const metroBuildFailed =
    metroEvents?.lastBuild?.status === 'failed' || (metroEvents?.buildErrors ?? 0) > 0;
  const metroReady =
    current.isConnected &&
    (await probeMetro(current.metroPort)) &&
    !metroBuildPending &&
    !metroBuildFailed;
  const errorBytes = JSON.stringify(errors);
  const identity = resolveProofIdentity({
    session,
    target,
    nativeDevice: await resolveNativeProofDevice(),
    metroPort: current.metroPort,
    pluginVersion: pkgVersion,
    metroReady,
  });
  if (!identity) throw new Error('PROOF_DEVICE_IDENTITY_UNRESOLVED');
  return {
    cdpAttached: current.isConnected,
    helpersAttached: current.helpersInjected,
    metroReady,
    metroBuildPending,
    metroBuildFailed,
    metroEventsConnected: metroEvents?.isConnected === true,
    metroEventMarker: proofRuntimeAuthorityMarker({
      metroEventMarker: metroEvents?.authorityMarker ?? 'unavailable',
      targetId: target?.id ?? null,
      connectedAt: current.connectedAt,
    }),
    errorCount: errors.length,
    errorSha256: createHash('sha256').update(errorBytes).digest('hex'),
    device: identity.device,
    runtime: identity.runtime,
  };
};

function proofAuthority(runId: string): ProofAuthority {
  const { registry, session } = authorityRuntime.requireAvailable();
  const status = registry.getSessionStatus(session.sessionId);
  if (!status) throw new Error('PROOF_AUTHORITY_MISMATCH: session is unavailable');
  const controller = registry.getControllerBinding(session);
  const install = status.bindings.install as Record<string, unknown> | undefined;
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const bundle = status.bindings.bundle as Record<string, unknown> | undefined;
  const device = status.bindings.device as Record<string, unknown> | undefined;
  const runner = status.bindings.runner as Record<string, unknown> | undefined;
  if (
    !install ||
    !metro ||
    !bundle ||
    !device ||
    !runner ||
    !controller.worker.instanceId ||
    !controller.worker.pid ||
    !controller.worker.token
  ) {
    throw new Error('PROOF_AUTHORITY_MISMATCH: strict authority chain is incomplete');
  }
  if (metro.mode !== 'managed') {
    throw new Error(
      'STRICT_PROOF_UNMANAGED_METRO: strict proof requires Metro started by the managed launcher',
    );
  }
  const secret = process.env.RN_DEV_AGENT_SESSION_SECRET_PATH
    ? readJsonStateFile<{ signerCapability?: string }>(process.env.RN_DEV_AGENT_SESSION_SECRET_PATH)
    : null;
  if (
    !secret?.signerCapability ||
    !verifyManagedMetroManagementProof(metro, {
      sessionId: status.sessionId,
      signerCapability: secret.signerCapability,
    })
  ) {
    throw new Error('PROOF_AUTHORITY_MISMATCH: Metro management proof is invalid');
  }
  const source = strictProofSourceIdentity(status.source as unknown as SourceIdentity, {
    metroRuntimePolicy: {
      sessionId: status.sessionId,
      metroInstanceId: metro.instanceId,
      capability: createHmac('sha256', secret.signerCapability)
        .update('metro-runtime-policy')
        .digest('base64url'),
      evidencePath: metro.runtimeEvidencePath,
      evidenceSocket: metro.runtimeEvidenceSocket,
      evidenceAuthority: metro.runtimeEvidenceAuthority,
    },
  });
  const pendingProof = (status.bindings.proof as Record<string, unknown> | undefined)?.runId;
  return {
    sessionId: status.sessionId,
    claimEpoch: status.claimEpoch,
    authorityVersion: status.authorityVersion + (pendingProof === runId ? 0 : 1),
    controller: {
      instanceId: controller.worker.instanceId,
      pid: controller.worker.pid,
      birthDigest: hashProofValue(controller.worker.token),
    },
    source: {
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      head: source.head,
      dirtyDigest: source.dirtyDigest,
    },
    install: {
      artifactDigest: String(install.artifactDigest),
      buildGeneration: Number(install.buildGeneration),
      appId: String(install.appId),
    },
    metro: {
      port: Number(metro.port),
      instanceId: String(metro.instanceId),
      pid: Number(metro.pid),
      birthDigest: hashProofValue(String(metro.birth)),
      buildGeneration: Number(metro.buildGeneration),
      sandbox:
        metro.runtimeEvidenceAuthority === 'managed-sandbox-v1'
          ? 'managed-sandbox-v1'
          : 'unavailable',
    },
    bundle: {
      targetId: String(bundle.targetId),
      connectionGeneration: Number(bundle.connectionGeneration),
      markerDigest: hashProofValue(bundle),
      authorityScope: 'initial-bundle',
      sourceFidelity: 'not-proven',
    },
    device: {
      platform: device.platform as 'ios' | 'android',
      deviceId: String(device.deviceId),
    },
    runner: {
      instanceId: String(runner.instanceId),
      protocolVersion: Number(runner.protocolVersion),
      capabilityDigest: hashProofValue(String(runner.capability)),
      processBirthDigest: hashProofValue(String(runner.processBirth)),
    },
    proof: { runId },
  };
}

const proofCaptureHandler = createProofCaptureHandler({
  monitor: strictProofMonitor,
  projectRoot: () =>
    resolveProofWorktreeRoot(findProjectRoot({ bundleId: getActiveSession()?.appId })),
  readActionIdentity: (actionId) => {
    const appProjectRoot = findProjectRoot({
      bundleId: getActiveSession()?.appId,
    });
    return appProjectRoot ? readProofActionIdentity(appProjectRoot, actionId) : null;
  },
  getGitInfo: readProofGitInfo,
  proofRootTracked: proofRootHasTrackedEntries,
  readiness: proofReadiness,
  authority: proofAuthority,
  record: createDeviceRecordHandler(),
  mediaProcess: {
    run: async (command, args) => {
      const { stdout, stderr } = await execFileP(command, args, {
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  },
  validateMedia,
  now: () => new Date(),
  writeReceipt: writeProofReceiptAtomic,
  removeArtifact: (path) => rmSync(path, { force: true }),
});

trackedTool(
  'proof_capture',
  'Strict, stateful proof capture. Rehearses one pinned learned action, records the declared typed storyboard operations, validates result-bound screenshots and assertions, then writes an accepted receipt only after independent evidence review.',
  proofCapturePublishedInputSchema.shape,
  proofCaptureHandler,
);

trackedTool(
  'device_record',
  'Record the exact authority-bound device for proof capture. Start validates that the claimed device is currently available and always forwards its literal identifier.',
  {
    action: z
      .enum(['start', 'stop', 'status'])
      .describe(
        'start: begin recording. stop: finalize and save (all active recordings). status: list active recordings.',
      ),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    outputPath: z
      .string()
      .optional()
      .describe(
        '(start only) Absolute output path. Defaults to /tmp/rn-dev-agent-proof-<platform>-<timestamp>.mp4.',
      ),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
    gif: z
      .boolean()
      .optional()
      .describe('(stop only) When true, also convert each saved recording to GIF via ffmpeg.'),
    gifPath: z
      .string()
      .optional()
      .describe(
        '(stop only) Override GIF output path. Defaults to the recording path with .gif extension.',
      ),
  },
  createDeviceRecordHandler(),
);

trackedTool(
  'device_pick_value',
  'Select a value in a UIPickerView / Android picker wheel by tapping the target row. Works for any picker that exposes row labels via accessibility. If pickerTestId is provided, taps the picker open first. Known limitation: only works when the target value is already visible in the wheel window (scroll-to-visible is not yet implemented).',
  {
    value: z
      .string()
      .describe('The visible row label to select (e.g. "Claim damages", "Male", "USD")'),
    pickerTestId: z
      .string()
      .optional()
      .describe(
        'Optional testID of the picker itself — tapped first to ensure the picker is open.',
      ),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Force platform. Auto-detected if omitted.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .optional()
      .describe('Whole Maestro flow timeout (default 120000ms).'),
  },
  createDevicePickValueHandler(),
);

trackedTool(
  'device_pick_date',
  'Select a visible date in a UIDatePicker (wheels mode) / Android DatePicker with one authority-bound Maestro flow and one whole-flow timeout. Rejects impossible calendar dates. Native off-screen wheel scrolling remains tracked separately in issue #27; inline calendar mode is unsupported.',
  {
    date: z
      .string()
      .describe('Target date — YYYY-MM-DD or full ISO 8601. Time component is ignored.'),
    openerTestId: z
      .string()
      .optional()
      .describe('Optional testID of the control that opens the date picker.'),
    pickerTestId: z
      .string()
      .optional()
      .describe(
        'Deprecated openerTestId alias retained for compatibility; it does not scope row taps.',
      ),
    pickerScopeTestId: z
      .string()
      .optional()
      .describe('Optional picker-container testID used as childOf scope for month/day/year rows.'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Force platform. Auto-detected if omitted.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .optional()
      .describe('Whole Maestro flow timeout (default 120000ms; never divided by component count).'),
  },
  createDevicePickDateHandler(),
);

trackedTool(
  'device_focus_next',
  "Move keyboard focus to the next input field by tapping the soft keyboard's Next/Return/Done/Go button. Use in multi-field form flows where sequential device_press + device_fill calls leave focus stuck on the first field. Requires an open session and a visible keyboard.",
  {},
  createDeviceFocusNextHandler(),
);

trackedTool(
  'device_batch',
  'Execute a sequence of exact-device UI interactions in ONE tool call with the same meta.originAuthority proven/not-proven contract as individual raw native calls; not-proven batch output is never strict source evidence. Eliminates LLM round-trip overhead. Steps: find/press/fill (testID OR text/ref), scroll/swipe (direction), back, wait (ms), hideKeyboard, snapshot, screenshot. Pass `testID` on find/press/fill for fresh fiber-tree resolution per step (eliminates stale-ref-across-step-transitions failures from cached refs). Fails fast on error unless step has optional=true OR continueOnError is true at the batch level; a step TIMEOUT or failed fill with observed/possible mutation always aborts the batch because a later mutation would be unsafe.',
  {
    steps: z
      .array(
        z.object({
          action: z
            .enum([
              'find',
              'press',
              'fill',
              'swipe',
              'scroll',
              'back',
              'wait',
              'hideKeyboard',
              'snapshot',
              'screenshot',
            ])
            .describe('Step action'),
          text: z
            .string()
            .optional()
            .describe('(find) Visible text to match. (fill) Text to type into the field.'),
          ref: z
            .string()
            .optional()
            .describe(
              '(press/fill) Element ref from snapshot (e.g. "e5"). Beware: refs can go stale across step transitions; prefer testID for cross-step actions.',
            ),
          x: z
            .number()
            .optional()
            .describe('(press) Raw X coordinate; requires y and no ref/testID'),
          y: z
            .number()
            .optional()
            .describe('(press) Raw Y coordinate; requires x and no ref/testID'),
          testID: z
            .string()
            .optional()
            .describe(
              '(find/press/fill) PREFERRED exact identity. Fill still requires text and calls the same exact-fill coordinator as device_fill.',
            ),
          tap: z.boolean().optional().describe('(find) Tap the found element'),
          direction: z
            .enum(['up', 'down', 'left', 'right'])
            .optional()
            .describe('(scroll/swipe) Direction'),
          ms: z.number().optional().describe('(wait) Milliseconds to wait'),
          optional: z
            .boolean()
            .optional()
            .describe('Skip this step on failure instead of aborting (timeouts still abort)'),
          timeoutMs: z
            .number()
            .optional()
            .describe(
              'Per-step timeout override in ms. Default 15000. A timed-out step aborts the batch even when optional/continueOnError is set.',
            ),
          settle: z
            .boolean()
            .optional()
            .describe(
              'Default true: after this step mutates the screen, wait for the UI to stabilize (capped 2500ms; see meta.settle). Set false to skip the settle wait for this step (raw speed over stability).',
            ),
        }),
      )
      .describe('Ordered list of UI interaction steps'),
    delayMs: z
      .number()
      .optional()
      .describe(
        'Delay between steps in ms. Default: 0 while settle is on (settle waits for actual UI stability between steps), 300 when RN_SETTLE=0. Pass an explicit value to override either way.',
      ),
    screenshotOn: z
      .enum(['none', 'failure', 'end', 'each'])
      .default('failure')
      .describe('When to capture screenshots'),
    continueOnError: z
      .boolean()
      .default(false)
      .describe(
        'When true, ordinary failed steps are recorded and the batch continues. A failed fill with observed or possible mutation always stops later steps.',
      ),
    finalSnapshot: z
      .enum(['salient', 'full', 'none'])
      .default('salient')
      .describe(
        'Shape of the batch final_snapshot. salient (default): compact list of only actionable nodes (Button/TextField/Switch/etc) — far fewer tokens. full: complete node list (legacy). none: skip the implicit trailing snapshot entirely (~1,450 ms saved) for action-only batches you verify via expect_*/cdp_store_state.',
      ),
  },
  createDeviceBatchHandler(getClient),
);

trackedTool(
  'cdp_auto_login',
  'Explicit legacy navigation helper that detects an auth screen and runs one project login subflow through maestro_run on the authority-bound device. It is never login authority or PR proof; use cdp_login_prologue for authenticated journeys.',
  {
    appId: z
      .string()
      .optional()
      .describe('App bundle ID override (auto-detected from app.json if omitted)'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Platform override (auto-detected from session if omitted)'),
  },
  withConnection(getClient, async (args: { appId?: string; platform?: string }, client) => {
    return autoLoginToolResult(await handleAutoLogin(client, args));
  }),
);

trackedTool(
  'proof_step',
  'Atomic proof capture step: navigate to a screen (optional), wait for settlement, verify an element (optional), and take a screenshot. Combines 3-4 tool calls into one. Use in proof flows to reduce tool-call overhead.',
  {
    screen: z
      .string()
      .optional()
      .describe('Screen to navigate to (omit to stay on current screen)'),
    params: z.record(z.unknown()).optional().describe('Navigation params (e.g. { id: "1" })'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(1500)
      .describe('Settlement wait in ms (default 1500)'),
    verifyText: z
      .string()
      .optional()
      .describe('Visible text to verify on screen (uses device_find)'),
    verifyTestID: z
      .string()
      .optional()
      .describe('testID to verify in component tree (uses cdp_component_tree)'),
    screenshotPath: z
      .string()
      .optional()
      .describe('Output path for screenshot (default: auto-generated)'),
    label: z
      .string()
      .optional()
      .describe('Label for this proof step (e.g. "After adding item to cart")'),
  },
  createProofStepHandler(getClient),
);

const maestroRunHandler = createMaestroRunHandler({
  replayDeps: (args, signal) => makeReplayDeps(args, signal),
  getLiveRoute: () => readLiveRoute(getClient()),
  nativeVisionProbe: probeNativeVision,
});

trackedTool(
  'maestro_run',
  'Execute a validated flow using semantic proof-domain routing. On iOS, exact-testID React commands execute through the authority-bound React tree before WDA can claim selector truth; text/system/native-only commands remain XCTest, and mixed flows are partitioned before execution without React-to-XCTest correlation. Results label react-tree and xctest-native proof domains explicitly; a React-tree pass is never Maestro certification or proof of IME, AutoFill, keyboard occlusion, or native interaction fidelity. Android and native-only iOS flows use the pin-cache maestro-runner >= 1.1.24. Pass flowPath for an existing .yaml file or inlineYaml for an ephemeral flow.',
  {
    flowPath: z.string().optional().describe('Path to a .yaml flow file to execute'),
    inlineYaml: z
      .string()
      .optional()
      .describe('Inline YAML flow content (written to /tmp and executed)'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Target platform (auto-detected from session)'),
    appId: z.string().optional().describe('App bundle ID (auto-detected from app.json)'),
    appFile: z
      .string()
      .optional()
      .describe(
        'iOS only — path to a built .app/.ipa for maestro-runner to reinstall on clearState. Auto-resolved from the flow appId when omitted (GH#201).',
      ),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('Exact UDID or serial; defaults from session or Android ANDROID_SERIAL.'),
    timeoutMs: z
      .number()
      .int()
      .min(5000)
      .max(300000)
      .default(120000)
      .describe('Execution timeout in ms'),
    params: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'GH #116: parameter bindings forwarded as -e KEY=VALUE for ${KEY} placeholders in the flow. Keys must match /^[A-Z_][A-Z0-9_]*$/ (validated in the handler).',
      ),
  },
  maestroRunHandler,
);

trackedTool(
  'maestro_generate',
  'Generate a persistent Maestro YAML flow file from structured steps. Writes to .rn-agent/actions/<name>.yaml in the project root. Use after live verification to create reusable actions.',
  {
    name: z.string().describe('Flow name (e.g. "add-to-cart", "profile-edit"). Becomes filename.'),
    steps: z
      .array(
        z.object({
          action: z
            .enum([
              'tap',
              'fill',
              'assert',
              'scroll',
              'navigate',
              'back',
              'wait',
              'swipe',
              'launch',
            ])
            .describe('Step action'),
          testID: z.string().optional().describe('Target element testID'),
          text: z.string().optional().describe('Visible text to find/assert'),
          input: z.string().optional().describe('Text to input (for fill action)'),
          direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Swipe direction'),
          url: z.string().optional().describe('Deep link URL (for navigate action)'),
          waitMs: z.number().optional().describe('Wait duration in ms (for wait action)'),
        }),
      )
      .describe('Ordered list of Maestro steps'),
    appId: z.string().optional().describe('App bundle ID to include in YAML header'),
    outputDir: z
      .string()
      .optional()
      .describe(
        'Output directory (default: <project>/.rn-agent/actions/). Pass an explicit path for non-default targets.',
      ),
  },
  createMaestroGenerateHandler(),
);

trackedTool(
  'maestro_test_all',
  'Discover and run all Maestro flows in .rn-agent/actions/ as a regression suite. Owned iOS learned actions use the same React-tree/XCTest proof planner as maestro_run; other suites keep their native runner path. Returns per-flow pass/fail with durations. Use for CI or after refactoring to verify no regressions. Pass flowDir to override the default directory.',
  {
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Target platform (auto-detected from session)'),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Exact simulator UDID / adb serial to run the suite on (defaults to the active session device).',
      ),
    flowDir: z
      .string()
      .optional()
      .describe('Directory to scan for .yaml flows (default: <project>/.rn-agent/actions/)'),
    pattern: z
      .string()
      .optional()
      .describe('Regex pattern to filter flow files (e.g. "cart|checkout")'),
    timeoutPerFlow: z
      .number()
      .int()
      .min(5000)
      .max(300000)
      .default(120000)
      .describe('Timeout per flow in ms'),
    stopOnFailure: z.boolean().default(false).describe('Stop after first failure'),
  },
  createMaestroTestAllHandler({ runFlow: maestroRunHandler }),
);

// M6 / Phase 112 (D669): Object.freeze test recorder.
trackedTool(
  'cdp_record_test_start',
  'Start recording UI interactions via Object.freeze interceptor. Captures taps, long-presses, text input, submits, and scroll-derived swipes from the running app — no app changes required. Requires __DEV__=true (release builds pre-freeze props at bundle time). Pair with cdp_record_test_stop and cdp_record_test_generate to produce Maestro YAML or Detox JS.',
  {},
  createRecordTestStartHandler(getClient),
);

trackedTool(
  'cdp_record_test_stop',
  'Stop recording, deduplicate consecutive type/tap bursts, freeze the buffer, and return event count + per-type breakdown. Sets `truncated: true` when the 500-event cap was hit. Recorded events stay in MCP memory for cdp_record_test_generate / cdp_record_test_save until the next start.',
  {},
  createRecordTestStopHandler(getClient),
);

trackedTool(
  'cdp_record_test_generate',
  'Render the stored recording as replayable test code. Formats: maestro (YAML, primary), detox (JS). Appium returns NOT_IMPLEMENTED — file an issue if you need it. Requires a recording in memory (call start/stop or load first). Pass id/intent/tags/mutates/status to emit the M7 metadata header and required engine pin into the YAML so the result is a first-class reusable action.',
  {
    format: z.enum(['maestro', 'detox', 'appium']).describe('Output format'),
    testName: z.string().optional().describe('Name shown in describe()/comment header'),
    bundleId: z.string().optional().describe('App bundle ID for the Maestro appId header'),
    id: z
      .string()
      .optional()
      .describe(
        'M7 action id (stable slug). When set, emitted as `# id: <slug>` header line. Default: filename without `.yaml`.',
      ),
    intent: z
      .string()
      .optional()
      .describe('M7 one-line goal. When set, emitted as `# intent: <intent>` header line.'),
    tags: z
      .array(z.string())
      .optional()
      .describe('M7 filterable tags. When set, emitted as `# tags: [a, b, c]`.'),
    mutates: z
      .boolean()
      .optional()
      .describe('M7 side-effect flag. When set, emitted as `# mutates: true|false`.'),
    status: z
      .enum(['experimental', 'active', 'deprecated'])
      .optional()
      .describe('M7 lifecycle status. When set, emitted as `# status: <status>`.'),
  },
  createRecordTestGenerateHandler(),
);

trackedTool(
  'cdp_record_test_annotate',
  'Push a human-readable note into the live event stream — appears as a comment in generated tests. Useful for marking flow checkpoints ("reached checkout", "error appeared"). Only valid during an active recording.',
  {
    note: z.string().min(1).describe('Annotation text'),
  },
  createRecordTestAnnotateHandler(getClient),
);

trackedTool(
  'cdp_record_test_save',
  'Persist current recording events to <projectRoot>/.rn-agent/recordings/<filename>.json. Filename is sanitized (only [a-zA-Z0-9_-] kept). Use cdp_record_test_load to restore later for re-generation in a different format.',
  {
    filename: z.string().min(1).describe('Recording name (without .json — sanitized)'),
  },
  createRecordTestSaveHandler(getClient),
);

trackedTool(
  'cdp_record_test_load',
  'Restore a previously-saved recording from <projectRoot>/.rn-agent/recordings/. Replaces any in-memory events. After loading, call cdp_record_test_generate to render in any format.',
  {
    filename: z.string().min(1).describe('Recording name (without .json)'),
  },
  createRecordTestLoadHandler(getClient),
);

trackedTool(
  'cdp_record_test_list',
  'List saved recordings under <projectRoot>/.rn-agent/recordings/. Returns the directory path and an array of recording names (without .json extension), sorted alphabetically.',
  {},
  createRecordTestListHandler(getClient),
);

trackedTool(
  'cdp_restart',
  'Reset and reconnect the authority-bound Hermes client. hardReset relaunches only the exact claimed iOS simulator or Android device/app; success requires a fresh signed runtime binding committed under the operation fence.',
  {
    metroPort: z
      .number()
      .optional()
      .describe('Authority-bound Metro port; conflicting values are refused'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
    appId: z
      .string()
      .optional()
      .describe('Authority-bound exact app identifier; normally injected by the session'),
    hardReset: z
      .boolean()
      .optional()
      .describe(
        'Relaunch the exact session app on its claimed iOS or Android device before reconnecting.',
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        'Compatibility alias for the authority-bound appId; conflicting values are refused.',
      ),
  },
  createRestartHandler(getClient, setClient, createClient, {
    stopFastRunner: async (_deviceId) => {
      const { registry, session } = authorityRuntime.requireAvailable();
      const status = registry.getSessionStatus(session.sessionId);
      const runner = status?.bindings.runner as Record<string, unknown> | undefined;
      if (runner) {
        await stopBoundRunner(runner);
        clearFastRunnerAfterVerifiedStop(runner);
      }
    },
    unbindRunner: () => unbindNativeRunner(authorityRuntime),
  }),
);

trackedTool(
  'cross_platform_verify',
  'Compare UI elements across iOS and Android. Reads cached accessibility snapshots from both platforms (populated by device_snapshot) and checks which elements are present on each. Workflow: test on iOS → device_snapshot → switch to Android → device_snapshot → cross_platform_verify. Supports auto-discovery of testIDs from source via scanDir. Returns a per-element comparison table with PASS/FAIL verdict.',
  {
    elements: z
      .array(z.string())
      .optional()
      .describe(
        'List of testIDs or labels to check on both platforms. Optional if scanDir is provided.',
      ),
    scanDir: z
      .string()
      .optional()
      .describe(
        'Directory to scan for testID="..." props in .tsx/.jsx/.ts/.js files. Auto-discovers elements. Merges with elements[] if both provided.',
      ),
    matchBy: z
      .enum(['testID', 'label', 'any'])
      .default('any')
      .describe(
        'Match strategy: testID (exact identifier match), label (substring in accessibility label), any (try both)',
      ),
  },
  createCrossPlatformVerifyHandler({
    validateAuthority: validateCachedSnapshotEvidenceAuthority,
  }),
);

trackedTool(
  'cdp_open_devtools',
  'Report the React Native DevTools frontend URL for the live app + start a multiplexer proxy so DevTools can coexist with the MCP session on RN < 0.85 (RN >= 0.85 uses native multi-debugger). The proxy auto-resumes across reconnects. Returns { devtoolsUrl, inspectorWsUrl, hermesWsUrl, mode: "native" | "proxy-active", proxyPort, supportsMultipleDebuggers, rnVersion, guidance }.',
  {},
  createOpenDevToolsHandler(getClient),
);

trackedTool(
  'cdp_metro_events',
  'Read Metro reporter events (bundle_build_started, bundle_build_done, bundle_build_failed, reloads) captured since the MCP connected. The MetroEventsClient attaches a second WebSocket alongside CDP, giving push-based visibility into bundler state — watch for build errors without having to read console.error. Returns { eventsConnected, lastBuild, buildErrors, events, count }. Pass `clearErrors: true` to reset the build-error counter.',
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Max entries to return (default 20, max 100)'),
    type: z.string().optional().describe('Filter by event type (e.g. "bundle_build_failed")'),
    clearErrors: z
      .boolean()
      .default(false)
      .describe('Reset the build-error counter without reading events'),
  },
  createMetroEventsHandler(getClient),
);

// D1206 Tier 2 Sprint B / Phase 126 — Macro-Asserts.
// State-assertive primitives that wrap CDP introspection with assertion
// semantics. The differentiated capability over Maestro Cloud / KaneAI /
// BrowserStack — visual-only test runners cannot read Redux state or
// navigation params mid-flow.

trackedTool(
  'expect_redux',
  'Assert against Redux/Zustand store state at a path. Returns ok when the assertion matches; failResult with code=ASSERTION_FAILED when it does not. Operators (compose with AND): equals (deep), exists (default if no other op), notExists, length (array/string), contains (array), gt/lt/gte/lte (numbers). Pass timeoutMs to retry until match — useful when the store updates asynchronously after a tap. Differentiated capability over Maestro: Maestro asserts pixels; this asserts internal state.',
  {
    path: z
      .string()
      .describe('Dot-path into the store, e.g. "cart.items" or "auth.user.id". Required.'),
    storeType: z
      .string()
      .optional()
      .describe(
        'Restrict to a specific store ("redux" | "zustand" | a Zustand store name). Default: auto-detect.',
      ),
    equals: z.unknown().optional().describe('Deep-equal against this value.'),
    exists: z
      .boolean()
      .optional()
      .describe(
        'When true, value must be defined and non-null. When false, value must be undefined or null. Implicit default if no other operator is supplied.',
      ),
    notExists: z.boolean().optional().describe('Inverse of exists.'),
    length: z
      .number()
      .int()
      .optional()
      .describe('Asserts (Array | string).length === this number.'),
    contains: z
      .unknown()
      .optional()
      .describe('Asserts an array contains this element (deep-equal).'),
    gt: z.number().optional().describe('Asserts actual > this number.'),
    lt: z.number().optional().describe('Asserts actual < this number.'),
    gte: z.number().optional().describe('Asserts actual >= this number.'),
    lte: z.number().optional().describe('Asserts actual <= this number.'),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Polling timeout in ms (default 0 = no retry). Useful for async state updates.'),
  },
  createExpectReduxHandler(getClient),
);

trackedTool(
  'expect_route',
  "Assert against the navigation state — current route name, current route params, or a route's presence in the stack. Returns ok when the assertion matches; failResult with code=ASSERTION_FAILED otherwise. Differentiated capability over Maestro: Maestro doesn't know what route you're on, only what's rendered. Pass timeoutMs to retry through navigation animations.",
  {
    name: z.string().optional().describe('Asserts the current top-of-stack route name === this.'),
    paramsEquals: z
      .unknown()
      .optional()
      .describe('Asserts deep-equal against the current route params object.'),
    inStack: z
      .string()
      .optional()
      .describe(
        'Asserts a route with this name exists somewhere in the stack (not necessarily current).',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Polling timeout in ms (default 0). Use 1000-2000 to wait through navigation animations.',
      ),
  },
  createExpectRouteHandler(getClient),
);

trackedTool(
  'expect_visible_by_testid',
  'Assert that an element with a given testID is (or is not) currently rendered in the device accessibility tree. Snapshot-based — re-resolves on each retry. Pass exists=false to assert NOT visible. Pass timeoutMs to wait through animations / late mounts. Convenience wrapper over device_snapshot + manual scan.',
  {
    testID: z.string().describe('The testID to look for in the accessibility tree.'),
    exists: z
      .boolean()
      .optional()
      .describe('Default true (assert visible). Pass false to assert NOT visible.'),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Polling timeout in ms (default 0). Use 1000-3000 for late-mounted elements.'),
  },
  createExpectVisibleByTestIDHandler(),
);

trackedTool(
  'expect_text',
  'Assert that visible text is (or is not) currently rendered in the device accessibility tree. Default substring match; pass exact=true for full-string match. Pass exists=false to assert NOT visible. Convenience wrapper over device_snapshot + label scan; equivalent to Maestro\'s assertVisible: "..." but callable mid-batch and during interactive walks without leaving the LLM context.',
  {
    text: z.string().describe('The visible text to look for.'),
    exact: z
      .boolean()
      .optional()
      .describe('Default false (substring match). Pass true to require exact label equality.'),
    exists: z
      .boolean()
      .optional()
      .describe('Default true (assert visible). Pass false to assert NOT visible.'),
    timeoutMs: z.number().int().min(0).optional().describe('Polling timeout in ms (default 0).'),
  },
  createExpectTextHandler(),
);

// D1206 Tier 2 Sprint D-2 / Phase 130 — L2→L3 auto-emission. After an
// interactive walk completes, this turns the recorder buffer into a
// first-class L3 reusable action: emits Maestro YAML with full M7
// metadata header at <project>/.rn-agent/actions/<id>.yaml AND
// initialises the sidecar runtime state. Closes the L2→L3 loop.

trackedTool(
  'cdp_record_test_save_as_action',
  'Promote the in-memory recording (started via cdp_record_test_start) into a first-class L3 reusable action. Writes Maestro YAML with full M7 metadata header (id, intent, tags, mutates, status, enginePin, produces) to <project>/.rn-agent/actions/<id>.yaml and initialises the sidecar runtime state. Status defaults to "experimental" — first clean /run-action replay auto-promotes to "active". Refuses if the id already exists unless overwrite=true. Distinct from cdp_record_test_save (which writes JSON to .rn-agent/recordings/) — that is for raw event archival; this is for shipping the recording as a replayable action. The optional `produces` field (D1209) records state postconditions — what state the action establishes when it runs cleanly — so downstream tasks can use it as a deterministic prologue.',
  {
    id: z
      .string()
      .describe(
        'Stable slug; becomes the filename and the M7 id field. Lower-case kebab-case (a-z, 0-9, hyphen).',
      ),
    intent: z
      .string()
      .describe('One-line goal — surfaced verbatim by /list-learned-actions. Required.'),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Lower-case kebab-case keywords for filtering (e.g. ["tasks", "create", "regression"]).',
      ),
    mutates: z
      .boolean()
      .optional()
      .describe(
        'Does this flow leave persistent residue (created rows, toggled settings)? Required for /run-action safety pre-flight to know whether to confirm before replay.',
      ),
    status: z
      .enum(['experimental', 'active', 'deprecated'])
      .optional()
      .describe(
        'M7 lifecycle status. Default: experimental (auto-promotes on first clean replay).',
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        'App bundle ID for the Maestro appId header. Strongly recommended — /run-action uses it to refuse cross-app replays.',
      ),
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        'If an action with this id already exists, replace it. Default false (refuse with hint).',
      ),
    testName: z
      .string()
      .optional()
      .describe(
        'Optional one-line description shown as a comment above the M7 header. Falls back to intent.',
      ),
    produces: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        'D1209 — state postconditions this action establishes when it runs cleanly. Flat map of primitive values for hybrid composition (e.g. { authenticated: true, route: "home" }). Optional. Values containing commas or newlines are not supported; use multiple keys instead.',
      ),
  },
  createSaveAsActionHandler(),
);

// D1206 Tier 2 Sprint D / Phase 129 — L3→L2 self-repair. When a Maestro
// flow fails with "element not found", this tool patches the YAML in place
// using fuzzy matching against the current device snapshot. Drives the
// "self-recoverable on UI changes" L3 promise in D1206.

trackedTool(
  'cdp_repair_action',
  'Repair a learned action using a fresh snapshot from the exact authority-bound device and capability-bound native runner.',
  {
    actionId: z.string().describe('Owned action id; resolves one .yaml or .yml file.'),
    failedSelector: z
      .string()
      .describe(
        'The testID that the prior maestro_run reported as missing. Parse it from stderr like "Element with id \'X\' not found" → X.',
      ),
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Fuzzy-match similarity threshold (0..1). Default 0.6. Lower if the screen has many similar testIDs and Levenshtein on the original is too strict.',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "Don't write changes — return the diff that WOULD be applied. Useful for previewing repairs before committing.",
      ),
    agentReasoning: z
      .string()
      .optional()
      .describe(
        'Free-form one-liner the agent records in the RepairRecord. Helps audit "why did this repair happen". Max ~200 chars recommended.',
      ),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe('Authority-bound platform; conflicting values are refused'),
    deviceId: z
      .string()
      .optional()
      .describe('Authority-bound exact device identifier; normally injected by the session'),
    appId: z
      .string()
      .optional()
      .describe('Authority-bound app identifier; normally injected by the session'),
  },
  createRepairActionHandler(),
);

// Issue #104 — auto-repair-aware action replay. Wraps maestro_run with
// stderr classification + cdp_repair_action retry on SELECTOR_NOT_FOUND.
const runActionHandler = createRunActionHandler({
  maestroRun: maestroRunHandler,
  getLiveRoute: () => readLiveRoute(getClient()),
  targetContext: getActiveSession,
  claimBundleAuthority: claimOptionalBundleAuthority,
});

trackedTool(
  'cdp_run_action',
  'Replay a learned action by id with end-to-end auto-repair. On iOS, the validated flow is partitioned before execution: exact-testID commands use the authority-bound React-tree prover, while native-only commands use XCTest. The RunRecord and result preserve the reported proof domain, and a react-tree pass never promotes an experimental action to Maestro-certified active status. Ordinary missing React testIDs remain TESTID_NOT_FOUND; native selector misses remain ordinary Maestro failures unless direct bounded evidence proves a NATIVE_SURFACE_BLIND environment. Pass autoRepair=false to opt out of selector repair. proofReplay=true is reserved for proof-capture rehearsal and writes no runtime state.',
  {
    actionId: z.string().describe('Owned action id; resolves one .yaml or .yml file.'),
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    platform: z
      .enum(['ios', 'android'])
      .optional()
      .describe(
        'Force a specific platform; otherwise auto-detected from the active device session.',
      ),
    appFile: z
      .string()
      .optional()
      .describe(
        "GH #705: path to the .app Maestro reinstalls from after a clearState uninstall. Normally omit it — an iOS clearState flow resolves the bundle from the session's attested install receipt, and the receipt is re-issued after the reinstall so later device_*/maestro_run calls keep working.",
      ),
    autoRepair: z
      .boolean()
      .optional()
      .describe(
        'Auto-repair on SELECTOR_NOT_FOUND failures. Default true. Pass false to disable (e.g. when investigating a failure manually).',
      ),
    timeoutMs: z
      .number()
      .optional()
      .describe('Maestro execution timeout per attempt (ms). Default 120_000.'),
    trigger: z
      .enum(['agent', 'ci', 'human'])
      .optional()
      .describe('RunRecord trigger annotation. Default "agent". CI calls should pass "ci".'),
    forceReload: z
      .boolean()
      .optional()
      .describe(
        'GH #173: when true (default), acknowledge any human edit to the YAML as the new baseline before running so downstream repair does not abort with STALE_TARGET. Pass false for the strict Phase 129 "respect external edits" behavior (useful for CI replays of fixed baselines).',
      ),
    proofReplay: z
      .boolean()
      .optional()
      .describe(
        'Read-only proof rehearsal mode. Requires autoRepair=false and forceReload=false; never writes action YAML, runtime sidecar, or DB state.',
      ),
    params: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Parameter bindings for the action's ${VAR} placeholders, forwarded to maestro as -e KEY=VALUE on the first attempt AND the post-repair retry (GH #116). Keys must match /^[A-Z_][A-Z0-9_]*$/ (validated in maestro_run).",
      ),
  },
  runActionHandler,
);

trackedTool(
  'cdp_login_prologue',
  'Fail-stop user-login helper: replay the exact action and require a fresh passing RunRecord; failure blocks exploratory fallback mutations, and a pass is not PR proof.',
  {
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    platform: z.enum(['ios', 'android']).optional().describe('Override the bound platform.'),
    appFile: z.string().optional().describe('iOS app artifact for clearState actions.'),
    timeoutMs: z.number().optional().describe('Saved-action timeout in milliseconds.'),
    trigger: z.enum(['agent', 'ci', 'human']).optional().describe('Run trigger; default agent.'),
    params: z.record(z.string(), z.string()).optional().describe('String user-login bindings.'),
  },
  createLoginPrologueHandler({ runAction: runActionHandler }),
);

trackedTool(
  'cdp_lock_e2e_test',
  'Promote a verified action into a frozen, locked e2e regression test. Runs the action once strict (no repair); freezes it only if it passes. v1 supports param-free actions only.',
  {
    actionId: z.string().describe('The action id under .rn-agent/actions to lock'),
    relock: z.boolean().optional().describe('Overwrite an existing locked test'),
    projectRoot: z.string().optional(),
  },
  createLockE2eTestHandler({ maestroRun: maestroRunHandler }),
);

const e2ePreflight = async (): Promise<ReturnType<typeof preflight>> => {
  const session = getActiveSession();
  const platform = session?.platform ?? 'ios';
  const metroReachable = await probeMetro(getClient().metroPort);
  let udid: string | null;
  let appInstalled: boolean | null = null;
  if (platform === 'android') {
    udid = session?.deviceId ?? null;
  } else {
    udid = (await resolveIosUdid(session?.deviceId)) ?? null;
    appInstalled = udid && session?.appId ? await probeAppInstalled(udid, session.appId) : null;
  }
  return preflight({
    platform,
    udid,
    appId: session?.appId,
    metroReachable,
    appInstalled,
  });
};

const e2eReload = async (): Promise<boolean> => {
  if (!getClient().isConnected) return false;
  const session = getActiveSession();
  if (!session?.deviceId || !session.appId) return false;
  // GH #625: recoverAfterFailedReconnect only engages exact-device recovery
  // when platform+deviceId+appId are ALL present — omitting platform silently
  // downgraded recovery to device-blind platform+bundle filters.
  const sessionPlatform =
    session.platform === 'ios' || session.platform === 'android' ? session.platform : undefined;
  try {
    const r = await createReloadHandler(
      getClient,
      setClient,
      createClient,
    )({
      full: true,
      ...(sessionPlatform ? { platform: sessionPlatform } : {}),
      deviceId: session.deviceId,
      appId: session.appId,
    });
    return (JSON.parse(r.content[0].text) as { ok?: boolean })?.ok === true;
  } catch {
    return false;
  }
};

const e2eSuiteHandler = createRunE2eSuiteHandler({
  maestroRun: maestroRunHandler,
  preflightCheck: e2ePreflight,
  runReload: e2eReload,
  onProgress: (c: number, t: number, id: string) =>
    recorder.push({
      type: 'e2e-progress',
      completed: c,
      total: t,
      lastTestId: id,
    }),
});

trackedTool(
  'cdp_run_e2e_suite',
  'Run locked e2e tests strictly on the authority-bound session device and persist a session-scoped report.',
  {
    pattern: z.string().optional().describe('Regex filter over locked-test ids'),
    projectRoot: z.string().optional(),
    deviceId: z.string().optional(),
  },
  e2eSuiteHandler,
);

const e2eCsrfToken = makeCsrfToken();

// GH #637: bound-session app root wins; unprovable roots refuse truthfully.
const observeRootResolver = createObserveRootResolver({
  sessionAppRoot: () => {
    const status = authorityRuntime.status();
    if (!status.available) return null;
    const appRoot = status.source['appRoot'];
    return typeof appRoot === 'string' && appRoot.length > 0 ? appRoot : null;
  },
  sessionAppId: () => getActiveSession()?.appId ?? null,
  explicitEnvRoot: () => process.env.RN_PROJECT_ROOT ?? null,
  heuristicRoot: (bundleId) => findProjectRoot({ bundleId }),
  matchingRoots: collectMatchingRnProjects,
  isProject: isRnProject,
  projectBundleId: readProjectBundleId,
});
const projectRootFor = (): string => {
  const resolved = observeRootResolver();
  if (!resolved.ok) throw new ObserveRootUnavailableError(resolved.reason);
  return resolved.root;
};

const triggerE2eRun = async (args: RunE2eSuiteArgs): Promise<unknown> => {
  const L = arbiter.tryAcquire('flow', 'cdp_run_e2e_suite');
  if (!L.ok) return { ok: false, error: 'a flow is already running', code: L.code };
  try {
    args.projectRoot = projectRootFor();
    const r = await e2eSuiteHandler(args);
    const env = JSON.parse(r.content[0].text) as {
      ok?: boolean;
      data?: { runId?: string | null; verdict?: string | null };
    };
    recorder.push({
      type: 'e2e-done',
      runId: env.data?.runId ?? null,
      verdict: env.data?.verdict ?? null,
    });
    return env;
  } finally {
    arbiter.release(L.lease);
  }
};

const observeRunActionHandler = authorityGate.wrap(
  'cdp_run_action',
  runActionHandler as (...args: unknown[]) => Promise<unknown>,
);
const observeTriggerRun = authorityGate.wrap('cdp_run_e2e_suite', async (...raw: unknown[]) => {
  const args = (raw[0] ?? {}) as RunE2eSuiteArgs;
  return okResult(await triggerE2eRun(args));
});
const gatedObserveState = (
  tool: string,
  handler: (...args: unknown[]) => Promise<unknown>,
  args: Record<string, unknown>,
): Promise<import('./utils.js').ToolResult> =>
  authorityGate.wrap(tool, handler)(args) as Promise<import('./utils.js').ToolResult>;

setObserveE2eDeps({
  token: e2eCsrfToken,
  triggerRun: async (pattern) => {
    projectRootFor();
    return observeTriggerRun({ pattern });
  },
  listRuns: async () => loadIndex(projectRootFor()),
  loadRun: async (id: string) => loadRunRecord(projectRootFor(), id),
  listActions: async () => listActions(projectRootFor()),
  runAction: async (actionId: string, params?: Record<string, string>) => {
    let root: string;
    try {
      root = projectRootFor();
    } catch (e: unknown) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const action = loadAction(root, actionId);
    if (!action) return { ok: false as const, error: `action not found: ${actionId}` };
    const required = action.metadata.params ?? [];
    if (required.length > 0) {
      const config = loadE2eConfig(root);
      const resolved = resolveParams(config, actionId, required, params);
      if (!resolved.ok) return { ok: false as const, missingParams: resolved.missing };
      params = resolved.params;
    }
    const L = arbiter.tryAcquire('flow', `observe-run-action:${actionId}`);
    if (!L.ok) return { ok: false as const, error: 'device busy' };
    try {
      const result = (await observeRunActionHandler({
        actionId,
        params,
        projectRoot: root,
        platform: (getActiveSession()?.platform ?? 'ios') as 'ios' | 'android',
        trigger: 'human',
      })) as import('./utils.js').ToolResult;
      const text = result.content?.[0]?.text ?? '';
      return result.isError
        ? { ok: false as const, error: text }
        : { ok: true as const, output: text };
    } catch (e: unknown) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      arbiter.release(L.lease);
    }
  },
});

// GH #579: raw handlers on purpose — UI reads must not emit recorder/strict-proof events.
setObserveStateDeps({
  read: buildStateRead({
    acquire: () => {
      const r = arbiter.tryAcquire('introspection', 'observe-state-read');
      return r.ok
        ? { ok: true, release: () => arbiter.release(r.lease) }
        : { ok: false, code: r.code };
    },
    handlers: {
      route: () =>
        gatedObserveState(
          'cdp_navigation_state',
          createNavigationStateHandler(getClient, { annotate: false }) as (
            ...args: unknown[]
          ) => Promise<unknown>,
          {},
        ),
      store: () =>
        gatedObserveState(
          'cdp_store_state',
          createStoreStateHandler(getClient) as (...args: unknown[]) => Promise<unknown>,
          {},
        ),
      tree: () =>
        gatedObserveState(
          'cdp_component_tree',
          createComponentTreeHandler(getClient) as (...args: unknown[]) => Promise<unknown>,
          { depth: 4 },
        ),
    },
  }),
});

// B76/D644: unified process-lifecycle shutdown. All termination signals + stdin.end
// funnel into this graceful path so the 5s background-poll setInterval in
// reconnection.ts (the zombie cause) is cleared on every exit.
// GH #182 (mirror subsystem): stopMirrorFn reaps idb/ffmpeg/simctl capture children
// via MirrorManager.shutdown() — synchronous + idempotent, safe to call from here
// and again from the process.on('exit') net below.
const shutdown = diagnosticContractProbe
  ? async (exitCode: number): Promise<void> => process.exit(exitCode)
  : buildGracefulShutdown({
      getClient,
      stopFastRunnerFn: stopFastRunner,
      stopMirrorFn: () => mirrorManager?.shutdown(),
    });

process.on('uncaughtException', (err: Error) => {
  logger.error('MCP', `Uncaught exception: ${err.message}`);
  void shutdown(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn('MCP', `Unhandled rejection (non-fatal): ${msg}`);
});

process.on('SIGTERM', () => {
  logger.info('MCP', 'SIGTERM');
  void shutdown(0);
});
process.on('SIGINT', () => {
  logger.info('MCP', 'SIGINT');
  void shutdown(0);
});
process.on('SIGHUP', () => {
  logger.info('MCP', 'SIGHUP');
  void shutdown(0);
});
// SIGUSR2: hot-reload intent — exit 1 signals a supervisor to respawn. Today CC
// doesn't auto-respawn MCP subprocesses (B76 notes) so this is the clean-exit path
// for future supervisor wiring. Developers should use cdp_restart for in-session reset.
// NOTE: we deliberately avoid SIGUSR1 here because Node reserves it for the built-in
// inspector — running the MCP under `node --inspect` would both start the debugger
// AND trigger our shutdown. SIGUSR2 is collision-free.
process.on('SIGUSR2', () => {
  logger.info('MCP', 'SIGUSR2 — hot-reload intent');
  void shutdown(1);
});

// stdin.end is the primary zombie-prevention path: CC closes the stdio pipe on quit
// without sending SIGTERM, and the 5s bgPoll interval would keep the event loop alive
// forever. Explicitly shut down on stdin EOF. The listener itself is registered early
// (passive — doesn't flip stdin into flowing mode); StdioServerTransport flips the
// stream inside transport.start() when server.connect() runs, so 'end' fires reliably.
process.stdin.on('end', () => {
  logger.info('MCP', 'stdin closed — host disconnected');
  void shutdown(0);
});

// GH #182: belt-and-suspenders host-death detection + lock heartbeat. stdin-EOF +
// signals can silently fail to fire when CC dies abnormally (SIGKILL/crash/window
// close on macOS) without closing the child's stdin — leaving a LIVE orphan that
// holds the single-instance lock for up to 24h (the PID-alive reclaim can't catch a
// live process). Poll getppid(): on orphan (PPID changed from startup → parent died
// + reparented) self-exit + release. On a live parent, refresh the lock heartbeat —
// and if touch() reports we were usurped (a contender reclaimed our slot while the
// laptop slept, then we woke), self-terminate so we don't run as a second bridge on
// the same device. Unref'd timer — never keeps a should-be-dead process alive.
const stopParentWatch = diagnosticContractProbe
  ? () => {}
  : startParentDeathWatch({
      onOrphaned: () => {
        logger.info('MCP', 'parent host gone (PPID changed) — exiting');
        void shutdown(0);
      },
      onHeartbeat: () => {
        try {
          if (lockfile && !lockfile.touch()) {
            logger.info('MCP', 'single-instance lock was reclaimed by another bridge — exiting');
            void shutdown(0);
          }
        } catch {
          /* best-effort heartbeat */
        }
      },
    });
process.on('exit', () => stopParentWatch());
process.on('exit', () => authorityRuntime.close());
if (!diagnosticContractProbe) process.on('exit', () => removeObserveState());
// GH #182 zombie class for observe-mirror: catch-all net alongside the shutdown()
// path above. Covers cases that never call shutdown() at all — e.g. the fatal
// main().catch() handler below (process.exit(1) direct) and any other exit — so
// idb/ffmpeg/simctl capture children are always reaped. Synchronous + idempotent.
if (!diagnosticContractProbe) {
  process.on('exit', () => {
    try {
      mirrorManager?.shutdown();
    } catch (err) {
      logger.warn(
        'MCP',
        `exit: mirror shutdown failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  });
}

async function main() {
  logger.info('MCP', `Starting rn-dev-agent-cdp v0.9.1 (log level: ${logger.level})`);
  if (logger.logFilePath) {
    logger.info('MCP', `Log file: ${logger.logFilePath}`);
  }
  logger.debug(
    'MCP',
    `CWD: ${process.cwd()}, CLAUDE_USER_CWD: ${process.env.CLAUDE_USER_CWD ?? 'not set'}`,
  );
  logger.debug(
    'MCP',
    `Node: ${process.version}, ANDROID_HOME: ${process.env.ANDROID_HOME ?? 'not set'}`,
  );

  // Fail closed at boot: an unprofiled registered tool must never serve requests.
  assertAuthorityProfilesExhaustive(registeredToolNames);

  const transport = new StdioServerTransport();
  logger.info('MCP', 'StdioServerTransport created, connecting...');
  await server.connect(transport);
  logger.info('MCP', 'MCP server connected and ready');

  if (!diagnosticContractProbe) {
    const rootResolution = observeRootResolver();
    if (!rootResolution.ok) {
      logger.warn('OBSERVE', `interrupted e2e run recovery skipped: ${rootResolution.reason}`);
    } else {
      const recovered = recoverInterruptedRequests(
        rootResolution.root,
        (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        () => new Date(),
      );
      if (recovered.length) console.error(`[e2e] marked interrupted runs: ${recovered.join(', ')}`);
    }
  }

  // Autostart is fire-and-forget: nothing downstream depends on its result,
  // and even a throwing logger in its catch must not reject main() after MCP
  // is already connected.
  if (!diagnosticContractProbe) {
    void autostartObserve({
      findRoot: observeRootResolver,
      resolveEnabled: resolveObserveAutostart,
      recoveryOnlyReason: () => {
        const status = authorityRuntime.status();
        if (!status.available) return null;
        return status.state === 'blocked' || status.state === 'handoff_cleanup'
          ? `session is a ${status.state} recovery contender`
          : null;
      },
      start: () => startObserveServer({ autostarted: true }),
      warn: (m) => logger.warn('OBSERVE', m),
      info: (m) => logger.info('OBSERVE', m),
    }).catch(() => {});
  }
}

main().catch((err) => {
  logger.error('MCP', `Fatal error: ${err instanceof Error ? err.message : err}`);
  if (logger.logFilePath) {
    console.error(`CDP bridge log: ${logger.logFilePath}`);
  }
  if (!diagnosticContractProbe) void stopFastRunner(getActiveSession()?.deviceId);
  process.exit(1);
});
