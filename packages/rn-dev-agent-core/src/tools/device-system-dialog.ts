import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { detectPlatform } from './platform-utils.js';
import { fetchSnapshotNodes, pressCandidate } from './device-interact.js';
import type { SnapshotFetchResult } from './device-interact.js';
import { hasActiveSession, getActiveSession } from '../agent-device-wrapper.js';

// iOS dialog button labels. Note: "Don't Allow" uses U+2019 typographic apostrophe,
// not ASCII '. We emit both spellings so the first-matching Maestro step wins.
const APOSTROPHE_ASCII = "'";
const APOSTROPHE_CURLY = '\u2019';

const ACCEPT_LABELS_IOS = [
  'Allow',
  'Allow Once',
  'Allow While Using App',
  'OK',
  'Open',
  'Continue',
  'Yes',
  'Accept',
];

const DISMISS_LABELS_IOS_BASE = ['Cancel', 'No', 'Deny', 'Not Now', 'Reject'];

const DISMISS_LABELS_IOS = [
  ...DISMISS_LABELS_IOS_BASE,
  `Don${APOSTROPHE_ASCII}t Allow`,
  `Don${APOSTROPHE_CURLY}t Allow`,
];

const ACCEPT_LABELS_ANDROID = [
  'Allow',
  'ALLOW',
  'While using the app',
  'Only this time',
  'OK',
  'Open',
  'Continue',
  'Yes',
];

const DISMISS_LABELS_ANDROID = ['Deny', 'DENY', 'Cancel', 'CANCEL', 'No', 'Not now'];

export interface SystemDialogArgs {
  label?: string;
  platform?: 'ios' | 'android';
  timeoutMs?: number;
}

// GH #545 test seams — same pattern as dev-client-picker.ts: production code
// calls through these indirections so unit tests can swap mocks without
// touching the fast-runner or a live session.
let fetchSnapshotNodesFn: typeof fetchSnapshotNodes = fetchSnapshotNodes;
let pressCandidateFn: typeof pressCandidate = pressCandidate;
let iosSessionActiveFn: () => boolean = () =>
  hasActiveSession() && getActiveSession()?.platform === 'ios';

export function _setFetchSnapshotNodesForTest(fn: typeof fetchSnapshotNodes): void {
  fetchSnapshotNodesFn = fn;
}
export function _resetFetchSnapshotNodesForTest(): void {
  fetchSnapshotNodesFn = fetchSnapshotNodes;
}
export function _setPressCandidateForTest(fn: typeof pressCandidate): void {
  pressCandidateFn = fn;
}
export function _resetPressCandidateForTest(): void {
  pressCandidateFn = pressCandidate;
}
export function _setIosSessionActiveForTest(value: boolean): void {
  iosSessionActiveFn = () => value;
}
export function _resetIosSessionActiveForTest(): void {
  iosSessionActiveFn = () => hasActiveSession() && getActiveSession()?.platform === 'ios';
}

export interface RunnerDialogOutcome {
  tapped: boolean;
  matchedLabel?: string;
  dialogTitle?: string;
  availableButtons?: string[];
}

/**
 * GH #545: Maestro's iOS driver only sees the app under test, so a
 * SpringBoard-owned dialog (the deeplink "Open in <app>?" confirmation,
 * permission prompts) never matches a tapOn probe — every label times out at
 * ~4s and the tool reports DIALOG_NOT_FOUND while the dialog sits on screen.
 * The rn-fast-runner CAN see it: when a blocking SpringBoard modal is up, its
 * snapshot returns that modal exclusively as an Alert-rooted payload
 * (RnFastRunnerTests+SystemModal.swift), and press resolves to a coordinate
 * tap that lands on whatever owns the pixels.
 *
 * Returns null when the runner path does not apply (no open iOS session,
 * snapshot failed, or no blocking SpringBoard modal) — callers fall back to
 * the Maestro probe, which still covers Android and in-app alerts. Returns
 * tapped:false with the dialog's actual buttons when the modal is up but no
 * probed label matched, so the agent can retry with an exact label instead
 * of burning the Maestro timeout on a dialog Maestro cannot reach.
 */
export async function tapSystemDialogViaRunner(
  labels: string[],
): Promise<RunnerDialogOutcome | null> {
  if (!iosSessionActiveFn()) return null;
  let snap: SnapshotFetchResult;
  try {
    snap = await fetchSnapshotNodesFn(false);
  } catch {
    return null;
  }
  if (!snap.ok) return null;
  const root = snap.nodes[0];
  if (!root || root.type !== 'Alert') return null;
  const buttons = snap.nodes.slice(1);
  for (const label of labels) {
    const match = buttons.find((n) => n.label === label || n.identifier === label);
    if (!match) continue;
    const press = await pressCandidateFn({ ref: match.ref, label: match.label }, 'click');
    if (press.isError) continue;
    return { tapped: true, matchedLabel: label, dialogTitle: root.label };
  }
  return {
    tapped: false,
    dialogTitle: root.label,
    availableButtons: buttons.map((n) => n.label ?? n.identifier ?? '').filter((l) => l.length > 0),
  };
}

// GH #545: `simctl openurl` for a custom scheme raises a SpringBoard
// "Open in <app>?" confirmation on newer iOS runtimes (observed on 26.2).
// Accepting it is the deeplink caller's declared intent, so only "Open" is
// probed. The dialog animates in after openurl returns — when no modal is
// visible yet, one short retry covers the animation window.
const OPEN_CONFIRMATION_LABELS = ['Open'];
const OPEN_CONFIRMATION_RETRY_DELAY_MS = 750;

