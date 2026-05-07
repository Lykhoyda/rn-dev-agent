import { runAgentDevice, hasActiveSession } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';

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

export interface PickerResult {
  dismissed: boolean;
  reason: string;
}

// GH #136: structural matcher for dev-client picker rows. The picker shows
// rows shaped like `<host>:<port>` — host may be a LAN IPv4 address, an
// Android emulator alias (10.0.2.2), a `.local` mDNS name, or a bare DNS
// hostname. The Metro port (default 8081, configurable) is the most reliable
// signal that we're looking at a server entry vs decorative text. Constraints:
//   - port must be 80..65535 (rejects version-string fragments like `0.76`)
//   - host must contain a letter or look like an IPv4 quad (rejects `:port`-only)
const PORT_PATTERN = /\b([\w.-]+):(\d{2,5})\b/g;

export function parsePortPatternEntry(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const match of text.matchAll(PORT_PATTERN)) {
    const host = match[1];
    const portNum = Number.parseInt(match[2], 10);
    if (portNum < 80 || portNum > 65535) continue;
    if (!/[A-Za-z]/.test(host) && !/\d+\.\d+\.\d+\.\d+/.test(host)) continue;
    return `${host}:${portNum}`;
  }
  return null;
}

// Rows that appear in the dev-client picker but are NOT server entries.
// Used as a deny-list for the first-non-header-row fallback when port-pattern
// matching fails (e.g., picker shows only the manifest name without the URL).
const FOOTER_ROWS = new Set([
  'Enter URL manually',
  'Fetch development servers',
  'Development servers',
  'DEVELOPMENT SERVERS',
  'Connect to a development build',
]);

const HEADER_PATTERNS = [/Development servers/i, /DEVELOPMENT SERVERS/];

/**
 * GH #136: orchestrates the picker matcher fallbacks. Matching priority:
 *   1. Literal `localhost` / `127.0.0.1` / `10.0.2.2` (preserves backward
 *      parity for known-good cases — these were the original heuristic).
 *   2. Port-pattern via parsePortPatternEntry (catches LAN IPs, .local
 *      hostnames, and DNS names that show up on real-world dev setups).
 *   3. First non-header, non-footer row below the picker title — the row
 *      a user would tap with their finger when the URL is hidden.
 *
 * Returns the literal text to pass to `device_find <text>` for tapping, or
 * null when the snapshot doesn't look like a dev-client picker at all.
 */
export function parseFirstServerEntry(snapshot: string | null | undefined): string | null {
  if (typeof snapshot !== 'string' || snapshot.length === 0) return null;

  for (const ip of ['localhost', '127.0.0.1', '10.0.2.2']) {
    if (snapshot.includes(ip)) return ip;
  }

  const portMatch = parsePortPatternEntry(snapshot);
  if (portMatch) return portMatch;

  const lines = snapshot.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  const headerIdx = lines.findIndex((line) => HEADER_PATTERNS.some((re) => re.test(line)));
  if (headerIdx === -1) return null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!FOOTER_ROWS.has(lines[i])) return lines[i];
  }
  return null;
}

export async function handleDevClientPicker(): Promise<PickerResult | null> {
  if (!hasActiveSession()) return null;

  // Step 1: Detect if the picker is showing
  for (const indicator of PICKER_INDICATORS) {
    try {
      const result = await runAgentDevice(['find', indicator]);
      if (!result.isError) {
        // Picker detected — try to tap a server entry
        return await dismissPicker();
      }
    } catch {
      continue;
    }
  }

  return { dismissed: false, reason: 'Dev Client picker not detected' };
}

async function dismissPicker(): Promise<PickerResult> {
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

async function waitForBundle(): Promise<void> {
  // Wait for the JS bundle to load after tapping a server entry.
  // Poll rather than fixed sleep — check every 2s for up to 20s.
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    // Check if the picker is gone (a heuristic: if "Development servers" is no longer visible)
    const check = await runAgentDevice(['find', 'Development servers']);
    if (check.isError) return; // Picker gone — bundle loaded
  }
}

/**
 * Quick check: is the Dev Client picker likely showing?
 * Uses device_find without tapping — lighter than full handleDevClientPicker.
 */
export async function isDevClientPickerShowing(): Promise<boolean> {
  if (!hasActiveSession()) return false;

  for (const indicator of PICKER_INDICATORS) {
    try {
      const result = await runAgentDevice(['find', indicator]);
      if (!result.isError) return true;
    } catch {
      continue;
    }
  }

  return false;
}
