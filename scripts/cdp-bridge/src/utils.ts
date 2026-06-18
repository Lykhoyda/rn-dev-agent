import type { CDPClient } from "./cdp-client.js";
import type { ResultEnvelope, ToolErrorCode } from "./types.js";
import { hasActiveSession } from "./agent-device-wrapper.js";
import { handleDevClientPicker } from "./tools/dev-client-picker.js";
import { probeFreshness, recoverFromStaleTarget, consumeCdpStale } from "./cdp/recovery.js";

// S1 (D631): cache the freshness probe for up to 2s per (client, generation).
// Eliminates a CDP round-trip on back-to-back tool calls while still invalidating
// on reconnect (connectionGeneration bumps) and on any failure (cache is never set).
const FRESHNESS_CACHE_MS = 2000;
const freshnessCache = new WeakMap<CDPClient, { generation: number; expiresAt: number }>();

function isFreshnessCached(client: CDPClient): boolean {
  const entry = freshnessCache.get(client);
  if (!entry) return false;
  if (entry.generation !== client.connectionGeneration) return false;
  return Date.now() < entry.expiresAt;
}

function rememberFreshness(client: CDPClient): void {
  freshnessCache.set(client, {
    generation: client.connectionGeneration,
    expiresAt: Date.now() + FRESHNESS_CACHE_MS,
  });
}

function forgetFreshness(client: CDPClient): void {
  freshnessCache.delete(client);
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

// Per-step timing collector for the `meta.timings_ms` convention (CLAUDE.md):
// instrument variable-cost paths (dispatch, snapshot, repair, reconnect) so the
// breakdown is visible. `mark(label)` records elapsed-since-last-mark under
// `label`; `timings()` returns the accumulated map for meta.timings_ms.
export function createStepTimer(): {
  mark: (label: string) => void;
  timings: () => Record<string, number>;
} {
  let last = Date.now();
  const acc: Record<string, number> = {};
  return {
    mark(label: string): void {
      const now = Date.now();
      acc[label] = (acc[label] ?? 0) + (now - last);
      last = now;
    },
    timings(): Record<string, number> {
      return acc;
    },
  };
}

export function okResult<T>(
  data: T,
  opts?: { truncated?: boolean; meta?: Record<string, unknown> },
): ToolResult {
  const envelope: ResultEnvelope<T> = { ok: true, data };
  if (opts?.truncated) envelope.truncated = true;
  if (opts?.meta) envelope.meta = opts.meta;
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }] };
}

export function failResult(
  error: string,
  metaOrCode?: Record<string, unknown> | ToolErrorCode,
  maybeMeta?: Record<string, unknown>,
): ToolResult {
  const envelope: ResultEnvelope = { ok: false, error };
  if (typeof metaOrCode === "string") {
    envelope.code = metaOrCode;
    if (maybeMeta) envelope.meta = maybeMeta;
  } else if (metaOrCode) {
    envelope.meta = metaOrCode;
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}

export function warnResult<T>(
  data: T,
  warning: string,
  meta?: Record<string, unknown>,
): ToolResult {
  const envelope: ResultEnvelope<T> = { ok: true, data, meta: { ...meta, warning } };
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }] };
}

export type ToolHandler<T> = (args: T, client: CDPClient) => Promise<ToolResult>;

