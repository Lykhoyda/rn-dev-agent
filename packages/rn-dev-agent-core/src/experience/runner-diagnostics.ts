import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const RUNNER_DIAGNOSTICS_MAX_EVENTS = 200;

export type RunnerDiagnosticEventType =
  | 'spawn-begin'
  | 'payload-verify'
  | 'cache-provision'
  | 'runner-exec-begin'
  | 'wda-bootstrap-begin'
  | 'typed-failure'
  | 'cleanup'
  | 'tool-outcome';

export interface RunnerDiagnosticEvent {
  sequence: number;
  monotonicMs: number;
  timestamp: string;
  type: RunnerDiagnosticEventType;
  detail: Record<string, unknown>;
}

export interface RunnerDiagnosticsSnapshot {
  rootTool: string;
  rootParams: Record<string, unknown>;
  events: RunnerDiagnosticEvent[];
  truncated: boolean;
}

interface RunnerDiagnosticsState extends RunnerDiagnosticsSnapshot {
  startedAt: number;
}

const storage = new AsyncLocalStorage<RunnerDiagnosticsState>();

export function withRunnerDiagnosticsContext<T>(
  tool: string,
  params: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  if (storage.getStore()) return work();
  return storage.run(
    {
      rootTool: tool,
      rootParams: params,
      events: [],
      truncated: false,
      startedAt: performance.now(),
    },
    work,
  );
}

export function recordRunnerDiagnostic(
  type: RunnerDiagnosticEventType,
  detail: Record<string, unknown> = {},
): void {
  const state = storage.getStore();
  if (!state) return;
  if (state.events.length >= RUNNER_DIAGNOSTICS_MAX_EVENTS) {
    state.truncated = true;
    return;
  }
  state.events.push({
    sequence: state.events.length + 1,
    monotonicMs: Math.max(0, Math.round((performance.now() - state.startedAt) * 1000) / 1000),
    timestamp: new Date().toISOString(),
    type,
    detail,
  });
}

export function currentRunnerDiagnosticsPlatform(): string | null {
  const value = storage.getStore()?.rootParams.platform;
  return typeof value === 'string' ? value : null;
}

export function snapshotRunnerDiagnostics(): RunnerDiagnosticsSnapshot | undefined {
  const state = storage.getStore();
  if (!state || state.events.length === 0) return undefined;
  return {
    rootTool: state.rootTool,
    rootParams: { ...state.rootParams },
    events: state.events.map((event) => ({ ...event, detail: { ...event.detail } })),
    truncated: state.truncated,
  };
}
