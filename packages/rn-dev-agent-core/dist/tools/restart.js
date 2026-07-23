import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { okResult, failResult } from '../utils.js';
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { probeAppInstalled, buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
import { resetDetachedRecoveryCounter } from '../cdp/recover-detached.js';
import { snapshotHintForBundleId } from './resolve-ios-app-file.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
const defaultExecFile = promisify(execFileCb);
const SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
function safeSimctlTarget(deviceId) {
    return deviceId && SIMULATOR_UDID_RE.test(deviceId) ? deviceId : null;
}
let inflightRestart = null;
export function _resetRestartHandlerStateForTest() {
    inflightRestart = null;
}
export function createRestartHandler(getClient, setClient, createClient, deps = {}) {
    const execFile = deps.execFile ?? defaultExecFile;
    const stopFastRunner = deps.stopFastRunner ?? defaultStopFastRunner;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const probeAppInstalledFn = deps.probeAppInstalled ?? probeAppInstalled;
    const snapshotHintFn = deps.snapshotHint ?? snapshotHintForBundleId;
    const resetDetachedBudgetFn = deps.resetDetachedBudget ?? resetDetachedRecoveryCounter;
    async function doRestart(args) {
        try {
            logger.info('MCP', `cdp_restart: in-process state reset requested (hardReset=${!!args.hardReset})`);
            const oldClient = getClient();
            const preservedPort = oldClient.metroPort;
            const targetPlatform = (args.platform ??
                oldClient.connectedTarget?.platform ??
                '').toLowerCase();
            const hardResetSteps = [];
            let bundleId = null;
            if (args.hardReset) {
                bundleId = args.appId ?? args.bundleId ?? null;
                if (!bundleId || !isValidBundleId(bundleId)) {
                    return failResult('cdp_restart hardReset requires the exact authority-bound appId', 'APP_INSTALL_IDENTITY_CHANGED');
                }
                if (!args.deviceId || !targetPlatform) {
                    return failResult('cdp_restart hardReset requires the exact authority-bound device and platform', 'DEVICE_AUTHORITY_MISMATCH');
                }
                try {
                    stopFastRunner(args.deviceId);
                    hardResetSteps.push('stopFastRunner:ok');
                }
                catch (err) {
                    hardResetSteps.push(`stopFastRunner:warn(${err instanceof Error ? err.message : err})`);
                }
                if (bundleId && targetPlatform === 'ios') {
                    const targetUdid = safeSimctlTarget(args.deviceId);
                    if (!targetUdid) {
                        return failResult('cdp_restart refused a non-exact iOS simulator identifier', 'DEVICE_AUTHORITY_MISMATCH');
                    }
                    try {
                        await execFile('xcrun', ['simctl', 'terminate', targetUdid, bundleId], {
                            timeout: 5000,
                        });
                        hardResetSteps.push(`simctl terminate ${bundleId}:ok`);
                    }
                    catch (err) {
                        // Non-fatal: app may already be dead. Log + continue.
                        hardResetSteps.push(`simctl terminate:warn(${err instanceof Error ? err.message : err})`);
                    }
                    try {
                        await execFile('xcrun', ['simctl', 'launch', targetUdid, bundleId], { timeout: 8000 });
                        hardResetSteps.push(`simctl launch ${bundleId}:ok`);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        // GH #262: distinguish "launch hiccup" from "bundle not installed" —
                        // the latter needs install advice, not the soft-reset retry below.
                        // Probe verdict null = unknown → keep the raw error (fail open).
                        if ((await probeAppInstalledFn(targetUdid, bundleId)) === false) {
                            let hint = null;
                            try {
                                hint = snapshotHintFn(bundleId);
                            }
                            catch {
                                /* best-effort */
                            }
                            const advice = buildNotInstalledAdvice(targetUdid, bundleId, hint);
                            // Record the step BEFORE returning so hardResetSteps in meta stays
                            // complete, then return a typed failure: a confirmed-missing bundle
                            // is the primary error, not a buried step the caller has to fish
                            // out. The soft reset below cannot help — nothing connects to a
                            // missing app — so we skip it and leave the existing client.
                            hardResetSteps.push(`simctl launch:err(APP_NOT_INSTALLED — ${advice})`);
                            return failResult(advice, 'APP_NOT_INSTALLED', { hardResetSteps });
                        }
                        else {
                            // Fatal-ish: if launch fails, the soft reset below will likely
                            // fail too. Still continue — caller sees the launch error in
                            // hardResetSteps and the connectError from the autoConnect.
                            hardResetSteps.push(`simctl launch:err(${msg})`);
                        }
                    }
                    await sleep(3000);
                }
                else if (bundleId && targetPlatform === 'android') {
                    try {
                        await execFile('adb', ['-s', args.deviceId, 'shell', 'am', 'force-stop', bundleId], {
                            timeout: 5000,
                        });
                        hardResetSteps.push(`adb force-stop ${bundleId}:ok`);
                        await execFile('adb', [
                            '-s',
                            args.deviceId,
                            'shell',
                            'monkey',
                            '--pct-syskeys',
                            '0',
                            '-p',
                            bundleId,
                            '-c',
                            'android.intent.category.LAUNCHER',
                            '1',
                        ], { timeout: 8000 });
                        hardResetSteps.push(`adb launch ${bundleId}:ok`);
                    }
                    catch (err) {
                        return failResult(`cdp_restart exact Android relaunch failed: ${err instanceof Error ? err.message : String(err)}`, 'RECONNECT_TIMEOUT', { hardResetSteps });
                    }
                    await sleep(3000);
                }
                else {
                    return failResult(`cdp_restart refused unsupported authority platform "${targetPlatform}"`, 'PLATFORM_AUTHORITY_MISMATCH');
                }
            }
            // Soft reset path (unchanged from B76/D644).
            try {
                await oldClient.disconnect();
            }
            catch (err) {
                logger.warn('MCP', `cdp_restart: old client disconnect failed (non-fatal): ${err instanceof Error ? err.message : err}`);
            }
            const newClient = createClient(args.metroPort ?? preservedPort);
            setClient(newClient);
            let connected = false;
            let connectError;
            try {
                await newClient.autoConnect(args.metroPort, {
                    platform: args.platform,
                    bundleId: args.appId,
                });
                connected = newClient.isConnected;
            }
            catch (err) {
                connectError = err instanceof Error ? err.message : String(err);
                logger.warn('MCP', `cdp_restart: exact autoConnect failed: ${connectError}`);
            }
            if (args.hardReset && connected)
                resetDetachedBudgetFn();
            if (!connected) {
                return failResult(`cdp_restart could not reconnect the exact session target${connectError ? `: ${connectError}` : ''}`, 'RECONNECT_TIMEOUT', {
                    restarted: true,
                    connected: false,
                    hardReset: !!args.hardReset,
                    hardResetSteps,
                });
            }
            return okResult({
                restarted: true,
                connected,
                port: newClient.metroPort,
                hardReset: !!args.hardReset,
                ...(args.hardReset ? { hardResetSteps } : {}),
                ...(bundleId ? { bundleId } : {}),
                ...(connectError ? { connectError } : {}),
            });
        }
        catch (err) {
            return failResult(err instanceof Error ? err.message : String(err));
        }
    }
    return async (args) => {
        // Codex finding #2 (conf 82): concurrent-restart guard. If a restart
        // is already in flight, return early rather than racing on setClient
        // + simctl side effects. The second caller sees a clear "already
        // running" envelope and can retry after the first completes.
        if (inflightRestart) {
            return failResult('A cdp_restart is already running for this worker.', 'OPERATION_ALREADY_IN_PROGRESS', { nextAction: 'Await the active restart before retrying.' });
        }
        inflightRestart = doRestart(args).finally(() => {
            inflightRestart = null;
        });
        return inflightRestart;
    };
}
