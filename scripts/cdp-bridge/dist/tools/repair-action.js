// D1206 Tier 2 Sprint D / Phase 129 — cdp_repair_action MCP tool.
//
// Orchestrates L3→L2 self-repair when /run-action fails with
// SELECTOR_NOT_FOUND: load action, check guardrails, snapshot device,
// fuzzy-match the stale selector against current testIDs, patch the
// YAML in place, persist the repair record. Pure repair logic lives in
// domain/repair-engine.ts; this file is the I/O orchestration.
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { ensureFastRunner, getActiveSession, runNative } from "../agent-device-wrapper.js";
import { okResult, failResult, withSession } from "../utils.js";
import { isValidActionId } from "../domain/path-safety.js";
import { loadAction, saveAction, actionWasEditedExternally } from "../domain/action-store.js";
import { extractAllTestIDs, extractIdSelectors, detectTransportBlind, attemptRepair, applyRepair, DEFAULT_REPAIR_THRESHOLD, } from "../domain/repair-engine.js";
import { repairBudgetAvailable, recentRepairCount } from "../domain/reusable-action.js";
import { snapshotEnvelopeFailed } from "./device-batch.js";
import { resolveBundleId } from "../project-config.js";
import { isAgentDeviceRunnerSentinel } from "./runner-leak-recovery.js";
import { detectPlatform } from "./platform-utils.js";
import { stopFastRunner } from "../runners/rn-fast-runner-client.js";
const execFile = promisify(execFileCb);
/**
 * GH #105 / B153: bring the target app to foreground BEFORE taking the
 * snapshot. Without this, the agent-device snapshot reads whichever app is
 * frontmost — typically the Agent Device Runner (XCTest test rig) which has
 * no testIDs of its own. That yields the misleading "snapshot returned 0
 * testIDs" failure on a perfectly healthy app.
 *
 * **Live-smoke-test discovery (GH #105 follow-up):** `simctl launch` alone
 * loses the focus race when the agent-device fast-runner (spawned by the
 * prior `maestro_run`) is still alive — `XCUIApplication.activate()` inside
 * the runner re-foregrounds the runner before the snapshot lands. The fix
 * is to `stopFastRunner()` FIRST so there's nothing competing for focus,
 * THEN `simctl launch` the test-app. The next `runNative(snapshot)`
 * will lazily re-spawn the fast-runner, which is fine because by then
 * agent-device knows which bundle to attach to (it inherits the foreground
 * app's XCUIApplication).
 *
 * Best-effort: silent failure means we still fall through to the snapshot,
 * which can still detect the runner-leak sentinel and surface a useful
 * error. iOS uses `simctl launch booted <bundleId>`; Android uses `am start`
 * via adb.
 */
/**
 * GH #105 iOS-MVP §3.7: discover the booted iOS simulator UDID when no active
 * device session is present (the smoke-test path: cdp_run_action → auto-repair
 * runs without anyone having called device_snapshot action=open). Uses simctl
 * to enumerate booted devices and returns the first UDID — single-simulator
 * setups, which is the supported configuration.
 */
async function resolveIOSDeviceIdForRepair() {
    const session = getActiveSession();
    if (session?.deviceId)
        return session.deviceId;
    try {
        const { stdout } = await execFile("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
            timeout: 5000,
            encoding: "utf8",
        });
        const data = JSON.parse(stdout);
        for (const list of Object.values(data.devices ?? {})) {
            for (const dev of list) {
                if (dev.state === "Booted" && dev.udid)
                    return dev.udid;
            }
        }
    }
    catch {
        /* best-effort */
    }
    return undefined;
}
async function bringTargetAppToForeground(platform, bundleId) {
    // Kill the fast-runner FIRST so it can't re-grab focus the moment we
    // simctl-launch the test-app. Equivalent step exists in cdp_restart
    // hardReset (PR #161); this is its single-tool counterpart inside the
    // repair path so users don't have to call cdp_restart manually after
    // a SELECTOR_NOT_FOUND.
    try {
        stopFastRunner();
    }
    catch {
        /* best-effort — fast-runner may already be dead */
    }
    try {
        if (platform === "android") {
            await execFile("adb", ["shell", "monkey", "-p", bundleId, "-c", "android.intent.category.LAUNCHER", "1"], { timeout: 5000, encoding: "utf8" });
        }
        else {
            await execFile("xcrun", ["simctl", "launch", "booted", bundleId], {
                timeout: 5000,
                encoding: "utf8",
            });
        }
    }
    catch {
        /* best-effort — sentinel detection covers the failure case */
    }
}
/**
 * Parse agent-device snapshot envelope into the small node shape that
 * isAgentDeviceRunnerSentinel cares about. Mirrors the parser in
 * device-session.ts but kept local to keep the dependency surface tight.
 */
