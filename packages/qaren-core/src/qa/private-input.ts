import type { ReactObservation } from './capture.js';
import { validateReactHostEvidence } from './screen.js';
import type { Screen } from './screen.js';
import { capturePrivateScreen } from './privacy.js';
import { PRIVATE_INPUT_LIMITS } from './private-input-limits.js';

export class PrivateInputCaptureError extends Error {
  readonly code = 'PRIVATE_INPUT_CAPTURE_UNKNOWN' as const;

  constructor() {
    super('Private input capture could not be established safely.');
    this.name = 'PrivateInputCaptureError';
  }
}

interface PrivateFact {
  hostIndex: number;
  values: string[];
  secure: boolean;
}

interface PrivateInputPayload {
  version: 1;
  complete: true;
  facts: PrivateFact[];
}

const bindings = new WeakMap<ReactObservation, { facts: PrivateFact[]; hosts: string }>();

function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function assertPrivateInputPayload(
  payload: unknown,
): asserts payload is PrivateInputPayload {
  try {
    if (
      !exactRecord(payload, ['version', 'complete', 'facts']) ||
      payload.version !== 1 ||
      payload.complete !== true ||
      !Array.isArray(payload.facts) ||
      payload.facts.length >= PRIVATE_INPUT_LIMITS.maxHosts
    )
      throw new PrivateInputCaptureError();
    const indices = new Set<number>();
    let total = 0;
    let valueCount = 0;
    for (const fact of payload.facts) {
      if (
        !exactRecord(fact, ['hostIndex', 'values', 'secure']) ||
        typeof fact.hostIndex !== 'number' ||
        !Number.isInteger(fact.hostIndex) ||
        fact.hostIndex < 0 ||
        fact.hostIndex >= PRIVATE_INPUT_LIMITS.maxHosts ||
        indices.has(fact.hostIndex) ||
        typeof fact.secure !== 'boolean' ||
        !Array.isArray(fact.values) ||
        fact.values.length > PRIVATE_INPUT_LIMITS.maxValuesPerHost
      )
        throw new PrivateInputCaptureError();
      for (const value of fact.values) {
        if (
          ++valueCount > PRIVATE_INPUT_LIMITS.maxValues ||
          typeof value !== 'string' ||
          value.length > PRIVATE_INPUT_LIMITS.maxValueChars ||
          (total += value.length) > PRIVATE_INPUT_LIMITS.maxTotalChars
        )
          throw new PrivateInputCaptureError();
      }
      indices.add(fact.hostIndex);
    }
  } catch {
    throw new PrivateInputCaptureError();
  }
}

export function bindPrivateInputs(
  observation: ReactObservation,
  payload: unknown,
): ReactObservation {
  try {
    bindings.delete(observation);
    assertPrivateInputPayload(payload);
    const evidence = validateReactHostEvidence(observation.hostEvidence);
    if (
      !evidence?.complete ||
      payload.facts.some((fact) => fact.hostIndex >= evidence.hosts.length)
    )
      throw new PrivateInputCaptureError();
    const facts = payload.facts.map((fact) => ({
      hostIndex: fact.hostIndex,
      values: [...fact.values],
      secure: fact.secure,
    }));
    bindings.set(observation, { facts, hosts: JSON.stringify(evidence) });
    return observation;
  } catch {
    throw new PrivateInputCaptureError();
  }
}

export function validatePrivateInputs(observation: ReactObservation, required = false): void {
  try {
    const binding = bindings.get(observation);
    if (!binding) {
      if (required) throw new PrivateInputCaptureError();
      return;
    }
    const evidence = validateReactHostEvidence(observation.hostEvidence);
    if (!evidence?.complete || JSON.stringify(evidence) !== binding.hosts)
      throw new PrivateInputCaptureError();
  } catch {
    throw new PrivateInputCaptureError();
  }
}

export function applyPrivateInputs(observation: ReactObservation, screen: Screen): Screen {
  validatePrivateInputs(observation);
  const binding = bindings.get(observation);
  if (!binding) return screen;
  const evidence = validateReactHostEvidence(observation.hostEvidence)!;
  capturePrivateScreen(
    screen,
    binding.facts.map((fact) => {
      const testID = evidence.hosts[fact.hostIndex].testID;
      const elements = testID ? screen.elements.filter((element) => element.testID === testID) : [];
      const associationUnique =
        elements.length === 1 &&
        evidence.hosts.filter((host) => host.testID === testID).length === 1;
      return { values: fact.values, secure: fact.secure, testID, elements, associationUnique };
    }),
  );
  return screen;
}
