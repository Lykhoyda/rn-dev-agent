export interface ManagedManifestEndpoint {
  host: string;
  port: number;
}

export interface ManagedManifestLaunchAsset {
  bundleUrl: string;
  runtimeVersion: string | null;
}

const MULTIPART_MANIFEST_PART = /name="manifest"/;

function manifestError(message: string): Error {
  const error = new Error(`METRO_MANIFEST_ENDPOINT_MISMATCH: ${message}`) as Error & {
    code: string;
  };
  error.code = 'METRO_MANIFEST_ENDPOINT_MISMATCH';
  return error;
}

function extractMultipartManifest(body: string): string | null {
  const boundaryEnd = body.indexOf('\r\n');
  if (boundaryEnd <= 0) return null;
  const boundary = body.slice(0, boundaryEnd);
  if (!boundary.startsWith('--')) return null;
  for (const part of body.split(boundary)) {
    if (!MULTIPART_MANIFEST_PART.test(part)) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    return part
      .slice(headerEnd + 4)
      .replace(/\r\n--$/, '')
      .trim();
  }
  return null;
}

export function parseExpoManifestBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trimStart();
  const candidate = trimmed.startsWith('--') ? extractMultipartManifest(trimmed) : body;
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const manifest = parsed as Record<string, unknown>;
  const launchAsset = manifest.launchAsset;
  if (!launchAsset || typeof launchAsset !== 'object') return null;
  if (typeof (launchAsset as { url?: unknown }).url !== 'string') return null;
  return manifest;
}

// Manifest output is non-proof-bearing: the only accepted claim is the exact managed endpoint.
export function verifyManagedManifestLaunchAsset(
  body: string,
  endpoint: ManagedManifestEndpoint,
): ManagedManifestLaunchAsset | null {
  const manifest = parseExpoManifestBody(body);
  if (!manifest) return null;
  const url = (manifest.launchAsset as { url: string }).url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw manifestError('manifest launch asset is not an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw manifestError('manifest launch asset does not use an HTTP endpoint');
  }
  if (parsed.username || parsed.password) {
    throw manifestError('manifest launch asset carries embedded credentials');
  }
  if (parsed.hostname !== endpoint.host) {
    throw manifestError('manifest launch asset does not resolve to the managed host');
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (port !== endpoint.port) {
    throw manifestError('manifest launch asset does not resolve to the managed Metro port');
  }
  const runtimeVersion = manifest.runtimeVersion;
  return {
    bundleUrl: url,
    runtimeVersion: typeof runtimeVersion === 'string' ? runtimeVersion : null,
  };
}
