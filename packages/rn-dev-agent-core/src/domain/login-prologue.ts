import type { RunRecord } from './reusable-action.js';

export const LOGIN_PROLOGUE_ALIAS = 'user-login';
export const ACTION_LOGIN_HELPER = 'ACTION_LOGIN_HELPER';

export interface LoginPrologueStepTiming {
  name: 'inventory' | 'resolve' | 'replay' | 'verify-run-record';
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

export interface LoginPrologueOutcome {
  schemaVersion: 1;
  role: typeof ACTION_LOGIN_HELPER;
  alias: typeof LOGIN_PROLOGUE_ALIAS;
  actionId: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  steps: LoginPrologueStepTiming[];
  inventory: { count: number; actionIds: string[] };
  runRecord: RunRecord;
  writes?: Record<string, unknown>;
  actionResult?: {
    transport?: unknown;
    transportVersion?: unknown;
    fallback?: unknown;
    perStepReadback?: unknown;
  };
}
