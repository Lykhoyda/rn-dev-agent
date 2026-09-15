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

export const MAX_AUTHORITY_ENVELOPE_BYTES = 16 * 1024;

function envelopeObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBoundedEnvelopeText(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    text.length <= MAX_AUTHORITY_ENVELOPE_BYTES &&
    Buffer.byteLength(text, 'utf8') <= MAX_AUTHORITY_ENVELOPE_BYTES
  );
}

function parseAuthorityEnvelope(text: unknown): Record<string, unknown> | null {
  if (!isBoundedEnvelopeText(text)) return null;
  try {
    return envelopeObject(JSON.parse(text));
  } catch {
    return null;
  }
}

export function authorityResultEnvelope(result: unknown): Record<string, unknown> | null {
  const envelope = envelopeObject(result);
  if (!envelope || Object.hasOwn(envelope, 'code')) return envelope;
  if (!Array.isArray(envelope.content)) return null;
  return parseAuthorityEnvelope(envelopeObject(envelope.content[0])?.text);
}

export function decodeAuthorityRefusalPayload(
  result: unknown,
  thrownError?: unknown,
): AuthorityRefusalFacts | null {
  const envelope = authorityResultEnvelope(result);
  if (envelope && Object.hasOwn(envelope, 'code')) {
    const meta = envelopeObject(envelope.meta);
    return authorityRefusalFacts(envelope.code, meta?.axis, meta?.cause);
  }
  if (typeof thrownError !== 'string') return null;
  const code = AUTHORITY_REFUSAL_CODES.find((candidate) => thrownError.startsWith(`${candidate}:`));
  return authorityRefusalFacts(code, null, null);
}

export function decodeLegacyAuthorityRefusal(symptom: unknown): AuthorityRefusalFacts | null {
  if (!isBoundedEnvelopeText(symptom)) return null;
  return decodeAuthorityRefusalPayload(parseAuthorityEnvelope(symptom), symptom);
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
  existing: AuthorityRefusalFacts | null | undefined,
  incoming: AuthorityRefusalFacts,
): AuthorityRefusalFacts {
  return {
    code: incoming.code,
    axis:
      existing != null && existing.code === incoming.code && existing.axis === incoming.axis
        ? incoming.axis
        : null,
    cause:
      existing != null && existing.code === incoming.code && existing.cause === incoming.cause
        ? incoming.cause
        : null,
  };
}

// Platform has already crossed the recorder's sanitization boundary; null is explicitly unknown.
export function authorityRefusalSystemicKey(
  facts: AuthorityRefusalFacts,
  platform: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify(['rn-dev-agent/authority-refusal/2', facts.code, facts.cause, platform]))
    .digest('hex');
}
