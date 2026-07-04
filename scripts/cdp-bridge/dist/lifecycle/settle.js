export const SETTLE_DEFAULT_BUDGET_MS = 6000;
// Maestro parity: SCREEN_SETTLE_TIMEOUT_MS=3000 (IOSDriver.kt:487-504); hierarchy
// polling bounded 10×200ms (ScreenshotUtils.kt:38-74). Window-gate probe is 100ms
// (not Maestro's 500) so the static-screen path stays inside the spec's ≤150ms
// acceptance budget: 100ms probe + 50ms post-sleep.
const SCREEN_STATIC_TIER_MS = 3000;
const SCREEN_STATIC_POLL_INTERVAL_MS = 200;
const WINDOW_GATE_TIMEOUT_MS = 100;
const WINDOW_GATE_SETTLED_SLEEP_MS = 50;
const SNAPSHOT_POLL_MAX = 10;
const SNAPSHOT_POLL_INTERVAL_MS = 200;
export function settleEnabled(env) {
    const v = env.RN_SETTLE?.trim().toLowerCase();
    return v !== '0' && v !== 'false';
}
export async function waitForSettle(opts) {
    const { platform, capabilities, probes, initialSnapshotHash } = opts;
    const budgetMs = opts.budgetMs ?? SETTLE_DEFAULT_BUDGET_MS;
    const start = probes.now();
    const elapsed = () => probes.now() - start;
    const remaining = () => budgetMs - elapsed();
    if (platform === 'android' && capabilities.includes('WINDOW_UPDATE') && probes.isWindowUpdating) {
        const updating = await safeProbe(() => probes.isWindowUpdating(WINDOW_GATE_TIMEOUT_MS));
        if (updating === false) {
            // NB: false ≠ "our screen is static" — waitForWindowUpdate also returns
            // false immediately when the frontmost package differs (e.g. after a back
            // that left the app). Benign: nothing of ours left to settle.
            await probes.sleep(WINDOW_GATE_SETTLED_SLEEP_MS);
            return { settled: true, method: 'window-gate', ms: elapsed() };
        }
        // updating or probe failure → pay for snapshot polling below
    }
    if (platform === 'ios' && capabilities.includes('SCREEN_STATIC') && probes.isScreenStatic) {
        const tierDeadline = Math.min(SCREEN_STATIC_TIER_MS, budgetMs);
        while (elapsed() < tierDeadline) {
            const isStatic = await safeProbe(() => probes.isScreenStatic());
            if (isStatic === true)
                return { settled: true, method: 'screen-static', ms: elapsed() };
            if (isStatic === null)
                break; // probe infra failed — don't burn the tier budget
            await probes.sleep(SCREEN_STATIC_POLL_INTERVAL_MS);
        }
    }
    let prev = null;
    let hierarchyChanged;
    for (let i = 0; i < SNAPSHOT_POLL_MAX; i++) {
        if (remaining() <= 0)
            break;
        const hash = await safeProbe(() => probes.snapshotHash());
        if (typeof hash === 'string') {
            if (initialSnapshotHash !== undefined) {
                hierarchyChanged = hierarchyChanged === true || hash !== initialSnapshotHash;
            }
            if (prev !== null && hash === prev) {
                return {
                    settled: true,
                    method: 'snapshot-eq',
                    ms: elapsed(),
                    ...(hierarchyChanged !== undefined ? { hierarchyChanged } : {}),
                };
            }
            prev = hash;
        }
        await probes.sleep(SNAPSHOT_POLL_INTERVAL_MS);
    }
    return {
        settled: false,
        method: 'timeout',
        ms: elapsed(),
        ...(hierarchyChanged !== undefined ? { hierarchyChanged } : {}),
    };
}
async function safeProbe(fn) {
    try {
        return await fn();
    }
    catch {
        return null;
    }
}
