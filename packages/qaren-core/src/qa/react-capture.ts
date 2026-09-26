import { isRecord } from './questions.js';
import type { CDPClient } from '../cdp-client.js';
import type { ReactObservation } from './capture.js';
import {
  assertPrivateInputPayload,
  bindPrivateInputs,
  PrivateInputCaptureError,
} from './private-input.js';
import { validateReactHostEvidence } from './screen.js';
import type { DigestEntry } from './screen.js';

function completion(value: unknown, start: boolean, id?: string): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{1,64}$/.test(value.id) ||
    (id !== undefined && value.id !== id) ||
    (value.state !== 'pending' && value.state !== 'ready') ||
    Object.keys(value).some(
      (key) => !['v', 'id', 'state', 'tree', ...(start ? ['inputs'] : [])].includes(key),
    ) ||
    (value.state === 'pending' && value.tree !== undefined)
  ) {
    throw new PrivateInputCaptureError();
  }
  return value;
}

function publicObservation(tree: unknown): ReactObservation {
  if (typeof tree !== 'string' || tree.length > 999999) throw new PrivateInputCaptureError();
  const value: unknown = JSON.parse(tree);
  if (
    !isRecord(value) ||
    !Array.isArray(value.interactive) ||
    value.interactive.length > 200 ||
    (value.truncated !== undefined && value.truncated !== false)
  ) {
    throw new PrivateInputCaptureError();
  }
  const verdict = value.verdict;
  if (
    !isRecord(verdict) ||
    verdict.state !== 'ok' ||
    verdict.path !== 'interactive' ||
    verdict.complete !== true ||
    ['reasons', 'unscannedRendererIds'].some(
      (key) =>
        verdict[key] !== undefined && (!Array.isArray(verdict[key]) || verdict[key].length !== 0),
    ) ||
    ['rendererErrors', 'droppedSubtrees', 'collapsedChildLists'].some(
      (key) => verdict[key] !== undefined && verdict[key] !== 0,
    )
  ) {
    throw new PrivateInputCaptureError();
  }
  const hostEvidence = validateReactHostEvidence(value.hostEvidence);
  if (!hostEvidence?.complete) throw new PrivateInputCaptureError();
  const interactive: DigestEntry[] = value.interactive.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.role !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(entry.role)
    ) {
      throw new PrivateInputCaptureError();
    }
    const result: DigestEntry = { role: entry.role };
    for (const key of ['testID', 'text', 'label', 'placeholder'] as const) {
      if (entry[key] !== undefined) {
        if (typeof entry[key] !== 'string') throw new PrivateInputCaptureError();
        result[key] = entry[key];
      }
    }
    if (entry.value !== undefined) {
      if (typeof entry.value !== 'boolean' || entry.role !== 'switch')
        throw new PrivateInputCaptureError();
      result.value = entry.value;
    }
    if (entry.disabled !== undefined) {
      if (typeof entry.disabled !== 'boolean') throw new PrivateInputCaptureError();
      result.disabled = entry.disabled;
    }
    if (entry.capabilities !== undefined) {
      if (
        !isRecord(entry.capabilities) ||
        typeof entry.capabilities.press !== 'boolean' ||
        typeof entry.capabilities.fill !== 'boolean'
      ) {
        throw new PrivateInputCaptureError();
      }
      result.capabilities = { press: entry.capabilities.press, fill: entry.capabilities.fill };
    }
    return result;
  });
  return {
    interactive,
    hostEvidence,
    truncated: false,
    verdict: { state: 'ok', path: 'interactive', complete: true },
  };
}

export async function captureQaReact(
  client: Pick<CDPClient, 'withPrivateHelperWorld'>,
  typography = false,
): Promise<ReactObservation> {
  const deadline = performance.now() + 1500;
  let expired = false;
  const remaining = (): number => {
    const ms = deadline - performance.now();
    if (expired || ms <= 0) throw new PrivateInputCaptureError();
    return ms;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observation = await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new PrivateInputCaptureError());
        }, remaining());
      }),
      client.withPrivateHelperWorld(async (evaluate) => {
        const start = completion(
          await evaluate(
            `globalThis.__QAREN.beginQaCapture(${typography === true ? 'true' : 'false'})`,
            remaining(),
          ),
          true,
        );
        remaining();
        const inputs = start.inputs;
        assertPrivateInputPayload(inputs);
        const id = start.id as string;
        let current = start;
        while (current.state === 'pending') {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining())));
          current = completion(
            await evaluate(`globalThis.__QAREN.readQaCapture(${JSON.stringify(id)})`, remaining()),
            false,
            id,
          );
          remaining();
        }
        const observation = bindPrivateInputs(publicObservation(current.tree), inputs);
        remaining();
        return observation;
      }),
    ]);
    remaining();
    return observation;
  } catch {
    throw new PrivateInputCaptureError();
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
