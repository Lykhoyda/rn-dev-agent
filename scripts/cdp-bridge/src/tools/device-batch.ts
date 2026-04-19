import { runAgentDevice } from '../agent-device-wrapper.js';
import { withSession, okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { captureAndResizeScreenshot } from './device-list.js';

export interface BatchStep {
  action: 'find' | 'press' | 'fill' | 'swipe' | 'scroll' | 'back' | 'wait' | 'hideKeyboard' | 'snapshot' | 'screenshot';
  text?: string;
  ref?: string;
  tap?: boolean;
  direction?: 'up' | 'down' | 'left' | 'right';
  ms?: number;
  optional?: boolean;
}

export interface BatchArgs {
  steps: BatchStep[];
  delayMs?: number;
  screenshotOn?: 'none' | 'failure' | 'end' | 'each';
}

interface StepResult {
  step: number;
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
  data?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function executeStep(step: BatchStep): Promise<ToolResult> {
  switch (step.action) {
    case 'find': {
      if (!step.text) return failResult('find requires text');
      const args = ['find', step.text];
      if (step.tap) args.push('click');
      return runAgentDevice(args);
    }
    case 'press': {
      if (!step.ref) return failResult('press requires ref');
      const ref = step.ref.startsWith('@') ? step.ref : `@${step.ref}`;
      return runAgentDevice(['press', ref]);
    }
    case 'fill': {
      if (!step.text) return failResult('fill requires text');
      if (!step.ref) return failResult('fill requires ref (e.g. "e5" or "@e5"). Use a find+tap step first to focus the field.');
      const ref = step.ref.startsWith('@') ? step.ref : `@${step.ref}`;
      return runAgentDevice(['fill', ref, step.text]);
    }
    case 'swipe': {
      if (!step.direction) return failResult('swipe requires direction');
      return runAgentDevice(['scroll', step.direction]);
    }
    case 'scroll': {
      if (!step.direction) return failResult('scroll requires direction');
      return runAgentDevice(['scroll', step.direction]);
    }
    case 'back': {
      return runAgentDevice(['back']);
    }
    case 'hideKeyboard': {
      return runAgentDevice(['keyboard', 'dismiss']);
    }
    case 'snapshot': {
      return runAgentDevice(['snapshot', '-i']);
    }
    case 'screenshot': {
      // B121: route through the resize wrapper (B120 default maxWidth=800)
      // so batch-step screenshots don't pay native-resolution context cost.
      return captureAndResizeScreenshot({});
    }
    case 'wait': {
      await sleep(step.ms ?? 500);
      return okResult({ waited: step.ms ?? 500 });
    }
    default:
      return failResult(`Unknown action: ${step.action}`);
  }
}

function isOk(result: ToolResult): boolean {
  try {
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean };
    return parsed.ok;
  } catch {
    return !result.isError;
  }
}

function extractData(result: ToolResult): unknown {
  try {
    const parsed = JSON.parse(result.content[0].text) as { data?: unknown };
    return parsed.data;
  } catch {
    return null;
  }
}

export function createDeviceBatchHandler(): (args: BatchArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const { steps, delayMs = 300, screenshotOn = 'failure' } = args;

    if (!steps || steps.length === 0) {
      return failResult('steps array is required and must not be empty');
    }

    const batchStart = Date.now();
    const results: StepResult[] = [];
    let finalSnapshot: unknown = null;
    let failedStep: StepResult | null = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStart = Date.now();

      // Note: timed-out steps continue executing in background (agent-device CLI
      // calls cannot be cancelled). The timeout prevents the batch from hanging,
      // but the underlying action may complete after the timeout fires.
      const STEP_TIMEOUT = 15_000;
      let stepTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        executeStep(step),
        new Promise<ToolResult>((resolve) => {
          stepTimer = setTimeout(() => resolve(failResult(`Step ${i + 1} timed out after ${STEP_TIMEOUT}ms`)), STEP_TIMEOUT);
        }),
      ]);
      if (stepTimer) clearTimeout(stepTimer);
      const success = isOk(result);
      const durationMs = Date.now() - stepStart;

      const stepResult: StepResult = {
        step: i + 1,
        action: step.action,
        success,
        durationMs,
      };

      if (!success) {
        try {
          const parsed = JSON.parse(result.content[0].text) as { error?: string };
          stepResult.error = parsed.error;
        } catch { /* ignore */ }
      }

      if (step.action === 'snapshot' && success) {
        finalSnapshot = extractData(result);
      }

      results.push(stepResult);

      if (!success && !step.optional) {
        failedStep = stepResult;

        if (screenshotOn === 'failure' || screenshotOn === 'each') {
          try {
            // B121: route through resize wrapper.
            const ssResult = await captureAndResizeScreenshot({});
            if (isOk(ssResult)) {
              stepResult.data = extractData(ssResult);
            }
          } catch { /* best effort */ }
        }

        break;
      }

      if (screenshotOn === 'each' && step.action !== 'screenshot') {
        // B121: route through resize wrapper so per-step captures pay budget.
        try { await captureAndResizeScreenshot({}); } catch { /* ignore */ }
      }

      if (i < steps.length - 1 && step.action !== 'wait' && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    if (!failedStep && screenshotOn === 'end') {
      try {
        // B121: route through resize wrapper.
        const ssResult = await captureAndResizeScreenshot({});
        if (isOk(ssResult)) {
          finalSnapshot = extractData(ssResult);
        }
      } catch { /* best effort */ }
    }

    if (!finalSnapshot && !failedStep) {
      try {
        const snapResult = await runAgentDevice(['snapshot', '-i']);
        if (isOk(snapResult)) {
          finalSnapshot = extractData(snapResult);
        }
      } catch { /* best effort */ }
    }

    const totalDuration = Date.now() - batchStart;

    if (failedStep) {
      return failResult(
        `Step ${failedStep.step} failed: ${failedStep.action}${failedStep.error ? ' — ' + failedStep.error : ''}`,
        {
          steps_completed: failedStep.step - 1,
          total_steps: steps.length,
          failed_step: failedStep,
          duration_ms: totalDuration,
          results,
        },
      );
    }

    return okResult({
      success: true,
      steps_completed: steps.length,
      total_steps: steps.length,
      duration_ms: totalDuration,
      results,
      final_snapshot: finalSnapshot,
    });
  });
}