function parseSnapshotNodes(envelope) {
    try {
        const obj = JSON.parse(envelope);
        if (!obj.ok || !obj.data?.nodes)
            return null;
        return obj.data.nodes;
    }
    catch {
        return null;
    }
}
export function createRepairActionHandler() {
    return withSession(async (args) => {
        if (!args.actionId || typeof args.actionId !== "string") {
            return failResult("cdp_repair_action requires actionId", "BAD_FILENAME");
        }
        // Phase 134.3 (deepsec HIGH path-traversal): actionId flows into
        // <projectRoot>/.rn-agent/actions/<id>.yaml. Reject any ID that
        // could escape that directory (e.g. `../../etc/passwd`) before any
        // file read happens.
        if (!isValidActionId(args.actionId)) {
            return failResult(`Invalid actionId "${String(args.actionId).slice(0, 80)}" — must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ (no "..") and be <= 64 chars`, "BAD_FILENAME");
        }
        if (!args.failedSelector || typeof args.failedSelector !== "string") {
            // Future enhancement: scan all selectors and find all stale ones.
            // For now require an explicit hint so the engine has a single target.
            return failResult("cdp_repair_action requires failedSelector — pass the testID that the prior maestro_run reported as missing", "BAD_FILENAME", {
                hint: "Future enhancement: scan all selectors automatically. For now, parse the maestro stderr for \"Element with id 'X' not found\" and pass X here.",
            });
        }
        const projectRoot = args.projectRoot ?? process.cwd();
        const action = loadAction(projectRoot, args.actionId);
        if (!action) {
            return failResult(`cdp_repair_action: action "${args.actionId}" not found at ${projectRoot}/.rn-agent/actions/${args.actionId}.yaml`, "NO_PROJECT_ROOT", {
                hint: "Verify the action exists with /list-learned-actions, or pass projectRoot if cdp-bridge is invoked outside the project directory.",
            });
        }
        // Phase 129 guardrail #1: respect human edits.
        if (actionWasEditedExternally(action)) {
            return failResult(`cdp_repair_action: action "${args.actionId}" YAML mtime is newer than the agent's last write — refusing to repair. A human likely edited it; reconcile manually before re-running.`, "STALE_TARGET", {
                actionId: args.actionId,
                filePath: action.filePath,
                lastSeenMtimeMs: action.state.lastSeenMtimeMs,
                hint: "If you intend to overwrite the human edit, manually re-trigger /run-action — that resets the lastSeenMtimeMs.",
            });
        }
        // Phase 129 guardrail #2: rolling 24h repair budget.
        if (!repairBudgetAvailable(action.state)) {
            return failResult(`cdp_repair_action: action "${args.actionId}" exhausted its 24h repair budget — refusing to repair. The corpus is signaling churn that needs human attention.`, "STALE_TARGET", {
                actionId: args.actionId,
                recentRepairs: recentRepairCount(action.state),
                hint: "Investigate why this action keeps drifting — usually means the underlying screen is being heavily refactored. Either redesign the action or wait for the screen to stabilise.",
            });
        }
        // GH #105 / B153: bring the target app to foreground before snapshot.
        // Without this, the snapshot lands on whichever app is frontmost — often
        // the Agent Device Runner (XCTest test rig) which has zero app testIDs.
        // GH #253 / B197: platform comes from the active device session (probe
        // fallback when none is open) — a hardcoded 'ios' made the whole repair
        // loop foreground via simctl, snapshot via the iOS short-circuit, and
        // bootstrap the iOS fast-runner against Android emulators. 'ios' remains
        // the final fallback for the no-session, no-device edge.
        const targetPlatform = (await detectPlatform()) ?? "ios";
        const targetBundleId = resolveBundleId(targetPlatform);
        if (targetBundleId) {
            await bringTargetAppToForeground(targetPlatform, targetBundleId);
        }
        // GH #105 iOS-MVP §3.7: bringTargetAppToForeground stopped any prior
        // fast-runner. The next snapshot needs OUR runner up — start it lazily
        // using the active session's deviceId, or fall back to simctl-discovery
        // when the auto-repair path was reached without a device session open.
        if (targetPlatform === "ios" && targetBundleId) {
            const deviceId = await resolveIOSDeviceIdForRepair();
            if (deviceId) {
                await ensureFastRunner(deviceId, targetBundleId);
            }
        }
        // Take a fresh device snapshot to see what testIDs are currently rendered.
        // GH #105 iOS-MVP: pass platform so runNative's iOS short-circuit fires
        // and routes through rn-fast-runner — otherwise dispatch falls through to
        // the legacy agent-device CLI path which hits the upstream AgentDeviceRunner.
        const snapResult = await runNative(["snapshot", "-i"], { platform: targetPlatform });
        const snapEnvelope = snapResult.content?.[0]?.text ?? "";
        if (snapshotEnvelopeFailed(snapEnvelope)) {
            return failResult(`cdp_repair_action: snapshot failed while gathering candidate testIDs for "${args.actionId}" — agent-device unreachable`, "SNAPSHOT_FAILED", {
                actionId: args.actionId,
                envelope: snapEnvelope.slice(0, 500),
                hint: "Run cdp_status / device_list to verify the device + agent-device session are healthy. Repair cannot proceed without a snapshot.",
            });
        }
        // GH #105 / B153: detect the agent-device-runner-leak sentinel BEFORE
        // returning the misleading TESTID_NOT_FOUND. A foregrounded test-app
        // with rendered components but with the runner stealing focus produces
        // a small (~6 node) tree of the runner's splash — exactly what
        // isAgentDeviceRunnerSentinel matches. The runner-leak error is far
        // more actionable than "snapshot returned 0 testIDs".
        const snapshotNodes = parseSnapshotNodes(snapEnvelope);
        if (snapshotNodes && isAgentDeviceRunnerSentinel(snapshotNodes)) {
            return failResult(`cdp_repair_action: snapshot returned the Agent Device Runner's own UI instead of the target app — repair cannot proceed`, "RUNNER_LEAK", {
                actionId: args.actionId,
                bundleId: targetBundleId,
                hint: `Bring the target app to foreground and retry (xcrun simctl launch booted ${targetBundleId ?? "<bundleId>"}). ` +
                    "If this persists, the agent-device daemon dropped appBundleId on dispatch — see B119/GH#35 + B153.",
            });
        }
        const candidates = extractAllTestIDs(snapEnvelope);
        if (candidates.length === 0) {
            return failResult(`cdp_repair_action: snapshot returned ok but contained 0 testIDs — cannot match any candidate`, "TESTID_NOT_FOUND", {
                actionId: args.actionId,
                hint: "The screen may not have any rendered elements with testIDs (e.g. you are on a loading screen, splash, or dev-client picker). Navigate to the target screen first.",
            });
        }
        // GH #317: transport-blindness guard. If the failed selector is BOTH used by
        // the action AND present verbatim in OUR live snapshot, the element is
        // rendered and rn-fast-runner can see it — Maestro/WDA reported "not visible"
        // because it read an empty a11y tree (e.g. iOS 26.2 + bridgeless), NOT because
        // the testID drifted. The body-membership check preserves the deliberate
        // BAD_FILENAME "your hint is wrong" diagnostic (Issue #102 A3). Fire BEFORE
        // attemptRepair, which filters the selector out of candidates and would
        // otherwise mislead ("no confident replacement") or mis-patch it.
        if (extractIdSelectors(action.body).includes(args.failedSelector) &&
            detectTransportBlind(args.failedSelector, candidates)) {
            return failResult(`cdp_repair_action: Maestro/WDA reported "${args.failedSelector}" not visible, but rn-fast-runner sees it (${candidates.length} testIDs in the live snapshot). This is transport-blindness, not testID drift — WDA reads an empty/partial accessibility tree on this runtime (e.g. iOS 26.2 + bridgeless, GH #317). Maestro-based replay is blocked here; drive the screen with device_* primitives (device_find/press/fill), which go through rn-fast-runner and work. rn-fast-runner-native action replay is tracked in #317 Phase 2.`, "TRANSPORT_BLIND", {
                actionId: args.actionId,
                failedSelector: args.failedSelector,
                snapshotTestIdCount: candidates.length,
                candidatesSample: candidates.slice(0, 50),
                hint: "Verify with device_snapshot — it uses rn-fast-runner. If the element is present there, this is a WDA transport limitation, not your testID.",
            });
        }
        const result = attemptRepair(action, args.failedSelector, candidates, args.threshold ?? DEFAULT_REPAIR_THRESHOLD);
        if (result.kind === "no-stale-selector") {
            // Issue #102 A3: this surfaces "the caller passed a failedSelector
            // that's not actually present in the YAML body" — a HINT bug, not
            // a screen-state bug. Distinct from TESTID_NOT_FOUND (which means
            // "we have a body selector but the live screen doesn't have it").
            // BAD_FILENAME is the codebase's existing umbrella for "the
            // caller's input doesn't match the contract" — reuse rather than
            // adding a new ToolErrorCode for a single call site.
            return failResult(`cdp_repair_action: ${result.reason}`, "BAD_FILENAME", {
                actionId: args.actionId,
                failedSelector: args.failedSelector,
                hint: "failedSelector is not present in the action body. Re-parse the Maestro stderr — the prior selector hint may be wrong.",
                bodyPreview: action.body.slice(0, 800),
            });
        }
        if (result.kind === "no-match") {
            return failResult(`cdp_repair_action: no confident replacement for "${args.failedSelector}". ${result.reason} If "${args.failedSelector}" is in fact correct and the screen renders, WDA may be transport-blind on this runtime (empty a11y tree; see GH #317) — confirm with device_snapshot, which uses rn-fast-runner.`, "TESTID_NOT_FOUND", {
                actionId: args.actionId,
                failedSelector: args.failedSelector,
                bestScore: result.bestScore,
                threshold: args.threshold ?? DEFAULT_REPAIR_THRESHOLD,
                candidatesSample: candidates.slice(0, 50),
                hint: "Either lower the threshold, or call device_snapshot manually + identify the new testID + edit the YAML by hand.",
            });
        }
        // result.kind === 'patched'
        if (args.dryRun) {
            return okResult({
                dryRun: true,
                actionId: args.actionId,
                oldSelector: result.oldSelector,
                newSelector: result.newSelector,
                score: result.score,
                replacements: result.replacements,
                diff: {
                    before: result.oldBody,
                    after: result.newBody,
                },
            });
        }
        const repaired = applyRepair(action, result, () => new Date(), args.agentReasoning);
        const { filePath, sidecarPath } = saveAction(repaired);
        return okResult({
            patched: true,
            actionId: args.actionId,
            oldSelector: result.oldSelector,
            newSelector: result.newSelector,
            score: result.score,
            replacements: result.replacements,
            newRevision: repaired.state.revision,
            newStatus: repaired.metadata.status,
            filePath,
            sidecarPath,
            hint: `Action patched. Re-run /run-action ${args.actionId} to verify. status reset to "${repaired.metadata.status}" until the next clean replay.`,
        });
    });
}
