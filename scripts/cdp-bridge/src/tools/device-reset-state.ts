import type { CDPClient } from "../cdp-client.js";
import { okResult, failResult, warnResult, type ToolResult } from "../utils.js";
import { detectPlatform } from "./platform-utils.js";
import { createDevicePermissionHandler } from "./device-permission.js";
import { isValidBundleId } from "../domain/maestro-validator.js";
import { buildMmkvExpression } from "./mmkv.js";
import { terminateApp, launchApp } from "./app-lifecycle.js";
import { handleDevClientPicker } from "./dev-client-picker.js";
import { waitForNavigationReady } from "./startup-replay.js";

// GH #60 Feature-c / D687: device_reset_state composes the 4-step preflight
// (permissions → storage → terminate → launch+reconnect) into a single MCP
// call. Best-effort with per-step status; never silently rolls back.
//
// Sequence rationale (Codex/Claude consensus):
// 1. Permissions FIRST — changes can trigger app-side observers that write
//    cooldown keys, which must be deletable by the next step.
// 2. MMKV BEFORE terminate — cdp_mmkv requires a live CDP target, and MMKV
//    mmap visibility means writes are observable by the next process.
// 3. Terminate before launch (idempotent on both platforms).
// 4. Reconnect only if waitForReady — caller can opt out for faster return.

type PermissionAction = "revoke" | "reset";

export interface PermissionSpec {
  name: string;
  action?: PermissionAction;
}

export interface DeviceResetStateArgs {
  appId: string;
  platform?: "ios" | "android";
  permissions?: Array<string | PermissionSpec>;
  storageKeys?: string[];
  mmkvInstanceId?: string;
  relaunch?: boolean;
  waitForReady?: boolean;
  waitForNavReady?: boolean;
}

type StepName =
  | "permission"
  | "storage"
  | "terminate"
  | "launch"
  | "reconnect"
  | "helpers"
  | "nav_ready";

interface StepResult {
  step: StepName;
  target?: string;
  action?: string;
  ok: boolean;
  durationMs: number;
  code?: string;
  error?: string;
}

const RECONNECT_ATTEMPTS = 4;
const RECONNECT_BACKOFF_MS = 2_000;
const POST_LAUNCH_SETTLE_MS = 1_000;
const HELPERS_DEADLINE_MS = 15_000;
const NAV_READY_TIMEOUT_MS = 12_000;

function normalizePermissions(input: DeviceResetStateArgs["permissions"]): PermissionSpec[] {
  if (!input || input.length === 0) return [];
  return input.map((p) =>
    typeof p === "string"
      ? { name: p, action: "revoke" as const }
      : { name: p.name, action: p.action ?? "revoke" },
  );
}

