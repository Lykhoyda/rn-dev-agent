import type { NativeNode, Screen } from './screen.js';
import { capturePrivateScreen, isPossibleInput, readableValue } from './privacy.js';

export class PrivateInputCaptureError extends Error {
  readonly code = 'PRIVATE_INPUT_CAPTURE_UNKNOWN' as const;

  constructor(detail?: string) {
    super(`Private input capture could not be established safely.${detail ? ` ${detail}` : ''}`);
    this.name = 'PrivateInputCaptureError';
  }
}

// Built only from a node count and fixed cause codes, so it carries no screen content.
const NATIVE_CAUSE =
  /^(unattested|truncated|ref-map-not-updated|node-count-mismatch|dropped=\d{1,7}|verdict=(failed|degraded)|reason=(empty-capture|snapshot-ref-freshness-unknown|unrecognized))$/;

export class NativeSnapshotIncomplete extends PrivateInputCaptureError {
  readonly nodes: number;
  readonly causes: readonly string[];

  constructor(nodes: number, causes: readonly string[]) {
    const count = Number.isSafeInteger(nodes) && nodes >= 0 ? nodes : 0;
    const known = causes.filter((cause) => typeof cause === 'string' && NATIVE_CAUSE.test(cause));
    super(`The native snapshot was incomplete (nodes=${count}; causes=${known.join(',')}).`);
    this.nodes = count;
    this.causes = known;
  }
}

// The native snapshot is the privacy boundary: every readable input or secure value it shows is private.
export function applyNativePrivateInputs(screen: Screen, nodes: readonly NativeNode[]): Screen {
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  capturePrivateScreen(
    screen,
    screen.elements
      .filter((element) => isPossibleInput(element) || element.secure)
      .map((element) => {
        // Android reports an input's text as its label, so the label may be the value.
        const android = byRef.get(element.ref)?.type?.includes('.') === true;
        const label = element.label !== element.placeholder ? element.label : undefined;
        const values = [readableValue(element), ...(android ? [label] : [])].filter(
          (value): value is string => !!value,
        );
        return {
          values,
          secure: element.secure,
          testID: element.testID,
          elements: [element],
          associationUnique: true,
          // A secure node's label may be its value natively; masking a name too is the safe error.
          labelMayBeValue: android || element.secure,
        };
      }),
  );
  return screen;
}
