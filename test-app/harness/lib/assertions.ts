export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertContains(haystack: string, needle: string, label?: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected string to contain "${needle}", got: "${haystack.slice(0, 200)}"`,
    );
  }
}

export function assertTruthy(value: unknown, label?: string): void {
  if (!value) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected truthy value, got ${JSON.stringify(value)}`,
    );
  }
}

export function assertShape(obj: unknown, keys: string[], label?: string): void {
  if (typeof obj !== 'object' || obj === null) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected object, got ${typeof obj}`,
    );
  }
  for (const key of keys) {
    if (!(key in obj)) {
      throw new AssertionError(
        `${label ? label + ': ' : ''}missing key "${key}" in ${JSON.stringify(Object.keys(obj))}`,
      );
    }
  }
}

export function assertGreaterThan(actual: number, min: number, label?: string): void {
  if (actual <= min) {
    throw new AssertionError(
      `${label ? label + ': ' : ''}expected > ${min}, got ${actual}`,
    );
  }
}
