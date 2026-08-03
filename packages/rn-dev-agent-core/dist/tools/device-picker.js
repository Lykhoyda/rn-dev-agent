import { okResult, failResult, warnResult } from '../utils.js';
import { maestroRefusalResult, runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { detectPlatform } from './platform-utils.js';
import { buildStepSummary } from '../domain/maestro-step-parser.js';
const DEFAULT_PICKER_TIMEOUT_MS = 120_000;
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
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
export function parseISODate(date) {
    const match = date.match(ISO_DATE_PATTERN);
    if (!match)
        return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isSafeInteger(year) || year < 1 || year > 9999)
        return null;
    const candidate = new Date(0);
    candidate.setUTCHours(0, 0, 0, 0);
    candidate.setUTCFullYear(year, month - 1, day);
    if (candidate.getUTCFullYear() !== year ||
        candidate.getUTCMonth() !== month - 1 ||
        candidate.getUTCDate() !== day) {
        return null;
    }
    return { year, month, day, monthName: MONTH_NAMES[month - 1] };
}
function buildOpenPickerSteps(pickerTestId) {
    if (!pickerTestId)
        return '';
    return `- tapOn:\n    id: "${yamlEscape(pickerTestId)}"\n    optional: true\n`;
}
function dateTapStep(value, pickerScopeTestId) {
    const scope = pickerScopeTestId
        ? `\n    childOf:\n      id: "${yamlEscape(pickerScopeTestId)}"`
        : '';
    return `- tapOn:\n    text: "${yamlEscape(value)}"${scope}`;
}
function stepTargetsQuotedValue(stepName, value) {
    return stepName.includes(`"${value}"`) || stepName.includes(`'${value}'`);
}
function stepTargetsIdValue(stepName, value) {
    return (/\btap(?:ping)?\s+on\s+(?:element\s+with\s+)?id\b/i.test(stepName) &&
        stepTargetsQuotedValue(stepName, value));
}
function stepTargetsTextValue(stepName, value) {
    return !stepTargetsIdValue(stepName, value) && stepTargetsQuotedValue(stepName, value);
}
export function createDevicePickValueHandler(invoke = runMaestroInline) {
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
        const result = await invoke(yaml, {
            platform,
            timeoutMs: args.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS,
            slug: 'pick-value',
            authorityArgs: args,
        });
        if (result.passed) {
            return okResult({ picked: true, value: args.value, platform });
        }
        if (result.error) {
            return failResult(`Pick value failed: ${result.error}`, {
                code: result.errorCode ?? 'PICK_FAILED',
                value: args.value,
                flowFile: result.flowFile,
            });
        }
        return warnResult({ picked: false, value: args.value, output: result.output.slice(0, 500) }, `Value "${args.value}" was not tappable. The picker may not be open, or the value may not be visible in the current scroll position (scroll-to-visible is tracked separately in issue #27).`, { code: 'VALUE_NOT_VISIBLE' });
    };
}
export function createDevicePickDateHandler(invoke = runMaestroInline) {
    return async (args) => {
        const parsed = parseISODate(args.date);
        if (!parsed) {
            return failResult(`Invalid date "${args.date}". Expected a real YYYY-MM-DD calendar date or ISO 8601 timestamp.`, {
                code: 'INVALID_ARGS',
            });
        }
        const platform = args.platform ?? (await detectPlatform());
        if (!platform) {
            return failResult('No device detected. Pass platform or boot a device first.', {
                code: 'NO_DEVICE',
            });
        }
        const components = [
            { name: 'month', value: parsed.monthName },
            { name: 'day', value: String(parsed.day) },
            { name: 'year', value: String(parsed.year) },
        ];
        const opener = args.openerTestId ?? args.pickerTestId;
        const yaml = [
            buildOpenPickerSteps(opener).trimEnd(),
            ...components.map((component) => dateTapStep(component.value, args.pickerScopeTestId)),
        ]
            .filter(Boolean)
            .join('\n');
        // One whole-flow deadline: iOS Maestro cold start is approximately 114 s,
        // so dividing 20 s across three independent WDA launches guaranteed the
        // first component would time out regardless of selector visibility.
        const result = await invoke(yaml, {
            platform,
            timeoutMs: args.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS,
            slug: 'pick-date',
            authorityArgs: args,
        });
        if (result.passed) {
            return okResult({
                picked: true,
                date: args.date,
                parsed: { year: parsed.year, month: parsed.month, day: parsed.day },
                platform,
                succeeded: components.map((component) => component.name),
            });
        }
        const refusal = maestroRefusalResult(result, 'Maestro date picker flow was refused.', {
            picked: false,
            date: args.date,
            platform,
        });
        if (refusal)
            return refusal;
        const summary = buildStepSummary(result.output, { failed: true });
        const observedComponentFailure = summary.steps.some((step) => step.status === 'fail' &&
            components.some((component) => stepTargetsTextValue(step.name, component.value)));
        if (result.error && !result.timedOut && !observedComponentFailure) {
            return failResult(result.error, 'PICK_DATE_INCOMPLETE', {
                picked: false,
                date: args.date,
                platform,
                selectorFailure: summary.reason,
                terminalStep: summary.failedStep,
                output: result.output.slice(0, 500),
            });
        }
        const succeeded = [];
        let failed;
        let nextStepIndex = 0;
        const terminalTarget = (startIndex, value, matchesTarget) => {
            let observedIndex = summary.steps.findIndex((step, index) => index >= startIndex && matchesTarget(step.name, value));
            let observed = observedIndex < 0 ? undefined : summary.steps[observedIndex];
            while (observed?.status === 'fail') {
                const retryIndex = summary.steps.findIndex((step, index) => index > observedIndex && matchesTarget(step.name, value));
                if (retryIndex < 0)
                    break;
                const interveningComponent = summary.steps
                    .slice(observedIndex + 1, retryIndex)
                    .some((step) => components.some((candidate) => candidate.value !== value && stepTargetsTextValue(step.name, candidate.value)));
                if (interveningComponent)
                    break;
                observedIndex = retryIndex;
                observed = summary.steps[observedIndex];
            }
            return { observed, observedIndex };
        };
        if (opener) {
            const openerOutcome = terminalTarget(0, opener, stepTargetsIdValue);
            if (openerOutcome.observedIndex >= 0)
                nextStepIndex = openerOutcome.observedIndex + 1;
        }
        for (const component of components) {
            const { observed, observedIndex } = terminalTarget(nextStepIndex, component.value, stepTargetsTextValue);
            if (observed?.status !== 'pass') {
                failed = component;
                break;
            }
            succeeded.push(component.name);
            nextStepIndex = observedIndex + 1;
        }
        const code = result.errorCode ?? (result.timedOut ? 'PICK_DATE_TIMEOUT' : 'PICK_DATE_INCOMPLETE');
        if (!failed) {
            return failResult(result.error ?? 'Date-picker flow failed after selecting every component.', code, {
                picked: false,
                date: args.date,
                platform,
                succeeded,
                completedOperations: succeeded,
                selectorFailure: summary.reason,
                terminalStep: summary.failedStep,
                output: result.output.slice(0, 500),
            });
        }
        const reason = result.timedOut
            ? `Date-picker flow timed out after ${args.timeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS}ms while attempting ${failed.name} "${failed.value}".`
            : `Date-picker flow could not select ${failed.name} "${failed.value}". Calendar mode and off-screen wheel scrolling remain unsupported; issue #27 tracks native wheel adjustment.`;
        return failResult(reason, code, {
            picked: false,
            date: args.date,
            platform,
            succeeded,
            completedOperations: succeeded,
            failedAt: failed.name,
            failedValue: failed.value,
            selectorFailure: summary.reason,
            terminalStep: summary.failedStep,
            error: result.error,
            output: result.output.slice(0, 500),
        });
    };
}
