import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { detectPlatform } from './platform-utils.js';

const DEFAULT_PICKER_TIMEOUT_MS = 20_000;

// Names of months used to decompose an ISO date into tappable picker values.
// Full English names — matches the strings UIDatePicker exposes via accessibility.
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

export interface PickValueArgs {
  value: string;
  pickerTestId?: string;
  platform?: 'ios' | 'android';
  timeoutMs?: number;
}

export interface PickDateArgs {
  date: string; // YYYY-MM-DD or ISO 8601
  pickerTestId?: string;
  platform?: 'ios' | 'android';
  timeoutMs?: number;
}

interface ParsedDate {
  year: number;
  month: number; // 1-12
  day: number;
  monthName: string;
}

function parseISODate(date: string): ParsedDate | null {
  // Accept YYYY-MM-DD, YYYY-MM-DDTHH:mm, and full ISO 8601. Ignore time component.
  const match = date.match(ISO_DATE_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, monthName: MONTH_NAMES[month - 1] };
}

function buildOpenPickerSteps(pickerTestId: string | undefined): string {
  if (!pickerTestId) return '';
  return `- tapOn:\n    id: "${yamlEscape(pickerTestId)}"\n    optional: true\n`;
}

export function createDevicePickValueHandler(): (args: PickValueArgs) => Promise<ToolResult> {
  return async (args) => {
    if (!args.value) {
      return failResult('value is required', { code: 'INVALID_ARGS' });
    }
    const platform = args.platform ?? (await detectPlatform());
    if (!platform) {
      return failResult('No device detected. Pass platform or boot a device first.', {
        code: 'NO_DEVICE',
      });
    }

    const open = buildOpenPickerSteps(args.pickerTestId);
    const yaml = `${open}- tapOn:\n    text: "${yamlEscape(args.value)}"`;

    const result = await runMaestroInline(yaml, {
      platform,
      timeoutMs: args.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS,
      slug: 'pick-value',
    });

    if (result.passed) {
      return okResult({ picked: true, value: args.value, platform });
    }
    if (result.error) {
      return failResult(`Pick value failed: ${result.error}`, {
        code: 'PICK_FAILED',
        value: args.value,
        flowFile: result.flowFile,
      });
    }
    return warnResult(
      { picked: false, value: args.value, output: result.output.slice(0, 500) },
      `Value "${args.value}" was not tappable. The picker may not be open, or the value may not be visible in the current scroll position (scroll-to-visible is not yet implemented).`,
      { code: 'VALUE_NOT_VISIBLE' },
    );
  };
}

export function createDevicePickDateHandler(): (args: PickDateArgs) => Promise<ToolResult> {
  return async (args) => {
    const parsed = parseISODate(args.date);
    if (!parsed) {
      return failResult(`Invalid date "${args.date}". Expected YYYY-MM-DD or ISO 8601.`, {
        code: 'INVALID_ARGS',
      });
    }
    const platform = args.platform ?? (await detectPlatform());
    if (!platform) {
      return failResult('No device detected. Pass platform or boot a device first.', {
        code: 'NO_DEVICE',
      });
    }

    // Run each wheel component as a separate non-optional flow. First failure stops
    // the chain and returns which components succeeded. This avoids the all-optional
    // false-positive trap where Maestro exits 0 with zero steps run.
    const components: Array<{ name: string; value: string | number }> = [
      { name: 'month', value: parsed.monthName },
      { name: 'day', value: parsed.day },
      { name: 'year', value: parsed.year },
    ];
    const succeeded: string[] = [];
    const perStepTimeout = Math.round(
      (args.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS) / components.length,
    );

    // Open the picker first (optional — already-open pickers are a no-op).
    if (args.pickerTestId) {
      const openYaml = `- tapOn:\n    id: "${yamlEscape(args.pickerTestId)}"\n    optional: true`;
      await runMaestroInline(openYaml, { platform, timeoutMs: 4_000, slug: 'pick-date-open' });
    }

    for (const comp of components) {
      const yaml = `- tapOn:\n    text: "${yamlEscape(String(comp.value))}"`;
      const result = await runMaestroInline(yaml, {
        platform,
        timeoutMs: perStepTimeout,
        slug: `pick-date-${comp.name}`,
      });
      if (result.passed) {
        succeeded.push(comp.name);
      } else {
        return warnResult(
          {
            picked: false,
            date: args.date,
            succeeded,
            failedAt: comp.name,
            failedValue: String(comp.value),
            error: result.error,
          },
          `Picker could not tap ${comp.name} "${comp.value}". Common causes: calendar mode (not wheels), value not visible in current scroll position, or ambiguous text match. Pass pickerTestId to scope taps to the picker.`,
          { code: 'PICK_DATE_INCOMPLETE' },
        );
      }
    }

    return okResult({
      picked: true,
      date: args.date,
      parsed: { year: parsed.year, month: parsed.month, day: parsed.day },
      platform,
      succeeded,
    });
  };
}
