import { execFileSync } from 'node:child_process';
import type { StalenessCheck, PlaybookEntry, SelfHealResult, NavMethod } from './types.js';
import { readGraph, writeGraph } from './storage.js';

function gitExec(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function getHeadCommit(projectRoot: string): string | null {
  return gitExec(['rev-parse', 'HEAD'], projectRoot);
}

export function getChangedNavFiles(fromCommit: string, projectRoot: string): string[] | null {
  if (!/^[0-9a-f]{4,40}$/i.test(fromCommit)) return null;

  const diff = gitExec(['diff', '--name-only', fromCommit, 'HEAD'], projectRoot);
  if (diff === null) return null;
  if (diff === '') return [];

  const allChanged = diff.split('\n').filter(Boolean);
  return allChanged.filter(file => {
    const lower = file.toLowerCase();
    return lower.includes('navigator')
      || lower.includes('navigation')
      || /\broutes?\b/.test(lower)
      || lower.includes('linking')
      || /screen/i.test(lower.split('/').pop() ?? '')
      || lower.endsWith('app.json')
      || lower.includes('app.config');
  });
}

export function checkStaleness(projectRoot: string): StalenessCheck {
  const graph = readGraph(projectRoot);
  if (!graph) {
    return {
      stale: true,
      reason: 'No graph found',
      nav_files_changed: [],
      recommendation: 'rescan_required',
    };
  }

  const currentCommit = getHeadCommit(projectRoot);
  const scannedCommit = graph.meta.scanned_at_commit;

  if (!currentCommit) {
    const lastScanTime = new Date(graph.meta.last_scanned_at).getTime();
    const stale = Number.isNaN(lastScanTime) || Date.now() - lastScanTime > 24 * 60 * 60 * 1000;
    return {
      stale,
      reason: stale ? 'Graph is over 24h old and git is not available' : undefined,
      nav_files_changed: [],
      recommendation: stale ? 'rescan_recommended' : 'ok',
    };
  }

  if (!scannedCommit) {
    return {
      stale: true,
      reason: 'Graph was created before git tracking was added',
      current_commit: currentCommit,
      nav_files_changed: [],
      recommendation: 'rescan_recommended',
    };
  }

  if (scannedCommit === currentCommit) {
    return {
      stale: false,
      scanned_at_commit: scannedCommit,
      current_commit: currentCommit,
      nav_files_changed: [],
      recommendation: 'ok',
    };
  }

  const changedNavFiles = getChangedNavFiles(scannedCommit, projectRoot);

  if (changedNavFiles === null) {
    return {
      stale: true,
      reason: 'Cannot diff from scanned commit (may have been rebased or force-pushed)',
      scanned_at_commit: scannedCommit,
      current_commit: currentCommit,
      nav_files_changed: [],
      recommendation: 'rescan_recommended',
    };
  }

  if (changedNavFiles.length > 0) {
    return {
      stale: true,
      reason: `${changedNavFiles.length} navigation file(s) changed since last scan`,
      scanned_at_commit: scannedCommit,
      current_commit: currentCommit,
      nav_files_changed: changedNavFiles,
      recommendation: 'rescan_required',
    };
  }

  return {
    stale: false,
    reason: 'Code changed but no navigation files affected',
    scanned_at_commit: scannedCommit,
    current_commit: currentCommit,
    nav_files_changed: [],
    recommendation: 'ok',
  };
}

export function stampGraphWithCommit(projectRoot: string): void {
  const graph = readGraph(projectRoot);
  if (!graph) return;

  const commit = getHeadCommit(projectRoot);
  if (!commit) return;

  graph.meta.scanned_at_commit = commit;

  try {
    writeGraph(projectRoot, graph);
  } catch { /* best effort */ }
}

// --- Action Playbook ---

const PLAYBOOK: PlaybookEntry[] = [
  {
    context: 'tap_bottom_tab',
    platform: 'android',
    use: 'cdp_navigate (programmatic)',
    avoid: 'device_press on bottom tab bar',
    reason: 'Android gesture navigation bar intercepts taps near bottom edge (D434)',
  },
  {
    context: 'tap_near_gear_icon',
    platform: 'ios',
    use: 'device_press(@ref) from device_snapshot',
    avoid: 'coordinate-based taps',
    reason: 'Expo Dev Client gear icon (40px hitbox) intercepts coordinate taps',
  },
  {
    context: 'deep_link_navigation',
    platform: 'both',
    use: 'cdp_evaluate with __NAV_REF__.navigate()',
    avoid: 'simctl openurl / adb shell am start',
    reason: 'Deep links trigger system dialogs, Safari confirmation, or Dev Client picker (GH #9)',
  },
  {
    context: 'text_input_special_chars',
    platform: 'android',
    use: "device_fill (single-quote wrapping)",
    avoid: 'adb shell input text with backslash escaping',
    reason: 'execFile bypasses local shell, Android shell still interprets $ and special chars (D433)',
  },
  {
    context: 'system_dialog_dismiss',
    platform: 'ios',
    use: 'device_find + device_press on dialog button',
    avoid: 'simctl privacy (broken for notifications on iOS 26+)',
    reason: 'System dialogs are native, invisible to CDP',
  },
  {
    context: 'dev_client_picker',
    platform: 'both',
    use: 'device_find("Development servers") + auto-tap Metro entry',
    avoid: 'waiting or manual intervention',
    reason: 'Picker blocks all navigation until dismissed (GH #9, D424-D426)',
  },
  {
    context: 'registration_flow',
    platform: 'both',
    use: 'Maestro subflow via maestro-runner',
    avoid: 'manual device_fill/device_press sequences',
    reason: 'Maestro handles complex multi-step flows reliably; maestro-runner avoids JVM overhead',
  },
  {
    context: 'app_reload_after_change',
    platform: 'both',
    use: 'cdp_reload → wait for cdp_status ok',
    avoid: 'device_press on refresh button',
    reason: 'cdp_reload handles reconnection, helper re-injection, and target re-validation',
  },
];

export function getPlaybook(platform?: 'ios' | 'android'): PlaybookEntry[] {
  if (!platform) return PLAYBOOK;
  return PLAYBOOK.filter(e => e.platform === platform || e.platform === 'both');
}

export function getPlaybookForContext(context: string, platform?: 'ios' | 'android'): PlaybookEntry | null {
  const filtered = platform
    ? PLAYBOOK.filter(e => e.platform === platform || e.platform === 'both')
    : PLAYBOOK;
  return filtered.find(e => e.context === context) ?? null;
}

// --- Self-Healing ---

export function buildSelfHealAdvice(
  failedScreen: string,
  failedMethod: NavMethod,
  platform: 'ios' | 'android' | null,
): SelfHealResult {
  const advice: string[] = [];
  let recoveryMethod: string | undefined;

  if (failedMethod === 'programmatic') {
    advice.push('Programmatic navigation failed — __NAV_REF__ may be unavailable or screen name may have changed.');
    advice.push('1. Re-scan graph: cdp_nav_graph action="scan" force=true');
    advice.push('2. Verify screen exists in updated graph');
    advice.push('3. Try UI interaction: device_find("<screen label>") + device_press');
    recoveryMethod = 'rescan_then_ui_fallback';
  } else if (failedMethod === 'deep_link') {
    advice.push('Deep link failed — may have triggered Dev Client picker or system dialog.');
    advice.push('1. Check for Dev Client picker: cdp_status (auto-handles picker)');
    advice.push('2. Fall back to programmatic: cdp_navigate');
    advice.push('3. If programmatic also fails, use UI interaction');
    recoveryMethod = 'dismiss_picker_then_programmatic';
  } else {
    advice.push('UI interaction failed — element may not be visible or accessible.');
    advice.push('1. Take screenshot: device_screenshot');
    advice.push('2. Re-snapshot: device_snapshot action=snapshot');
    advice.push('3. Try programmatic: cdp_navigate');
    recoveryMethod = 'screenshot_then_programmatic';
  }

  if (platform === 'android') {
    const tabEntry = getPlaybookForContext('tap_bottom_tab', 'android');
    if (tabEntry) advice.push(`Android note: ${tabEntry.reason}`);
  }
  if (platform === 'ios') {
    const gearEntry = getPlaybookForContext('tap_near_gear_icon', 'ios');
    if (gearEntry) advice.push(`iOS note: ${gearEntry.reason}`);
  }

  return {
    original_failure: `Navigation to "${failedScreen}" via ${failedMethod} failed`,
    recovery_attempted: false,
    recovery_method: recoveryMethod,
    recovered: false,
    note: advice.join('\n'),
  };
}
