const MULTIPART_MANIFEST_PART = /name="manifest"/;

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