export function withConnection<T>(
  getClient: () => CDPClient,
  handler: ToolHandler<T>,
  options: { requireHelpers?: boolean } = {},
): (args: T) => Promise<ToolResult> {
  const { requireHelpers = true } = options;

  return async (args: T): Promise<ToolResult> => {
    const client = getClient();
    try {
      if (!client.isConnected) {
        try {
          await client.autoConnect();
        } catch (connectErr) {
          const msg = connectErr instanceof Error ? connectErr.message : String(connectErr);
          if (msg.includes("Already connecting")) {
            // Reconnection in progress — wait up to 30s for it to complete (B89)
            const deadline = Date.now() + 30_000;
            while (!client.isConnected && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 500));
            }
            if (!client.isConnected) {
              return failResult(
                "Reconnection timed out. Call cdp_status to retry.",
                "RECONNECT_TIMEOUT",
              );
            }
          } else {
            return failResult(
              `Auto-connect failed: ${msg}. If Metro was restarted, wait a moment then call cdp_status to reconnect.`,
              "NOT_CONNECTED",
            );
          }
        }
      }
      if (requireHelpers && !client.helpersInjected) {
        const helperDeadline = Date.now() + 5_000;
        while (!client.helpersInjected && Date.now() < helperDeadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
        // D1202: Active 1-shot re-inject. The initial inject during connect
        // setup can race with bundle re-load on app relaunch (Hermes recreates
        // the runtime mid-injection, dropping __RN_AGENT). Without an active
        // retry the loop above just spins because nothing triggers a fresh
        // injection — sessions get stuck on HELPERS_NOT_INJECTED until the
        // caller switches tools or calls cdp_reload. One bounded reinject
        // covers the race; falls through to picker logic on failure.
        //
        // Latency budget: the 3s arg here only bounds waitForReact's slice.
        // The subsequent evaluate(INJECTED_HELPERS) + verify each carry their
        // own per-method CDP timeouts, so worst-case wall time on a hung JS
        // world is ~6-7s, not 3s. That's still well under the user-visible
        // 30s picker fallback.
        //
        // Concurrency: two simultaneous withConnection callers can both reach
        // this branch and both fire reinjectHelpers. The injected bundle is
        // idempotent (reassigns globalThis.__RN_AGENT), so this is wasted
        // work but not a correctness bug. Coalescing is logged as a future
        // optimisation in workspace BUGS.md.
        if (!client.helpersInjected && client.isConnected) {
          try {
            const reinjected = await client.reinjectHelpers(3_000);
            // reinjectHelpersFn already verified __RN_AGENT === "object" before
            // returning true, so we can pre-seed the freshness cache and skip
            // the redundant proactive probe at line ~135.
            if (reinjected) rememberFreshness(client);
          } catch (err) {
            console.error(
              `CDP: active re-inject during freshness wait failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        // D503: If helpers still not ready, Dev Client picker may be blocking React
        if (!client.helpersInjected) {
          const pickerResult = await handleDevClientPicker();
          if (pickerResult?.dismissed) {
            console.error("CDP: Dev Client picker dismissed, waiting for helpers...");
            const extDeadline = Date.now() + 30_000;
            while (!client.helpersInjected && Date.now() < extDeadline) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          if (!client.helpersInjected) {
            return failResult(
              "Connected but helpers still not injected after passive wait, active re-inject, and Dev Client picker dismissal. The JS world may be hung. Fall back to device_* tools (XCTest path — no helpers required) or call cdp_reload to restart the bundle.",
              "HELPERS_NOT_INJECTED",
            );
          }
        }
      }
      // GH #186: a device-session runner-leak recovery may have re-foregrounded
      // or relaunched the app out from under CDP. If it flagged the target as
      // stale, re-pin proactively NOW (recoverFromStaleTarget is a no-op when
      // the target is actually fresh) so the handler doesn't hit a ~47s
      // STALE_TARGET timeout. Best-effort — the catch-path recovery still covers
      // any failure here.
      if (client.isConnected && consumeCdpStale()) {
        try {
          await recoverFromStaleTarget(client);
          forgetFreshness(client);
        } catch {
          /* fall through — handler + catch-path recovery still apply */
        }
      }
      // D502: Proactive freshness check (D631/S1 caches result for 2s per generation).
      // D633: delegated to cdp/recovery.probeFreshness.
      if (requireHelpers && client.helpersInjected && !isFreshnessCached(client)) {
        const probe = await probeFreshness(client);
        if (probe.probed && !probe.fresh) {
          console.error("CDP: helpers stale (globals missing), re-injecting...");
          forgetFreshness(client);
          const reinjected = await client.reinjectHelpers();
          if (!reinjected) {
            return failResult(
              "Helpers became stale and re-injection failed. Try cdp_reload.",
              "HELPERS_STALE",
            );
          }
          rememberFreshness(client);
        } else if (probe.fresh) {
          rememberFreshness(client);
        } else {
          forgetFreshness(client);
        }
      }
      const result = await handler(args, client);

      // B63 (D634): after a handler failure, re-probe freshness. If globals are gone,
      // re-inject and retry. Uses the __RN_AGENT.__v probe as the primary signal
      // instead of error-message string matching.
      if (requireHelpers && result.isError && client.isConnected) {
        const probe = await probeFreshness(client);
        if (probe.probed && !probe.fresh) {
          console.error(
            "CDP: stale handler result detected (version probe failed), re-injecting helpers...",
          );
          forgetFreshness(client);
          const reinjected = await client.reinjectHelpers();
          if (reinjected) {
            try {
              return await handler(args, client);
            } catch {
              // Retry failed — return original result
            }
          }
        }
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isDisconnect =
        message.includes("WebSocket closed") || message.includes("WebSocket not connected");

      if (isDisconnect) {
        // Path A: Clean disconnect — wait for auto-reconnect, then retry once
        const retryDeadline = Date.now() + 30_000;
        while (!client.isConnected && Date.now() < retryDeadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (client.isConnected) {
          if (requireHelpers && !client.helpersInjected) {
            const hd = Date.now() + 5_000;
            while (!client.helpersInjected && Date.now() < hd) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
          if (!requireHelpers || client.helpersInjected) {
            try {
              return await handler(args, client);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              return failResult(`Retry after reconnect failed: ${retryMsg}`);
            }
          }
        }
        return failResult(
          "Connection lost during operation and reconnect timed out. Metro may be restarting — call cdp_status to retry connection, or check: curl localhost:8081/status",
        );
      }

      // Path B (B58 fix): stale-target recovery delegated to cdp/recovery.ts (D633).
      if (client.isConnected) {
        forgetFreshness(client);
        const recovery = await recoverFromStaleTarget(client);
        if (recovery.recovered) {
          console.error("CDP: stale target detected (confirmed after retry), re-discovering...");
          if (requireHelpers && !client.helpersInjected) {
            const hd = Date.now() + 5_000;
            while (!client.helpersInjected && Date.now() < hd) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
          if (!requireHelpers || client.helpersInjected) {
            try {
              return await handler(args, client);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              return failResult(
                `Retry after stale-target recovery failed: ${retryMsg}`,
                "STALE_TARGET",
                { originalError: message },
              );
            }
          }
          return failResult(
            "Stale target recovery: reconnected but helpers not injected.",
            "HELPERS_NOT_INJECTED",
            { originalError: message },
          );
        }
        if (recovery.reason === "reconnect-failed") {
          return failResult(`Stale target recovery failed: ${recovery.error}`, "STALE_TARGET", {
            originalError: message,
          });
        }
      }

      return failResult(message);
    }
  };
}

export type DeviceToolHandler<T> = (args: T) => Promise<ToolResult>;

export function withSession<T>(handler: DeviceToolHandler<T>): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    if (!hasActiveSession()) {
      return failResult(
        'No device session open. Call device_snapshot with action="open" and provide appId and platform first.',
        {
          hint: "device_snapshot action=open starts a session. All device_press/device_fill/device_find/device_swipe/device_back tools require an open session.",
        },
      );
    }
    return handler(args);
  };
}
