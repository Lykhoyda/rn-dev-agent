import { createHash, timingSafeEqual } from 'node:crypto';
import type { RunRecord } from './reusable-action.js';

export const LOGIN_PROLOGUE_ALIAS = 'user-login';
export const LOGIN_PROLOGUE_BLOCKED = 'LOGIN_PROLOGUE_BLOCKED';

export interface LoginPrologueStepTiming {
  name: 'inventory' | 'resolve' | 'replay' | 'verify-run-record';
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

export interface LoginOverrideAudit {
  tool: string;
  usedAt: string;
}

export interface LoginPrologueOutcome {
  schemaVersion: 1;
  state: 'passed' | typeof LOGIN_PROLOGUE_BLOCKED;
  alias: typeof LOGIN_PROLOGUE_ALIAS;
  actionId?: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  steps: LoginPrologueStepTiming[];
  inventory: { count: number; actionIds: string[] };
  runRecord?: RunRecord;
  actionResult?: {
    transport?: unknown;
    transportVersion?: unknown;
    fallback?: unknown;
    perStepReadback?: unknown;
  };
  failure?: { code: string; detail: string };
  overrides?: LoginOverrideAudit[];
}

export function readLoginPrologueOutcome(value: unknown): LoginPrologueOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<LoginPrologueOutcome>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.alias !== LOGIN_PROLOGUE_ALIAS ||
    (candidate.state !== 'passed' && candidate.state !== LOGIN_PROLOGUE_BLOCKED) ||
    typeof candidate.startedAt !== 'string' ||
    typeof candidate.endedAt !== 'string' ||
    typeof candidate.elapsedMs !== 'number' ||
    !Array.isArray(candidate.steps)
  ) {
    return null;
  }
  return candidate as LoginPrologueOutcome;
}

function cleanupAllowed(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'cdp_login_prologue') return true;
  if (tool === 'cdp_disconnect') return true;
  if (tool === 'device_snapshot' && args.action === 'close') return true;
  if (tool === 'device_record' && (args.action === 'stop' || args.action === 'status')) return true;
  if (tool === 'observe' && (args.action === 'stop' || args.action === 'status')) return true;
  if (tool === 'proof_capture' && (args.action === 'discard' || args.action === 'status')) {
    return true;
  }
  return (
    tool === 'rn_session' &&
    (args.action === 'release' ||
      args.action === 'stop_metro' ||
      args.action === 'cancel_handoff' ||
      args.action === 'status')
  );
}

function tokenMatches(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || expected.length < 16 || !supplied || supplied.length < 16) return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export type LoginPrologueGuardDecision =
  | { allowed: true; override: false }
  | { allowed: true; override: true; audit: LoginOverrideAudit }
  | { allowed: false; suppliedOverride: boolean };

export function evaluateLoginPrologueGuard(input: {
  binding: unknown;
  tool: string;
  args: Record<string, unknown>;
  mutation: boolean;
  expectedOverrideToken?: string;
  now?: () => Date;
}): LoginPrologueGuardDecision {
  const outcome = readLoginPrologueOutcome(input.binding);
  if (outcome?.state !== LOGIN_PROLOGUE_BLOCKED || !input.mutation) {
    return { allowed: true, override: false };
  }
  if (cleanupAllowed(input.tool, input.args)) return { allowed: true, override: false };

  const supplied =
    typeof input.args.supervisorOverrideToken === 'string'
      ? input.args.supervisorOverrideToken
      : undefined;
  if (tokenMatches(input.expectedOverrideToken, supplied)) {
    return {
      allowed: true,
      override: true,
      audit: { tool: input.tool, usedAt: (input.now ?? (() => new Date()))().toISOString() },
    };
  }
  return { allowed: false, suppliedOverride: supplied !== undefined };
}

export function appendLoginOverrideAudit(
  outcome: LoginPrologueOutcome,
  audit: LoginOverrideAudit,
): LoginPrologueOutcome {
  return { ...outcome, overrides: [...(outcome.overrides ?? []), audit].slice(-20) };
}
