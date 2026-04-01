import { runAgentDevice, hasActiveSession } from '../agent-device-wrapper.js';
/**
 * Detect and dismiss the Expo Dev Client server picker.
 *
 * The picker appears after deep links, app restarts, permission changes,
 * or clearState. It's a native screen (not React) so CDP tools can't see it.
 * Uses device_find via agent-device to detect "Development servers" text
 * and tap the first available Metro server entry.
 *
 * Returns:
 *   - { dismissed: true } if picker was found and tapped
 *   - { dismissed: false, reason: '...' } if not detected or no session
 *   - null if no active device session (silent skip)
 */
const PICKER_INDICATORS = [
    'Development servers',
    'DEVELOPMENT SERVERS',
];
const SERVER_ENTRY_INDICATORS = [
    'localhost',
    '127.0.0.1',
    '10.0.2.2',
];
export async function handleDevClientPicker() {
    if (!hasActiveSession())
        return null;
    // Step 1: Detect if the picker is showing
    for (const indicator of PICKER_INDICATORS) {
        try {
            const result = await runAgentDevice(['find', indicator]);
            if (!result.isError) {
                // Picker detected — try to tap a server entry
                return await dismissPicker();
            }
        }
        catch {
            continue;
        }
    }
    return { dismissed: false, reason: 'Dev Client picker not detected' };
}
async function dismissPicker() {
    // Try known server entry patterns first
    for (const entry of SERVER_ENTRY_INDICATORS) {
        const result = await runAgentDevice(['find', entry, 'click']);
        if (!result.isError) {
            await waitForBundle();
            return { dismissed: true, reason: `Tapped server entry matching "${entry}"` };
        }
    }
    // Fallback: take a snapshot and look for any IP-address-like element
    const snapshot = await runAgentDevice(['snapshot', '-i']);
    if (!snapshot.isError) {
        const text = snapshot.content[0]?.text ?? '';
        // Look for IP addresses (LAN, tunnel, etc.) in the snapshot text
        const ipMatch = text.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
        if (ipMatch) {
            const result = await runAgentDevice(['find', ipMatch[1], 'click']);
            if (!result.isError) {
                await waitForBundle();
                return { dismissed: true, reason: `Tapped server entry at ${ipMatch[1]}` };
            }
        }
    }
    return {
        dismissed: false,
        reason: 'Dev Client picker detected but could not find a server entry to tap. Select the Metro server manually.',
    };
}
async function waitForBundle() {
    // Wait for the JS bundle to load after tapping a server entry.
    // Poll rather than fixed sleep — check every 2s for up to 20s.
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        // Check if the picker is gone (a heuristic: if "Development servers" is no longer visible)
        const check = await runAgentDevice(['find', 'Development servers']);
        if (check.isError)
            return; // Picker gone — bundle loaded
    }
}
/**
 * Quick check: is the Dev Client picker likely showing?
 * Uses device_find without tapping — lighter than full handleDevClientPicker.
 */
export async function isDevClientPickerShowing() {
    if (!hasActiveSession())
        return false;
    for (const indicator of PICKER_INDICATORS) {
        try {
            const result = await runAgentDevice(['find', indicator]);
            if (!result.isError)
                return true;
        }
        catch {
            continue;
        }
    }
    return false;
}
