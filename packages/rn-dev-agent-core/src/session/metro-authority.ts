import { createHmac, createSecretKey, timingSafeEqual } from 'node:crypto';

export interface MetroAuthorityBinding {
  sessionId: string;
  metroInstanceId: string;
  worktreeKey: string;
  appId: string;
  platform: 'ios' | 'android';
  buildGeneration: number;
}

interface MetroAuthorityPayload extends MetroAuthorityBinding {
  authorityScope: 'initial-bundle';
  sourceFidelity: 'not-proven';
}

export interface MetroAuthorityMarker {
  version: 1;
  payload: MetroAuthorityPayload;
  signature: string;
}

interface MetroSerializer {
  customSerializer?: (...args: unknown[]) => unknown;
  getModulesRunBeforeMainModule?: (entryFile: string) => string[];
  [key: string]: unknown;
}

interface MetroConfig {
  serializer?: MetroSerializer;
  [key: string]: unknown;
}

function serializePayload(payload: MetroAuthorityPayload): string {
  return JSON.stringify(payload);
}

function signPayload(payload: MetroAuthorityPayload, signerCapability: string): string {
  const signingKey = createSecretKey(Buffer.from(signerCapability, 'base64url'));
  return createHmac('sha256', signingKey).update(serializePayload(payload)).digest('hex');
}

function mismatch(): Error {
  return new Error('BUNDLE_IDENTITY_MISMATCH: signed initial-bundle binding did not match');
}

export function buildSignedMetroMarker(
  binding: MetroAuthorityBinding,
  signerCapability: string,
): MetroAuthorityMarker {
  const payload: MetroAuthorityPayload = {
    ...binding,
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  };
  return { version: 1, payload, signature: signPayload(payload, signerCapability) };
}

export function verifyMetroAuthorityMarker(
  marker: MetroAuthorityMarker,
  signerCapability: string,
  expected: Partial<MetroAuthorityBinding> = {},
): MetroAuthorityPayload {
  if (marker.version !== 1 || !marker.payload || typeof marker.signature !== 'string') {
    throw mismatch();
  }
  const signature = Buffer.from(marker.signature, 'hex');
  const actual = Buffer.from(signPayload(marker.payload, signerCapability), 'hex');
  if (signature.length !== actual.length || !timingSafeEqual(signature, actual)) {
    throw mismatch();
  }
  for (const [key, value] of Object.entries(expected)) {
    if (marker.payload[key as keyof MetroAuthorityBinding] !== value) throw mismatch();
  }
  return marker.payload;
}

export function withMetroAuthorityModule<T extends MetroConfig>(
  config: T,
  markerModulePath: string,
): T {
  const serializer = config.serializer ?? {};
  const original = serializer.getModulesRunBeforeMainModule;
  return {
    ...config,
    serializer: {
      ...serializer,
      getModulesRunBeforeMainModule(entryFile: string): string[] {
        return [markerModulePath, ...(original?.(entryFile) ?? [])];
      },
    },
  };
}

export function createMetroAuthorityModule(marker: MetroAuthorityMarker | null): string {
  const value = marker
    ? { status: 'signed', marker }
    : {
        status: 'unavailable',
        authorityScope: 'initial-bundle',
        sourceFidelity: 'not-proven',
      };
  return `globalThis.__RN_DEV_AGENT_AUTHORITY__=${JSON.stringify(value)};\n`;
}
