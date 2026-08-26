import { createHash, timingSafeEqual } from 'node:crypto';
import type { RunRecord } from './reusable-action.js';

export const LOGIN_PROLOGUE_ALIAS = 'user-login';
export const LOGIN_PROLOGUE_BLOCKED = 'LOGIN_PROLOGUE_BLOCKED';
export const ACTION_LOGIN_HELPER = 'ACTION_LOGIN_HELPER';
export const LOGIN_PROLOGUE_RECOVERY_SEQUENCE =
  'Run device_snapshot with action "open" and attachOnly true on the already-bound app, rerun cdp_login_prologue, then repeat the same attach-only open before device_press or device_fill.';
export const LOGIN_PROLOGUE_RETRY_ACTION =
  'Resolve the reported user-login failure, then rerun cdp_login_prologue; attach-only runner recovery is not authorized for this blocked state.';
export const LOCKED_E2E_LOGIN_TOOLS = ['cdp_lock_e2e_test', 'cdp_run_e2e_suite'] as const;

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
  role?: typeof ACTION_LOGIN_HELPER;
  alias: typeof LOGIN_PROLOGUE_ALIAS;
  actionId?: string;
  attemptId?: string;
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

function lockedE2eProofAllowed(
  tool: string,
  args: Record<string, unknown>,
  resolvedLockedTestIds?: readonly string[],
): boolean {
  if (tool === 'cdp_lock_e2e_test') return args.actionId === LOGIN_PROLOGUE_ALIAS;
  if (tool === 'cdp_run_e2e_suite') {
    return resolvedLockedTestIds?.length === 1 && resolvedLockedTestIds[0] === LOGIN_PROLOGUE_ALIAS;
  }
  return false;
}

export interface LoginRunnerRecoveryAuthority {
  install: unknown;
  metro: unknown;
  bundle: unknown;
  device: unknown;
  runner: unknown;
}

export function isLoginRunnerRecoveryState(input: {
  binding: unknown;
  authority?: LoginRunnerRecoveryAuthority;
}): boolean {
  const outcome = readLoginPrologueOutcome(input.binding);
  return Boolean(
    input.authority &&
    outcome?.state === LOGIN_PROLOGUE_BLOCKED &&
    outcome.role === ACTION_LOGIN_HELPER &&
    outcome.actionId === LOGIN_PROLOGUE_ALIAS &&
    outcome.runRecord?.status === 'fail' &&
    input.authority.runner == null &&
    input.authority.bundle == null,
  );
}

export function loginPrologueNextAction(input: {
  binding: unknown;
  authority?: LoginRunnerRecoveryAuthority;
}): string {
  if (
    isLoginRunnerRecoveryState(input) &&
    input.authority?.install != null &&
    input.authority.metro != null &&
    input.authority.device != null
  ) {
    return LOGIN_PROLOGUE_RECOVERY_SEQUENCE;
  }
  const outcome = readLoginPrologueOutcome(input.binding);
  return outcome?.failure?.code === 'LOGIN_ACTION_MISSING' ||
    outcome?.failure?.code === 'LOGIN_ACTION_ID_MISMATCH'
    ? `Restore the exact ${LOGIN_PROLOGUE_ALIAS} action, then run cdp_login_prologue.`
    : LOGIN_PROLOGUE_RETRY_ACTION;
}

export function isLoginRunnerRecoveryOperation(input: {
  binding: unknown;
  authority?: LoginRunnerRecoveryAuthority;
  tool: string;
  args: Record<string, unknown>;
  mutation: boolean;
}): boolean {
  return (
    isLoginRunnerRecoveryState(input) &&
    input.mutation &&
    input.tool === 'device_snapshot' &&
    input.args.action === 'open' &&
    input.args.attachOnly === true
  );
}

function latchedOperationAllowed(
  binding: unknown,
  authority: LoginRunnerRecoveryAuthority | undefined,
  tool: string,
  args: Record<string, unknown>,
  mutation: boolean,
): boolean {
  if (isLoginRunnerRecoveryOperation({ binding, authority, tool, args, mutation })) return true;
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
      (args.action === 'recover_arbiter' && args.confirmed === true) ||
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

export type LoginPrologueGuardInspection =
  | { blocked: false }
  | { blocked: true; suppliedOverride: string | undefined };

export function inspectLoginPrologueGuard(input: {
  binding: unknown;
  authority?: LoginRunnerRecoveryAuthority;
  tool: string;
  args: Record<string, unknown>;
  mutation: boolean;
  resolvedLockedTestIds?: readonly string[];
}): LoginPrologueGuardInspection {
  const outcome = readLoginPrologueOutcome(input.binding);
  if (
    outcome?.state !== LOGIN_PROLOGUE_BLOCKED ||
    !input.mutation ||
    latchedOperationAllowed(
      input.binding,
      input.authority,
      input.tool,
      input.args,
      input.mutation,
    ) ||
    lockedE2eProofAllowed(input.tool, input.args, input.resolvedLockedTestIds)
  ) {
    return { blocked: false };
  }
  return {
    blocked: true,
    suppliedOverride:
      typeof input.args.supervisorOverrideToken === 'string'
        ? input.args.supervisorOverrideToken
        : undefined,
  };
}

export function authorizeLoginSupervisorOverride(input: {
  expectedOverrideToken?: string;
  suppliedOverrideToken?: string;
  tool: string;
  now?: () => Date;
}): LoginOverrideAudit | null {
  if (!tokenMatches(input.expectedOverrideToken, input.suppliedOverrideToken)) return null;
  return { tool: input.tool, usedAt: (input.now ?? (() => new Date()))().toISOString() };
}

export function evaluateLoginPrologueGuard(input: {
  binding: unknown;
  authority?: LoginRunnerRecoveryAuthority;
  tool: string;
  args: Record<string, unknown>;
  mutation: boolean;
  resolvedLockedTestIds?: readonly string[];
  expectedOverrideToken?: string;
  now?: () => Date;
}): LoginPrologueGuardDecision {
  const inspection = inspectLoginPrologueGuard(input);
  if (!inspection.blocked) return { allowed: true, override: false };
  const audit = authorizeLoginSupervisorOverride({
    expectedOverrideToken: input.expectedOverrideToken,
    suppliedOverrideToken: inspection.suppliedOverride,
    tool: input.tool,
    now: input.now,
  });
  return audit
    ? { allowed: true, override: true, audit }
    : { allowed: false, suppliedOverride: inspection.suppliedOverride !== undefined };
}

export function appendLoginOverrideAudit(
  outcome: LoginPrologueOutcome,
  audit: LoginOverrideAudit,
): LoginPrologueOutcome {
  return { ...outcome, overrides: [...(outcome.overrides ?? []), audit].slice(-20) };
}