export async function acceptDeeplinkOpenConfirmation(): Promise<RunnerDialogOutcome | null> {
  // Without an open iOS session the runner cannot reach a SpringBoard dialog
  // at all — bail before the retry timer so a session-less deeplink (the common
  // CLI path) never eats a dead 750ms wait for a probe that must return null.
  if (!iosSessionActiveFn()) return null;
  const first = await tapSystemDialogViaRunner(OPEN_CONFIRMATION_LABELS);
  if (first) return first;
  await new Promise((r) => setTimeout(r, OPEN_CONFIRMATION_RETRY_DELAY_MS));
  return tapSystemDialogViaRunner(OPEN_CONFIRMATION_LABELS);
}

// Per-label timeout when sequentially probing dialog buttons. Intentionally short —
// if the label is not visible, Maestro should fail fast so we can try the next label.
const PER_LABEL_TIMEOUT_MS = 4_000;

async function tapSystemDialog(
  labels: string[],
  platform: 'ios' | 'android',
  totalTimeoutMs: number,
  slug: string,
): Promise<ToolResult> {
  // Sequential single-label flows. Each flow has one NON-optional tapOn — so
  // Maestro's exit code actually reflects whether the tap happened. First success wins.
  // This is slower than an all-optional flow (up to N * per_label_timeout) but correct:
  // the all-optional pattern silently returns passed=true when nothing was tapped.
  const deadline = Date.now() + totalTimeoutMs;
  const attempts: Array<{ label: string; error?: string; output?: string }> = [];

  for (const label of labels) {
    // Clamp each probe to the time actually left, not a fixed slice of the
    // original total — otherwise the deadline only gates *starting* a probe and
    // the default 8-label list could run ~8×4s past a 15s `timeoutMs`.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return warnResult(
        { tapped: false, platform, triedLabels: labels, attempts },
        `System dialog probe exceeded ${totalTimeoutMs}ms without a match.`,
        { code: 'DIALOG_NOT_FOUND' },
      );
    }
    const perLabelMs = Math.min(PER_LABEL_TIMEOUT_MS, remainingMs);
    const yaml = `- tapOn:\n    text: "${yamlEscape(label)}"`;
    const result = await runMaestroInline(yaml, { platform, timeoutMs: perLabelMs, slug });
    if (result.passed) {
      return okResult({ tapped: true, platform, matchedLabel: label, triedLabels: labels });
    }
    attempts.push({
      label,
      error: result.error,
      output: result.output ? result.output.slice(0, 200) : undefined,
    });
  }

  // GH #545: on iOS a Maestro miss can also mean the dialog is SpringBoard-owned
  // and simply invisible to Maestro — point at the runner path and the
  // last-resort SpringBoard restart instead of implying the dialog isn't there.
  const iosHint =
    platform === 'ios'
      ? ' If the dialog is visible on screen, it is likely SpringBoard-owned and invisible to Maestro — open a device session (device_snapshot action="open") and retry so the native runner path can reach it. Last resort for a stuck dialog: xcrun simctl spawn <udid> launchctl kickstart -k system/com.apple.SpringBoard (app install survives; relaunch the app afterwards).'
      : '';
  return warnResult(
    { tapped: false, platform, triedLabels: labels, attempts },
    `No matching system dialog button found. The dialog may not be visible yet, or the button label differs from known variants. Call device_screenshot to verify the dialog is up, or pass a specific label.${iosHint}`,
    { code: 'DIALOG_NOT_FOUND' },
  );
}

function pickLabels(userLabel: string | undefined, defaults: string[]): string[] {
  if (!userLabel) return defaults;
  // Put user label first, then defaults as fallback. Dedupe while preserving order.
  const seen = new Set<string>();
  return [userLabel, ...defaults].filter((l) => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
}

async function handleSystemDialog(
  args: SystemDialogArgs,
  iosDefaults: string[],
  androidDefaults: string[],
  slug: string,
): Promise<ToolResult> {
  const platform = args.platform ?? (await detectPlatform());
  if (!platform) {
    return failResult('No device detected. Pass platform or boot a device first.', {
      code: 'NO_DEVICE',
    });
  }
  const defaults = platform === 'ios' ? iosDefaults : androidDefaults;
  const labels = pickLabels(args.label, defaults);
  if (platform === 'ios') {
    const runner = await tapSystemDialogViaRunner(labels);
    if (runner?.tapped) {
      return okResult({
        tapped: true,
        platform,
        matchedLabel: runner.matchedLabel,
        dialogTitle: runner.dialogTitle,
        via: 'rn-fast-runner',
      });
    }
    if (runner) {
      // A SpringBoard dialog IS up but none of the probed labels matched its
      // buttons. Maestro cannot see this dialog at all — surface the real
      // buttons instead of burning N×4s on probes that can never match.
      return warnResult(
        {
          tapped: false,
          platform,
          dialogTitle: runner.dialogTitle,
          availableButtons: runner.availableButtons,
          triedLabels: labels,
        },
        `A system dialog${runner.dialogTitle ? ` ("${runner.dialogTitle}")` : ''} is on screen but none of the probed labels matched its buttons. Retry with label set to one of availableButtons.`,
        { code: 'DIALOG_BUTTON_NOT_FOUND' },
      );
    }
  }
  return tapSystemDialog(labels, platform, args.timeoutMs ?? 15_000, slug);
}

export function createDeviceAcceptSystemDialogHandler(): (
  args: SystemDialogArgs,
) => Promise<ToolResult> {
  return async (args) =>
    handleSystemDialog(args, ACCEPT_LABELS_IOS, ACCEPT_LABELS_ANDROID, 'sys-accept');
}

export function createDeviceDismissSystemDialogHandler(): (
  args: SystemDialogArgs,
) => Promise<ToolResult> {
  return async (args) =>
    handleSystemDialog(args, DISMISS_LABELS_IOS, DISMISS_LABELS_ANDROID, 'sys-dismiss');
}
