import { createHash } from 'node:crypto';

export const AUTHORITY_REFUSAL_CODES = [
  'SESSION_AUTHORITY_REQUIRED',
  'METRO_ORIGIN_MISMATCH',
  'RUNNER_OWNERSHIP_MISMATCH',
  'HANDOFF_NOT_AUTHORIZED',
  'NON_GIT_MANIFEST_REQUIRED',
  'BUNDLE_HANDSHAKE_UNAVAILABLE',
] as const;

export type AuthorityRefusalCode = (typeof AUTHORITY_REFUSAL_CODES)[number];

const AUTHORITY_AXES = ['C', 'S', 'I', 'M', 'A', 'B', 'D', 'R', 'P'] as const;
export type AuthorityAxis = (typeof AUTHORITY_AXES)[number];

const REFUSAL_CAUSES = {
  SESSION_AUTHORITY_REQUIRED: [],
  METRO_ORIGIN_MISMATCH: [],
  RUNNER_OWNERSHIP_MISMATCH: [],
  HANDOFF_NOT_AUTHORIZED: [],
  NON_GIT_MANIFEST_REQUIRED: [],
  BUNDLE_HANDSHAKE_UNAVAILABLE: [],
} as const satisfies Record<AuthorityRefusalCode, readonly string[]>;

export type AuthorityRefusalCause = (typeof REFUSAL_CAUSES)[AuthorityRefusalCode][number];

export interface AuthorityRefusalFacts {
  code: AuthorityRefusalCode;
  axis: AuthorityAxis | null;
  cause: AuthorityRefusalCause | null;
}

export function isAuthorityRefusalCode(value: unknown): value is AuthorityRefusalCode {
  return AUTHORITY_REFUSAL_CODES.some((code) => code === value);
}

export function authorityRefusalFamily(code: AuthorityRefusalCode): string {
  return `FF_${code}`;
}

export function authorityRefusalFacts(
  code: unknown,
  axis: unknown,
  cause: unknown,
): AuthorityRefusalFacts | null {
  if (!isAuthorityRefusalCode(code)) return null;
  return {
    code,
    axis: AUTHORITY_AXES.find((candidate) => candidate === axis) ?? null,
    cause: REFUSAL_CAUSES[code].find((candidate) => candidate === cause) ?? null,
  };
}

export function mergeAuthorityRefusalFacts(
  existing: AuthorityRefusalFacts | undefined,
  incoming: AuthorityRefusalFacts,
): AuthorityRefusalFacts {
  return {
    code: incoming.code,
    axis:
      existing?.code === incoming.code && existing.axis === incoming.axis ? incoming.axis : null,
    cause:
      existing?.code === incoming.code && existing.cause === incoming.cause ? incoming.cause : null,
  };
}

// Platform has already crossed the recorder's sanitization boundary; null is explicitly unknown.
export function authorityRefusalSystemicKey(
  facts: AuthorityRefusalFacts,
  platform: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'rn-dev-agent/authority-refusal/1',
        facts.code,
        facts.axis,
        facts.cause,
        platform,
      ]),
    )
    .digest('hex');
}
