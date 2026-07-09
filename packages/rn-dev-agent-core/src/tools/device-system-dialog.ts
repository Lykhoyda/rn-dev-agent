import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { detectPlatform } from './platform-utils.js';

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
  const perLabelMs = Math.min(PER_LABEL_TIMEOUT_MS, totalTimeoutMs);
  const deadline = Date.now() + totalTimeoutMs;
  const attempts: Array<{ label: string; error?: string; output?: string }> = [];

  for (const label of labels) {
    if (Date.now() >= deadline) {
      return warnResult(
        { tapped: false, platform, triedLabels: labels, attempts },
        `System dialog probe exceeded ${totalTimeoutMs}ms without a match.`,
        { code: 'DIALOG_NOT_FOUND' },
      );
    }
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

  return warnResult(
    { tapped: false, platform, triedLabels: labels, attempts },
    'No matching system dialog button found. The dialog may not be visible yet, or the button label differs from known variants. Call device_screenshot to verify the dialog is up, or pass a specific label.',
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

export function createDeviceAcceptSystemDialogHandler(): (
  args: SystemDialogArgs,
) => Promise<ToolResult> {
  return async (args) => {
    const platform = args.platform ?? (await detectPlatform());
    if (!platform) {
      return failResult('No device detected. Pass platform or boot a device first.', {
        code: 'NO_DEVICE',
      });
    }
    const defaults = platform === 'ios' ? ACCEPT_LABELS_IOS : ACCEPT_LABELS_ANDROID;
    const labels = pickLabels(args.label, defaults);
    return tapSystemDialog(labels, platform, args.timeoutMs ?? 15_000, 'sys-accept');
  };
}

export function createDeviceDismissSystemDialogHandler(): (
  args: SystemDialogArgs,
) => Promise<ToolResult> {
  return async (args) => {
    const platform = args.platform ?? (await detectPlatform());
    if (!platform) {
      return failResult('No device detected. Pass platform or boot a device first.', {
        code: 'NO_DEVICE',
      });
    }
    const defaults = platform === 'ios' ? DISMISS_LABELS_IOS : DISMISS_LABELS_ANDROID;
    const labels = pickLabels(args.label, defaults);
    return tapSystemDialog(labels, platform, args.timeoutMs ?? 15_000, 'sys-dismiss');
  };
}
