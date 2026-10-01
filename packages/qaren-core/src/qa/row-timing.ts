import type { TimingEvent } from './timing.js';

// Top-level fields partition the row window; native, react, presence and Jev break down capture and decision.
export interface RowTiming {
  captureMs: number;
  nativeMs: number;
  reactMs: number;
  presenceMs?: number;
  resolveMs: number;
  jevMs: number;
  actMs: number;
  postCaptureMs: number;
  otherMs: number;
  total: number;
}

export interface LedgerSpeed {
  stepMedianMs: number;
  stepP95Ms: number;
  walkMs: number;
}

interface Window {
  capture: number;
  postCapture: number;
  native: number;
  react: number;
  presence?: number;
  resolve: number;
  act: number;
  acted: boolean;
}

const emptyWindow = (): Window => ({
  capture: 0,
  postCapture: 0,
  native: 0,
  react: 0,
  resolve: 0,
  act: 0,
  acted: false,
});

export interface RowTimer {
  observe(event: TimingEvent): void;
  take(t: number, jevMs: number): RowTiming;
}

// Projects the walker's timing events onto the window between consecutive ledger rows.
export function createRowTimer(startedAt: number): RowTimer {
  let windowStart = startedAt;
  let window = emptyWindow();
  return {
    observe(event) {
      const ms = event.ms;
      if (ms === undefined) return;
      if (event.stage === 'native-production') {
        window.presence = (window.presence ?? 0) + ms;
        return;
      }
      if (event.edge !== 'end') return;
      switch (event.stage) {
        case 'capture':
          if (window.acted) window.postCapture += ms;
          else window.capture += ms;
          break;
        case 'native-total':
          window.native += ms;
          break;
        case 'react-private':
          window.react += ms;
          break;
        case 'decision':
          window.resolve += ms;
          break;
        case 'mutation':
          window.act += ms;
          // A dispatch refused before any authorization leaves later captures pre-action.
          if ((event.count ?? 1) > 0) window.acted = true;
          break;
      }
    },
    take(t, jevMs) {
      const total = Math.max(0, Math.round(t - windowStart));
      // Cumulative rounding clamped to the window keeps the partition exact.
      let raw = 0;
      let boundary = 0;
      const part = (ms: number): number => {
        raw += ms;
        const next = Math.min(total, Math.round(raw));
        const size = next - boundary;
        boundary = next;
        return size;
      };
      const captureMs = part(window.capture);
      const resolveMs = part(window.resolve);
      const actMs = part(window.act);
      const postCaptureMs = part(window.postCapture);
      const timing: RowTiming = {
        captureMs,
        nativeMs: Math.round(window.native),
        reactMs: Math.round(window.react),
        ...(window.presence !== undefined ? { presenceMs: Math.round(window.presence) } : {}),
        resolveMs,
        jevMs: Math.round(jevMs),
        actMs,
        postCaptureMs,
        otherMs: total - boundary,
        total,
      };
      windowStart = t;
      window = emptyWindow();
      return timing;
    },
  };
}

// Median and nearest-rank p95 over passing step and check rows; walk time spans every timed row.
export function summarizeSpeed(
  rows: readonly { kind: string; outcome: string; timing?: RowTiming }[],
): LedgerSpeed | undefined {
  const timed = rows.filter((row) => row.timing);
  if (!timed.length) return undefined;
  const passing = timed
    .filter((row) => row.outcome === 'pass' && (row.kind === 'step' || row.kind === 'check'))
    .map((row) => row.timing!.total)
    .sort((a, b) => a - b);
  const mid = Math.floor(passing.length / 2);
  return {
    stepMedianMs: !passing.length
      ? 0
      : passing.length % 2
        ? passing[mid]
        : Math.round((passing[mid - 1] + passing[mid]) / 2),
    stepP95Ms: passing.length ? passing[Math.ceil(passing.length * 0.95) - 1] : 0,
    walkMs: timed.reduce((sum, row) => sum + row.timing!.total, 0),
  };
}
