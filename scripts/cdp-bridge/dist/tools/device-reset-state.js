import { okResult, failResult, warnResult } from '../utils.js';
import { detectPlatform } from './platform-utils.js';
import { createDevicePermissionHandler } from './device-permission.js';
import { buildMmkvExpression } from './mmkv.js';
import { terminateApp, launchApp } from './app-lifecycle.js';
import { handleDevClientPicker } from './dev-client-picker.js';
import { waitForNavigationReady } from './startup-replay.js';
const RECONNECT_ATTEMPTS = 4;
const RECONNECT_BACKOFF_MS = 2_000;
const POST_LAUNCH_SETTLE_MS = 1_000;
const HELPERS_DEADLINE_MS = 15_000;
const NAV_READY_TIMEOUT_MS = 12_000;
function normalizePermissions(input) {
    if (!input || input.length === 0)
        return [];
    return input.map((p) => typeof p === 'string' ? { name: p, action: 'revoke' } : { name: p.name, action: p.action ?? 'revoke' });
}
async function runPermissionSteps(permissions, appId, platform) {
    const handler = createDevicePermissionHandler();
    const results = [];
    for (const perm of permissions) {
        const start = Date.now();
        try {
            const r = await handler({
                action: perm.action ?? 'revoke',
                permission: perm.name,
                appId,
                platform,
            });
            const failed = r.isError === true;
            const parsed = failed ? safeParseError(r) : undefined;
            results.push({
                step: 'permission',
                target: perm.name,
                action: perm.action ?? 'revoke',
                ok: !failed,
                durationMs: Date.now() - start,
                ...(failed ? { code: parsed?.code, error: parsed?.error } : {}),
            });
        }
        catch (e) {
            results.push({
                step: 'permission',
                target: perm.name,
                action: perm.action ?? 'revoke',
                ok: false,
                durationMs: Date.now() - start,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    return results;
}
async function runStorageSteps(client, keys, instanceId) {
    const results = [];
    for (const key of keys) {
        const start = Date.now();
        try {
            const expr = buildMmkvExpression({ action: 'delete', key, instanceId });
            const evalResult = await client.evaluate(expr);
            if (evalResult.error) {
                results.push({
                    step: 'storage', target: key, action: 'delete', ok: false,
                    durationMs: Date.now() - start, error: evalResult.error,
                });
                continue;
            }
            // Expression returns JSON; check for __agent_error sentinel.
            const raw = typeof evalResult.value === 'string' ? evalResult.value : JSON.stringify(evalResult.value);
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                parsed = null;
            }
            const obj = (parsed && typeof parsed === 'object') ? parsed : null;
            if (obj && typeof obj.__agent_error === 'string') {
                results.push({
                    step: 'storage', target: key, action: 'delete', ok: false,
                    durationMs: Date.now() - start, error: obj.__agent_error,
                });
                continue;
            }
            results.push({ step: 'storage', target: key, action: 'delete', ok: true, durationMs: Date.now() - start });
        }
        catch (e) {
            results.push({
                step: 'storage', target: key, action: 'delete', ok: false,
                durationMs: Date.now() - start, error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    return results;
}
async function runTerminateStep(appId, platform) {
    const start = Date.now();
    try {
        await terminateApp(appId, platform);
        return { step: 'terminate', target: appId, ok: true, durationMs: Date.now() - start };
    }
    catch (e) {
        return {
            step: 'terminate', target: appId, ok: false, durationMs: Date.now() - start,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
async function runLaunchStep(appId, platform) {
    const start = Date.now();
    try {
        await launchApp(appId, platform);
        return { step: 'launch', target: appId, ok: true, durationMs: Date.now() - start };
    }
    catch (e) {
        return {
            step: 'launch', target: appId, ok: false, durationMs: Date.now() - start,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
async function runReconnectStep(client) {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, POST_LAUNCH_SETTLE_MS));
    await handleDevClientPicker().catch(() => undefined);
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
        try {
            await client.softReconnect();
            return {
                step: { step: 'reconnect', ok: true, durationMs: Date.now() - start },
                reconnected: true,
            };
        }
        catch (err) {
            if (attempt < RECONNECT_ATTEMPTS - 1) {
                await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
            }
            else {
                return {
                    step: {
                        step: 'reconnect', ok: false, durationMs: Date.now() - start,
                        error: err instanceof Error ? err.message : String(err),
                    },
                    reconnected: false,
                };
            }
        }
    }
    return {
        step: { step: 'reconnect', ok: false, durationMs: Date.now() - start, error: 'reconnect attempts exhausted' },
        reconnected: false,
    };
}
async function runHelpersStep(client) {
    const start = Date.now();
    const deadline = Date.now() + HELPERS_DEADLINE_MS;
    while (!client.helpersInjected && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
    }
    const ok = client.helpersInjected;
    return {
        step: {
            step: 'helpers', ok, durationMs: Date.now() - start,
            ...(ok ? {} : { error: `helpers not injected within ${HELPERS_DEADLINE_MS}ms` }),
        },
        helpersInjected: ok,
    };
}
async function runNavReadyStep(client) {
    const start = Date.now();
    const ready = await waitForNavigationReady(client, NAV_READY_TIMEOUT_MS);
    return {
        step: 'nav_ready', ok: ready, durationMs: Date.now() - start,
        ...(ready ? {} : { error: `nav ref not ready within ${NAV_READY_TIMEOUT_MS}ms` }),
    };
}
function safeParseError(r) {
    try {
        const text = r.content[0]?.text;
        if (!text)
            return {};
        const parsed = JSON.parse(text);
        return { code: parsed.code, error: parsed.error };
    }
    catch {
        return {};
    }
}
export function createDeviceResetStateHandler(getClient) {
    return async (args) => {
        if (!args.appId || typeof args.appId !== 'string') {
            return failResult('appId is required.', 'DEVICE_RESET_INVALID_ARGS');
        }
        const platform = args.platform ?? (await detectPlatform());
        if (platform !== 'ios' && platform !== 'android') {
            return failResult('No iOS simulator or Android device detected. Pass platform explicitly.', 'DEVICE_RESET_INVALID_ARGS');
        }
        const permissions = normalizePermissions(args.permissions);
        const storageKeys = args.storageKeys ?? [];
        const relaunch = args.relaunch ?? true;
        const waitForReady = args.waitForReady ?? true;
        const waitForNavReady = args.waitForNavReady ?? false;
        const steps = [];
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
                        step: 'storage', target: key, action: 'delete', ok: false, durationMs: 0,
                        code: 'CDP_NOT_CONNECTED',
                        error: 'CDP not connected — storage keys skipped. Connect first to clear MMKV before terminate.',
                    });
                }
            }
            else {
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
        const skipped = steps.filter((s) => s.code === 'CDP_NOT_CONNECTED').length;
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
        if (failed === 0 && skipped === 0)
            return okResult(data);
        // Only fire RECONNECT_FAILED when reconnect was actually attempted and
        // failed — not when launch itself failed or reconnect was never reached.
        if (reconnectAttempted && !reconnected) {
            return failResult('Reset state ran but CDP reconnect failed. Device IS reset; call cdp_status to retry the connection.', 'DEVICE_RESET_RECONNECT_FAILED', { steps, summary, appId: args.appId, platform });
        }
        // All-skipped (only CDP-not-connected entries) is fine — return ok.
        if (failed === 0)
            return okResult(data);
        return warnResult(data, `Reset completed with ${failed} failed step(s). See steps[] for per-step diagnostics.`, { code: 'DEVICE_RESET_STATE_PARTIAL' });
    };
}