async function runPermissionSteps(
  permissions: PermissionSpec[],
  appId: string,
  platform: "ios" | "android",
): Promise<StepResult[]> {
  const handler = createDevicePermissionHandler();
  const results: StepResult[] = [];
  for (const perm of permissions) {
    const start = Date.now();
    try {
      const r = await handler({
        action: perm.action ?? "revoke",
        permission: perm.name,
        appId,
        platform,
      });
      const failed = r.isError === true;
      const parsed = failed ? safeParseError(r) : undefined;
      results.push({
        step: "permission",
        target: perm.name,
        action: perm.action ?? "revoke",
        ok: !failed,
        durationMs: Date.now() - start,
        ...(failed ? { code: parsed?.code, error: parsed?.error } : {}),
      });
    } catch (e: unknown) {
      results.push({
        step: "permission",
        target: perm.name,
        action: perm.action ?? "revoke",
        ok: false,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

async function runStorageSteps(
  client: CDPClient,
  keys: string[],
  instanceId: string | undefined,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const key of keys) {
    const start = Date.now();
    try {
      const expr = buildMmkvExpression({ action: "delete", key, instanceId });
      const evalResult = await client.evaluate(expr);
      if (evalResult.error) {
        results.push({
          step: "storage",
          target: key,
          action: "delete",
          ok: false,
          durationMs: Date.now() - start,
          error: evalResult.error,
        });
        continue;
      }
      // Expression returns JSON; check for __agent_error sentinel.
      const raw =
        typeof evalResult.value === "string" ? evalResult.value : JSON.stringify(evalResult.value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      if (obj && typeof obj.__agent_error === "string") {
        results.push({
          step: "storage",
          target: key,
          action: "delete",
          ok: false,
          durationMs: Date.now() - start,
          error: obj.__agent_error,
        });
        continue;
      }
      results.push({
        step: "storage",
        target: key,
        action: "delete",
        ok: true,
        durationMs: Date.now() - start,
      });
    } catch (e: unknown) {
      results.push({
        step: "storage",
        target: key,
        action: "delete",
        ok: false,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

async function runTerminateStep(appId: string, platform: "ios" | "android"): Promise<StepResult> {
  const start = Date.now();
  try {
    await terminateApp(appId, platform);
    return { step: "terminate", target: appId, ok: true, durationMs: Date.now() - start };
  } catch (e: unknown) {
    return {
      step: "terminate",
      target: appId,
      ok: false,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runLaunchStep(appId: string, platform: "ios" | "android"): Promise<StepResult> {
  const start = Date.now();
  try {
    await launchApp(appId, platform);
    return { step: "launch", target: appId, ok: true, durationMs: Date.now() - start };
  } catch (e: unknown) {
    return {
      step: "launch",
      target: appId,
      ok: false,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runReconnectStep(
  client: CDPClient,
): Promise<{ step: StepResult; reconnected: boolean }> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, POST_LAUNCH_SETTLE_MS));
  await handleDevClientPicker().catch(() => undefined);

  for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
    try {
      await client.softReconnect();
      return {
        step: { step: "reconnect", ok: true, durationMs: Date.now() - start },
        reconnected: true,
      };
    } catch (err) {
      if (attempt < RECONNECT_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
      } else {
        return {
          step: {
            step: "reconnect",
            ok: false,
            durationMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          },
          reconnected: false,
        };
      }
    }
  }
  return {
    step: {
      step: "reconnect",
      ok: false,
      durationMs: Date.now() - start,
      error: "reconnect attempts exhausted",
    },
    reconnected: false,
  };
}

async function runHelpersStep(
  client: CDPClient,
): Promise<{ step: StepResult; helpersInjected: boolean }> {
  const start = Date.now();
  const deadline = Date.now() + HELPERS_DEADLINE_MS;
  while (!client.helpersInjected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const ok = client.helpersInjected;
  return {
    step: {
      step: "helpers",
      ok,
      durationMs: Date.now() - start,
      ...(ok ? {} : { error: `helpers not injected within ${HELPERS_DEADLINE_MS}ms` }),
    },
    helpersInjected: ok,
  };
}

async function runNavReadyStep(client: CDPClient): Promise<StepResult> {
  const start = Date.now();
  const ready = await waitForNavigationReady(client, NAV_READY_TIMEOUT_MS);
  return {
    step: "nav_ready",
    ok: ready,
    durationMs: Date.now() - start,
    ...(ready ? {} : { error: `nav ref not ready within ${NAV_READY_TIMEOUT_MS}ms` }),
  };
}

/**
 * CDP-003: heuristic "does this CDP target belong to this app?" check used to
 * gate storage mutations. Looks for the bundle id (case-insensitive) in the
 * target's description/title — Hermes target metadata typically embeds the
 * bundle id verbatim. Conservative: returns false if there's no target or
 * the haystack is empty, forcing the caller to skip rather than guess.
 */
export function cdpTargetMatchesApp(client: CDPClient, appId: string): boolean {
  if (!client.isConnected) return false;
  const target = client.connectedTarget;
  if (!target) return false;
  const haystack = `${target.description ?? ""} ${target.title ?? ""}`.toLowerCase();
  if (haystack.length === 0) return false;
  return haystack.includes(appId.toLowerCase());
}

function safeParseError(r: ToolResult): { code?: string; error?: string } {
  try {
    const text = r.content[0]?.text;
    if (!text) return {};
    const parsed = JSON.parse(text) as { code?: string; error?: string };
    return { code: parsed.code, error: parsed.error };
  } catch {
    return {};
  }
}

export function createDeviceResetStateHandler(
  getClient: () => CDPClient,
): (args: DeviceResetStateArgs) => Promise<ToolResult> {
  return async (args) => {
    if (!args.appId || typeof args.appId !== "string") {
      return failResult("appId is required.", "DEVICE_RESET_INVALID_ARGS");
    }
    // Phase 134.2 (deepsec HIGH): appId flows into permission/terminate/
    // launch helpers, which on Android reach `adb shell pm/am`. Validate
    // at the entry boundary so a metachar-laden appId never reaches any
    // downstream call.
    if (!isValidBundleId(args.appId)) {
      return failResult(
        `Invalid appId "${String(args.appId).slice(0, 80)}" — must be reverse-DNS bundle identifier (e.g. com.example.app)`,
        "DEVICE_RESET_INVALID_APPID",
      );
    }
    const platform = args.platform ?? (await detectPlatform());
    if (platform !== "ios" && platform !== "android") {
      return failResult(
        "No iOS simulator or Android device detected. Pass platform explicitly.",
        "DEVICE_RESET_INVALID_ARGS",
      );
    }

    const permissions = normalizePermissions(args.permissions);
    const storageKeys = args.storageKeys ?? [];
    const relaunch = args.relaunch ?? true;
    const waitForReady = args.waitForReady ?? true;
    const waitForNavReady = args.waitForNavReady ?? false;

    const steps: StepResult[] = [];
    let reconnected = false;
    let helpersInjected = false;
    let reconnectAttempted = false;

    // Step 1: permissions (no CDP needed).
    if (permissions.length > 0) {
      const permResults = await runPermissionSteps(permissions, args.appId, platform);
      steps.push(...permResults);
    }

    // Step 2: storage (CDP required — best-effort if disconnected).
    if (storageKeys.length > 0) {
      const client = getClient();
      if (!client.isConnected) {
        for (const key of storageKeys) {
          steps.push({
            step: "storage",
            target: key,
            action: "delete",
            ok: false,
            durationMs: 0,
            code: "CDP_NOT_CONNECTED",
            error:
              "CDP not connected — storage keys skipped. Connect first to clear MMKV before terminate.",
          });
        }
      } else if (!cdpTargetMatchesApp(client, args.appId)) {
        // CDP-003: refuse to mutate MMKV when the connected target does not
        // belong to args.appId — otherwise we silently delete keys from a
        // sibling app in monorepos / multi-simulator workflows.
        const target = client.connectedTarget;
        const desc = target?.description ?? target?.title ?? target?.id ?? "?";
        for (const key of storageKeys) {
          steps.push({
            step: "storage",
            target: key,
            action: "delete",
            ok: false,
            durationMs: 0,
            code: "CDP_TARGET_APP_MISMATCH",
            error: `CDP target "${desc}" does not appear to belong to ${args.appId} — storage skipped to avoid wrong-app deletion. Reconnect to ${args.appId} (cdp_connect bundleId=...) first.`,
          });
        }
      } else {
        const storageResults = await runStorageSteps(client, storageKeys, args.mmkvInstanceId);
        steps.push(...storageResults);
      }
    }

    // Step 3: terminate.
    steps.push(await runTerminateStep(args.appId, platform));

    // Step 4: launch + reconnect (gated by relaunch / waitForReady).
    if (relaunch) {
      const launchResult = await runLaunchStep(args.appId, platform);
      steps.push(launchResult);
      if (launchResult.ok && waitForReady) {
        // Re-fetch client AFTER launch in case anything swapped it. (No swap
        // currently happens in this orchestrator, but defensive against
        // future changes — see B132/B145 territory.)
        const client = getClient();
        reconnectAttempted = true;
        const reconnectStep = await runReconnectStep(client);
        steps.push(reconnectStep.step);
        reconnected = reconnectStep.reconnected;

        if (reconnected) {
          const helpersStep = await runHelpersStep(getClient());
          steps.push(helpersStep.step);
          helpersInjected = helpersStep.helpersInjected;

          if (waitForNavReady && helpersInjected) {
            steps.push(await runNavReadyStep(getClient()));
          }
        }
      }
    }

    const skipped = steps.filter((s) => s.code === "CDP_NOT_CONNECTED").length;
    const okCount = steps.filter((s) => s.ok).length;
    const failed = steps.filter((s) => !s.ok).length - skipped;
    const summary = {
      ok: okCount,
      failed,
      skipped,
    };

    const data = {
      appId: args.appId,
      platform,
      relaunch,
      waitForReady,
      summary,
      steps,
      reconnectAttempted,
      reconnected,
      helpersInjected,
    };

    if (failed === 0 && skipped === 0) return okResult(data);

    // Only fire RECONNECT_FAILED when reconnect was actually attempted and
    // failed — not when launch itself failed or reconnect was never reached.
    if (reconnectAttempted && !reconnected) {
      return failResult(
        "Reset state ran but CDP reconnect failed. Device IS reset; call cdp_status to retry the connection.",
        "DEVICE_RESET_RECONNECT_FAILED",
        { steps, summary, appId: args.appId, platform },
      );
    }

    // All-skipped (only CDP-not-connected entries) is fine — return ok.
    if (failed === 0) return okResult(data);

    return warnResult(
      data,
      `Reset completed with ${failed} failed step(s). See steps[] for per-step diagnostics.`,
      { code: "DEVICE_RESET_STATE_PARTIAL" },
    );
  };
}
